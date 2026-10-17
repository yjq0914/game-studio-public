import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import { projectProcessEnvironment } from "./project-process.js";
import {
  registerProjectProcess,
  terminateProjectProcess,
} from "./process-lifecycle.js";
import {
  GODOT_TEST_BRIDGE,
  LEGACY_GODOT_TEST_BRIDGE,
  GODOT_WEB_PRESET,
  initializeGodotWorkspace,
} from "./godot-scaffold.js";

type Project = Pick<ProjectState, "id" | "workspacePath">;
type Reply = Record<string, unknown>;
type Run = {
  id: string;
  revision: string;
  root: string;
  directory: string;
  child?: ChildProcess;
  server: Server;
  socket?: Socket;
  sockets: Set<Socket>;
  logs: string;
  pending: Map<
    string,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >;
  closed: boolean;
  command: string[];
};
export const GODOT_WEB_DIRECTORY = ".data/godot-studio/web";
export interface GodotInputStep {
  kind: "action" | "click" | "wait";
  action?: string;
  pressed?: boolean;
  x?: number;
  y?: number;
  milliseconds?: number;
}
const ignored = new Set([
  ".git",
  ".godot",
  ".data",
  ".runtime",
  "node_modules",
]);

async function dataDirectory(root: string): Promise<string> {
  let directory = root;
  for (const segment of [".data", "godot-studio"]) {
    directory = path.join(directory, segment);
    await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (
      (await lstat(directory)).isSymbolicLink() ||
      (await realpath(directory)) !== directory
    )
      throw new Error(
        "Godot evidence directories must not contain symbolic links",
      );
  }
  return directory;
}

export async function godotSourceRevision(workspace: string): Promise<string> {
  const root = await realpath(workspace);
  const hash = createHash("sha256");
  async function visit(directory: string) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (
        ignored.has(entry.name) ||
        (directory === root && entry.name === "canvas")
      )
        continue;
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Godot source must not contain symbolic links");
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) {
        const bytes = await readFile(filename);
        hash
          .update(path.relative(root, filename).split(path.sep).join("/"))
          .update("\0")
          .update(bytes)
          .update("\0");
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
}

export async function currentGodotWebDirectory(
  workspace: string,
): Promise<string> {
  const root = await realpath(workspace);
  for (const relative of [".data", ".data/godot-studio"]) {
    const directory = path.join(root, relative);
    if ((await realpath(directory)) !== directory)
      throw new Error(
        "Godot export directories must not contain symbolic links",
      );
  }
  const directory = path.join(root, GODOT_WEB_DIRECTORY);
  const resolved = await realpath(directory);
  if (resolved !== directory)
    throw new Error("Godot export directory must not be a symbolic link");
  const manifest = JSON.parse(
    await readFile(path.join(root, ".data/godot-studio/export.json"), "utf8"),
  );
  if (manifest.revision !== (await godotSourceRevision(root)))
    throw new Error(
      "Godot Web export is stale; export the current source again",
    );
  for (const file of ["index.html", "index.js", "index.wasm", "index.pck"]) {
    if (!(await lstat(path.join(directory, file))).isFile())
      throw new Error(`Godot export is missing ${file}`);
  }
  return directory;
}

export class GodotRuntime {
  readonly #runs = new Map<string, Run>();
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #commands = new Set<ChildProcess>();
  #closing = false;
  constructor(
    private readonly options: {
      executable?: string;
      prefix?: string[];
      timeoutMs?: number;
      exportTimeoutMs?: number;
      webTemplate?: string;
    } = {},
  ) {}
  get executable(): string {
    const executable = this.options.executable ?? process.env.GODOT_PATH;
    if (!executable)
      throw new Error("Set GODOT_PATH to the Godot 4.7.2 console executable");
    return executable;
  }
  async #root(project: Project): Promise<string> {
    const stat = await lstat(project.workspacePath);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Godot workspace must be a real directory");
    return realpath(project.workspacePath);
  }
  async #serialized<T>(project: Project, work: () => Promise<T>): Promise<T> {
    if (this.#closing) throw new Error("Godot service is closing");
    const previous = this.#queues.get(project.id) ?? Promise.resolve();
    const queued = previous
      .catch(() => {})
      .then(() => {
        if (this.#closing) throw new Error("Godot service is closing");
        return work();
      });
    this.#queues.set(project.id, queued);
    try {
      return await queued;
    } finally {
      if (this.#queues.get(project.id) === queued)
        this.#queues.delete(project.id);
    }
  }
  async initialize(project: Project, signal?: AbortSignal): Promise<Reply> {
    return this.#serialized(project, async () => {
      signal?.throwIfAborted();
      if (this.#runs.has(project.id))
        throw new Error("Stop the native run before initializing its source");
      await initializeGodotWorkspace(await this.#root(project));
      return {
        initialized: true,
        files: ["project.godot", "main.tscn", "studio_test_bridge.gd"],
        instructions:
          "Infrastructure is ready, no gameplay is included. Do not initialize again or repeatedly list this empty project. Read project.godot and the bridge once, then write main.gd and update main.tscn to implement the requested game. Expose studio_snapshot() with phase, score/progression, relevant entities, resources and real gameplay event counters for input-based tests of this genre. Register all controls as InputMap actions and handle InputEventAction as well as keyboard/pointer events; native input sends real mapped actions. Next start and verify native gameplay, export, and verify Web gameplay.",
      };
    });
  }
  async #command(
    args: string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ command: string[]; logs: string }> {
    signal?.throwIfAborted();
    const executable = this.executable;
    const fullArgs = [...(this.options.prefix ?? []), ...args];
    const child = spawn(executable, fullArgs, {
      cwd,
      env: projectProcessEnvironment(),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    registerProjectProcess(child);
    this.#commands.add(child);
    let logs = "";
    const append = (value: Buffer) => {
      logs = (logs + value.toString()).slice(-100_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let reason: Error | undefined;
    const terminate = () => {
      void terminateProjectProcess(child).catch(() => child.kill());
    };
    const abort = () => {
      reason = new Error("Godot command cancelled");
      terminate();
    };
    const timer = setTimeout(() => {
      reason = new Error("Godot command timed out");
      terminate();
    }, this.options.exportTimeoutMs ?? 120_000);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (reason) throw reason;
      if (code !== 0 || /SCRIPT ERROR:|Parse Error:|ERROR:/i.test(logs))
        throw new Error(`Godot command failed (${code}): ${logs.slice(-6000)}`);
      return { command: [executable, ...fullArgs], logs };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.#commands.delete(child);
    }
  }
  async start(project: Project, signal?: AbortSignal): Promise<Reply> {
    return this.#serialized(project, async () => {
      await this.stop(project.id);
      const root = await this.#root(project);
      await readFile(path.join(root, "project.godot"));
      await this.#prepareBridge(root);
      const imported = await this.#command(
        ["--headless", "--path", root, "--editor", "--import"],
        root,
        signal,
      );
      const revision = await godotSourceRevision(root);
      const id = randomUUID();
      const base = await dataDirectory(root);
      const runs = path.join(base, "runs");
      await mkdir(runs, { recursive: true });
      if ((await realpath(runs)) !== runs)
        throw new Error("Godot run directory must not be a symbolic link");
      const directory = path.join(runs, id);
      await mkdir(directory, { recursive: true });
      const token = randomBytes(32).toString("hex");
      const server = createServer();
      const run: Run = {
        id,
        revision,
        root,
        directory,
        server,
        logs: imported.logs,
        sockets: new Set(),
        pending: new Map(),
        closed: false,
        command: [],
      };
      this.#runs.set(project.id, run);
      let readyResolve!: () => void, readyReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      // Attach a handler before spawn so an early exit never becomes an unhandled rejection.
      void ready.catch(() => {});
      server.on("connection", (socket) => {
        run.sockets.add(socket);
        let buffer = "",
          authenticated = false;
        socket.setTimeout(this.options.timeoutMs ?? 15_000, () => {
          if (!authenticated) socket.destroy();
        });
        socket.on("error", () => {});
        socket.on("close", () => {
          run.sockets.delete(socket);
          if (socket === run.socket && !run.closed) {
            for (const pending of run.pending.values())
              pending.reject(new Error("Godot bridge disconnected"));
            run.pending.clear();
          }
        });
        socket.on("data", (bytes) => {
          buffer += bytes.toString();
          if (Buffer.byteLength(buffer) > 12_000_000) {
            socket.destroy();
            return;
          }
          while (buffer.includes("\n")) {
            const end = buffer.indexOf("\n"),
              line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            try {
              const message = JSON.parse(line) as Reply;
              if (!authenticated) {
                const provided = Buffer.from(
                  typeof message.token === "string" ? message.token : "",
                );
                if (
                  run.socket ||
                  message.version !== 1 ||
                  provided.length !== token.length ||
                  !timingSafeEqual(provided, Buffer.from(token))
                ) {
                  socket.destroy();
                  return;
                }
                authenticated = true;
                run.socket = socket;
                socket.setTimeout(0);
                readyResolve();
              } else {
                const pending = run.pending.get(String(message.id));
                if (pending) {
                  run.pending.delete(String(message.id));
                  message.error
                    ? pending.reject(new Error(String(message.error)))
                    : pending.resolve(message);
                }
              }
            } catch {
              socket.destroy();
            }
          }
        });
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        signal?.throwIfAborted();
        const port = (server.address() as { port: number }).port;
        const args = [...(this.options.prefix ?? []), "--path", root];
        run.command = [this.executable, ...args];
        const child = spawn(this.executable, args, {
          cwd: root,
          detached: process.platform !== "win32",
          windowsHide: true,
          env: {
            ...projectProcessEnvironment(),
            GODOT_STUDIO_TEST_PORT: String(port),
            GODOT_STUDIO_TEST_TOKEN: token,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        registerProjectProcess(child);
        run.child = child;
        const append = (value: Buffer) => {
          run.logs = (run.logs + value.toString()).slice(-100_000);
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        child.on("error", (error) => readyReject(error));
        child.on("exit", () => {
          readyReject(
            new Error(
              `Godot exited before bridge readiness: ${run.logs.slice(-4000)}`,
            ),
          );
          for (const pending of run.pending.values())
            pending.reject(new Error("Godot process exited"));
          run.pending.clear();
        });
        await this.#bounded(ready, signal);
        await this.#assertCurrent(run);
        const state = await this.#request(
          run,
          { operation: "inspect" },
          signal,
        );
        await this.#record(run, "start", state);
        return this.#result(run, state);
      } catch (error) {
        try {
          await this.#record(run, "failed", { error: String(error) });
        } finally {
          await this.stop(project.id);
        }
        throw error;
      }
    });
  }
  async #bounded<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Godot bridge timed out")),
            this.options.timeoutMs ?? 15_000,
          );
          abort = () => reject(new Error("Godot operation cancelled"));
          signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  async #assertCurrent(run: Run) {
    if (
      run.closed ||
      !run.child ||
      run.child.exitCode !== null ||
      !run.socket ||
      run.socket.destroyed
    )
      throw new Error("Godot native run is no longer active");
    if ((await godotSourceRevision(run.root)) !== run.revision)
      throw new Error(
        "Godot source changed; restart before collecting new evidence",
      );
    if (/SCRIPT ERROR:|Parse Error:|ERROR:/i.test(run.logs))
      throw new Error(`Godot runtime error: ${run.logs.slice(-5000)}`);
  }
  async #request(
    run: Run,
    payload: Reply,
    signal?: AbortSignal,
  ): Promise<Reply> {
    if (!run.socket || run.socket.destroyed)
      throw new Error("Godot bridge is not connected");
    const id = randomUUID();
    try {
      return await this.#bounded(
        new Promise<Reply>((resolve, reject) => {
          run.pending.set(id, { resolve, reject });
          run.socket!.write(
            JSON.stringify({ ...payload, id }) + "\n",
            (error) => {
              if (error) reject(error);
            },
          );
        }),
        signal,
      );
    } finally {
      run.pending.delete(id);
    }
  }
  async operate(
    project: Project,
    operation: "inspect" | "input" | "capture" | "reset",
    input: Reply = {},
    signal?: AbortSignal,
  ): Promise<Reply> {
    return this.#serialized(project, async () => {
      const run = this.#runs.get(project.id);
      if (!run) throw new Error("Start Godot before using runtime operations");
      try {
        await this.#assertCurrent(run);
        const reply = await this.#request(run, { ...input, operation }, signal);
        await this.#assertCurrent(run);
        if (operation === "capture") {
          const image = Buffer.from(String(reply.png ?? ""), "base64");
          if (
            image.length < 8 ||
            image.length > 8_000_000 ||
            image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
          )
            throw new Error("Godot returned an invalid or oversized PNG");
          const filename = `capture-${randomUUID()}.png`;
          await writeFile(path.join(run.directory, filename), image);
          delete reply.png;
          reply.capturePath = path
            .relative(run.root, path.join(run.directory, filename))
            .split(path.sep)
            .join("/");
          await this.#record(run, operation, reply);
          return {
            ...this.#result(run, reply),
            imageBase64: image.toString("base64"),
          };
        }
        await this.#record(run, operation, reply);
        return this.#result(run, reply);
      } catch (error) {
        try {
          await this.#record(run, "failed", { error: String(error) });
        } finally {
          await this.stop(project.id);
        }
        throw error;
      }
    });
  }
  #result(run: Run, reply: Reply): Reply {
    return {
      runId: run.id,
      revision: run.revision,
      ...reply,
      logs: run.logs.slice(-6000),
      evidenceDirectory: path
        .relative(run.root, run.directory)
        .split(path.sep)
        .join("/"),
      acceptance: "needs_review",
    };
  }
  async #record(run: Run, operation: string, result: Reply) {
    await writeFile(
      path.join(run.directory, `${Date.now()}-${randomUUID()}.json`),
      JSON.stringify(
        {
          runId: run.id,
          revision: run.revision,
          operation,
          result,
          command: run.command,
          logs: run.logs,
          acceptance: "needs_review",
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }
  async sequence(
    project: Project,
    steps: GodotInputStep[],
    signal?: AbortSignal,
  ): Promise<Reply> {
    if (!steps.length || steps.length > 80)
      throw new Error("Input sequence requires 1 to 80 steps");
    let duration = 0;
    for (const step of steps) {
      if (
        step.kind !== "wait" &&
        step.milliseconds !== undefined &&
        step.milliseconds !== 0
      )
        throw new Error(
          "milliseconds only applies to wait steps; hold input with press, wait, release",
        );
      if (step.kind === "wait") {
        if (
          !Number.isInteger(step.milliseconds) ||
          Number(step.milliseconds) < 0 ||
          Number(step.milliseconds) > 5000
        )
          throw new Error("Sequence waits must be between 0 and 5000ms");
        duration += Number(step.milliseconds);
      } else if (step.kind === "action") {
        if (!step.action || typeof step.pressed !== "boolean")
          throw new Error("Sequence action requires action and pressed");
      } else if (step.kind === "click") {
        if (
          typeof step.pressed !== "boolean" ||
          !Number.isFinite(step.x) ||
          !Number.isFinite(step.y) ||
          Number(step.x) < 0 ||
          Number(step.y) < 0 ||
          Number(step.x) > 8192 ||
          Number(step.y) > 8192
        )
          throw new Error(
            "Sequence click requires bounded coordinates and pressed",
          );
      } else throw new Error("Unsupported sequence step");
    }
    if (duration > 25000)
      throw new Error("Input sequence may wait at most 25000ms");
    return this.#serialized(project, async () => {
      const run = this.#runs.get(project.id);
      if (!run) throw new Error("Start Godot before using runtime operations");
      try {
        await this.#assertCurrent(run);
        for (const step of steps) {
          signal?.throwIfAborted();
          if (step.kind === "wait") {
            await new Promise<void>((resolve, reject) => {
              const finish = (error?: Error) => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                error ? reject(error) : resolve();
              };
              const abort = () => finish(new Error("Godot sequence cancelled"));
              const timer = setTimeout(() => finish(), step.milliseconds);
              signal?.addEventListener("abort", abort, { once: true });
            });
          } else
            await this.#request(run, { ...step, operation: "input" }, signal);
          await this.#assertCurrent(run);
        }
        const result = await this.#request(
          run,
          { operation: "inspect" },
          signal,
        );
        await this.#record(run, "sequence", { steps, ...result });
        return this.#result(run, result);
      } catch (error) {
        try {
          await this.#record(run, "failed", { error: String(error) });
        } finally {
          await this.stop(project.id);
        }
        throw error;
      }
    });
  }

  async stop(projectId: string): Promise<Reply> {
    const run = this.#runs.get(projectId);
    if (!run) return { stopped: true };
    this.#runs.delete(projectId);
    run.closed = true;
    for (const pending of run.pending.values())
      pending.reject(new Error("Godot native run stopped"));
    run.pending.clear();
    for (const socket of run.sockets) socket.destroy();
    const serverClosed = new Promise<void>((resolve) => {
      if (!run.server.listening) resolve();
      else run.server.close(() => resolve());
    });
    const child = run.child;
    if (child?.pid) await terminateProjectProcess(child);
    await serverClosed;
    await this.#record(run, "stop", { stopped: true });
    return { stopped: true, runId: run.id };
  }
  async exportWeb(project: Project, signal?: AbortSignal): Promise<Reply> {
    return this.#serialized(project, async () => {
      await this.stop(project.id);
      const root = await this.#root(project);
      await this.#prepareBridge(root);
      const imported = await this.#command(
        ["--headless", "--path", root, "--editor", "--import"],
        root,
        signal,
      );
      const revision = await godotSourceRevision(root);
      const base = await dataDirectory(root);
      const staging = path.join(base, `export-${randomUUID()}`);
      await mkdir(staging);
      const preset = path.join(root, "export_presets.cfg");
      const backup = await readFile(preset).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        },
      );
      const template =
        this.options.webTemplate ?? process.env.GODOT_WEB_TEMPLATE;
      const settings =
        GODOT_WEB_PRESET +
        (template
          ? `custom_template/debug=${JSON.stringify(template.split(path.sep).join("/"))}\ncustom_template/release=${JSON.stringify(template.split(path.sep).join("/"))}\n`
          : "");
      let presetInstalled = false;
      const restorePreset = async () => {
        if (!presetInstalled) return;
        const current = await readFile(preset).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          },
        );
        if (current?.equals(Buffer.from(settings))) {
          if (backup) await writeFile(preset, backup);
          else await rm(preset, { force: true });
          presetInstalled = false;
        } else {
          if (backup)
            await writeFile(
              path.join(base, `presets-backup-${randomUUID()}.cfg`),
              backup,
            );
          presetInstalled = false;
          throw new Error(
            "Export presets changed concurrently; preserving the user's new file",
          );
        }
      };
      try {
        if (template && !(await lstat(template)).isFile())
          throw new Error("Godot Web template is missing");
        await writeFile(preset, settings);
        presetInstalled = true;
        const exported = await this.#command(
          [
            "--headless",
            "--path",
            root,
            "--export-debug",
            "Studio Web",
            path.join(staging, "index.html"),
          ],
          root,
          signal,
        );
        for (const filename of [
          "index.html",
          "index.js",
          "index.wasm",
          "index.pck",
        ]) {
          const stat = await lstat(path.join(staging, filename));
          if (!stat.isFile() || stat.size === 0)
            throw new Error(`Godot export is incomplete: ${filename}`);
        }
        // Restore the user's preset before comparing the source digest.
        await restorePreset();
        if ((await godotSourceRevision(root)) !== revision)
          throw new Error(
            "Godot source changed during export; retry with stable source",
          );
        const target = path.join(root, GODOT_WEB_DIRECTORY);
        const existing = await lstat(target).catch(() => undefined);
        if (existing?.isSymbolicLink())
          throw new Error("Godot export target must not be a symbolic link");
        await rm(target, { recursive: true, force: true });
        await rename(staging, target);
        const manifest = {
          revision,
          directory: GODOT_WEB_DIRECTORY,
          command: exported.command,
          logs: imported.logs + exported.logs,
          acceptance: "needs_review",
          exportedAt: new Date().toISOString(),
        };
        await writeFile(
          path.join(base, "export.json"),
          JSON.stringify(manifest, null, 2),
        );
        return manifest;
      } catch (error) {
        await writeFile(
          path.join(base, "export-failure.json"),
          JSON.stringify(
            { revision, error: String(error), acceptance: "failed" },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        try {
          await restorePreset();
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      }
    });
  }
  async #prepareBridge(root: string): Promise<void> {
    const bridge = await readFile(
      path.join(root, "studio_test_bridge.gd"),
      "utf8",
    );
    if (bridge === LEGACY_GODOT_TEST_BRIDGE)
      await initializeGodotWorkspace(root);
    else if (bridge !== GODOT_TEST_BRIDGE)
      throw new Error(
        "Godot test bridge changed; restore trusted infrastructure before testing",
      );
  }

  async close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled(
      [...this.#commands].map((child) => terminateProjectProcess(child)),
    );
    await Promise.allSettled([...this.#runs.keys()].map((id) => this.stop(id)));
    await Promise.allSettled([...this.#queues.values()]);
  }
}
