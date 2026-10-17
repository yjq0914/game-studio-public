import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentGodotWebDirectory,
  GodotRuntime,
  godotSourceRevision,
} from "../src/daemon/godot-runtime.js";
import {
  GODOT_TEST_BRIDGE,
  LEGACY_GODOT_TEST_BRIDGE,
  initializeGodotWorkspace,
} from "../src/daemon/godot-scaffold.js";
import {
  createGodotTools,
  guardGodotGameUse,
} from "../src/daemon/godot-tools.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { projectPiToolNames } from "../src/daemon/agent-tools.js";
import { appendSystemPromptForProject } from "../src/daemon/agent-prompts.js";
import { resolvePreviewWorkspace } from "../src/daemon/projects.js";
import type { ProjectState } from "../src/shared/contracts.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  options: {
    importError?: boolean;
    exportError?: boolean;
    noBridge?: boolean;
    wrongToken?: boolean;
    missingPck?: boolean;
  } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-godot-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "project");
  await mkdir(root);
  await initializeGodotWorkspace(root);
  const engine = path.join(directory, "engine.cjs");
  await writeFile(
    engine,
    `
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const options = ${JSON.stringify(options)};
const args = process.argv.slice(2);
if (args.includes('--import')) { if(options.importError) console.error('SCRIPT ERROR: fixture parse failure'); process.exit(0); }
if (args.includes('--export-debug')) {
  if(options.exportError) { console.error('ERROR: export fixture failed'); process.exit(1); }
  const output = path.dirname(args.at(-1));
  for (const file of ['index.html','index.js','index.wasm','index.pck']) {
    if(file === 'index.pck' && options.missingPck) continue;
    fs.writeFileSync(path.join(output,file), 'fixture');
  }
  process.exit(0);
}
if (options.noBridge) { setInterval(()=>{},1000); } else {
  const socket = net.connect(Number(process.env.GODOT_STUDIO_TEST_PORT),'127.0.0.1',()=>{
    socket.write(JSON.stringify({version:1,token:options.wrongToken?'wrong':process.env.GODOT_STUDIO_TEST_TOKEN})+'\\n');
  });
  let buffer='', received=0;
  socket.on('error',()=>{});
  socket.on('data',bytes=>{
    buffer+=bytes.toString();
    while(buffer.includes('\\n')) {
      const end=buffer.indexOf('\\n'), request=JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1);
      if(request.operation==='input')received++;
      const reply={id:request.id,state:{game:{phase:'menu',score:0,input_events:received}},accepted:true};
      if(request.operation==='capture') reply.png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzukAAAAASUVORK5CYII=';
      socket.write(JSON.stringify(reply)+'\\n');
    }
  });
  setInterval(()=>{},1000);
}
`,
  );
  const runtime = new GodotRuntime({
    executable: process.execPath,
    prefix: [engine],
    timeoutMs: 1500,
    exportTimeoutMs: 5000,
  });
  cleanup.push(() => runtime.close());
  const project = {
    id: "fixture",
    workspacePath: root,
    type: "godot-game",
  } as ProjectState;
  return { root, runtime, project };
}

describe("Godot Studio runtime", () => {
  it("migrates only the exact shipped Web bridge and preserves custom bridge changes", async () => {
    const { root, runtime, project } = await fixture();
    const bridgePath = path.join(root, "studio_test_bridge.gd");
    await writeFile(bridgePath, LEGACY_GODOT_TEST_BRIDGE);
    await runtime.start(project);
    expect(await readFile(bridgePath, "utf8")).toBe(GODOT_TEST_BRIDGE);
    await runtime.stop(project.id);
    await writeFile(bridgePath, GODOT_TEST_BRIDGE + "\n# user customization\n");
    await expect(runtime.start(project)).rejects.toThrow("bridge changed");
    expect(await readFile(bridgePath, "utf8")).toContain("user customization");
  });
  it("keeps a verified export current when the studio opens Canvas, but still hashes engine assets", async () => {
    const { root, runtime, project } = await fixture();
    await runtime.exportWeb(project);
    const revision = await godotSourceRevision(root);
    await mkdir(path.join(root, "canvas"));
    await writeFile(
      path.join(root, "canvas", "index.json"),
      JSON.stringify({ boards: [] }),
    );
    expect(await godotSourceRevision(root)).toBe(revision);
    await expect(currentGodotWebDirectory(root)).resolves.toBe(
      path.join(root, ".data/godot-studio/web"),
    );
    await mkdir(path.join(root, "art", "canvas"), { recursive: true });
    await writeFile(
      path.join(root, "art", "canvas", "sprite.png"),
      "engine asset",
    );
    expect(await godotSourceRevision(root)).not.toBe(revision);
    await expect(currentGodotWebDirectory(root)).rejects.toThrow("stale");
  });
  it("executes a real ordered input sequence and validates every step before applying any", async () => {
    const { runtime, project } = await fixture();
    await runtime.start(project);
    const result = await runtime.sequence(project, [
      { kind: "action", action: "flap", pressed: true },
      { kind: "wait", milliseconds: 20 },
      { kind: "action", action: "flap", pressed: false },
    ]);
    expect(result).toMatchObject({
      state: { game: { input_events: 2 } },
      acceptance: "needs_review",
    });
    await expect(
      runtime.sequence(project, [
        { kind: "action", action: "flap", pressed: true },
        { kind: "wait", milliseconds: 30000 },
      ]),
    ).rejects.toThrow("5000ms");
    await expect(
      runtime.sequence(project, [
        { kind: "action", action: "flap", pressed: true },
        { kind: "action", action: "flap", pressed: false, milliseconds: 350 },
      ]),
    ).rejects.toThrow("milliseconds only applies to wait");
    expect(await runtime.operate(project, "inspect")).toMatchObject({
      state: { game: { input_events: 2 } },
    });
  });
  it("cancels a waiting sequence and cleans up its native run", async () => {
    const { runtime, project } = await fixture();
    await runtime.start(project);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    try {
      await expect(
        runtime.sequence(
          project,
          [{ kind: "wait", milliseconds: 5000 }],
          controller.signal,
        ),
      ).rejects.toThrow("cancelled");
    } finally {
      clearTimeout(timer);
    }
    await expect(runtime.operate(project, "inspect")).rejects.toThrow(
      "Start Godot",
    );
  });
  it("initializes infrastructure without prewritten gameplay and preserves existing scenes", async () => {
    const { root } = await fixture();
    expect(
      await readFile(path.join(root, "studio_test_bridge.gd"), "utf8"),
    ).toBe(GODOT_TEST_BRIDGE);
    await writeFile(path.join(root, "main.tscn"), "user scene");
    await initializeGodotWorkspace(root);
    expect(await readFile(path.join(root, "main.tscn"), "utf8")).toBe(
      "user scene",
    );
    expect(await readdir(root)).not.toContain("player.gd");
  });
  it("binds native observations and captures to a source revision and rejects changed source", async () => {
    const { root, runtime, project } = await fixture();
    const started = await runtime.start(project);
    expect(started).toMatchObject({
      acceptance: "needs_review",
      state: { game: { phase: "menu" } },
    });
    const capture = await runtime.operate(project, "capture");
    expect(capture.runId).toBe(started.runId);
    expect(capture.revision).toBe(started.revision);
    expect(
      (await readFile(path.join(root, String(capture.capturePath))))
        .subarray(0, 8)
        .toString("hex"),
    ).toBe("89504e470d0a1a0a");
    await writeFile(path.join(root, "player.gd"), "changed source");
    await expect(runtime.operate(project, "inspect")).rejects.toThrow(
      "source changed",
    );
    await expect(runtime.operate(project, "inspect")).rejects.toThrow(
      "Start Godot",
    );
  });
  it("replaces the prior native run and cleans up on close", async () => {
    const { runtime, project } = await fixture();
    const first = await runtime.start(project);
    const second = await runtime.start(project);
    expect(second.runId).not.toBe(first.runId);
    await runtime.close();
    await expect(runtime.start(project)).rejects.toThrow("closing");
  });
  it("rejects script errors even when Godot returns zero", async () => {
    const { runtime, project } = await fixture({ importError: true });
    await expect(runtime.start(project)).rejects.toThrow(
      "fixture parse failure",
    );
  });
  it.each([{ noBridge: true }, { wrongToken: true }])(
    "bounds missing or unauthenticated bridges: %o",
    async (options) => {
      const { runtime, project } = await fixture(options);
      await expect(runtime.start(project)).rejects.toThrow("timed out");
      await expect(runtime.operate(project, "inspect")).rejects.toThrow(
        "Start Godot",
      );
    },
  );
  it("cancels startup and terminates the owned process", async () => {
    const { runtime, project } = await fixture({ noBridge: true });
    const controller = new AbortController();
    const run = runtime.start(project, controller.signal);
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      await expect(run).rejects.toThrow(/cancelled|abort/i);
    } finally {
      clearTimeout(timer);
    }
    await expect(runtime.operate(project, "inspect")).rejects.toThrow(
      "Start Godot",
    );
  });
  it("preserves export presets and only serves a complete current export", async () => {
    const { root, runtime, project } = await fixture();
    const presets = "user presets\n";
    await writeFile(path.join(root, "export_presets.cfg"), presets);
    const source = await godotSourceRevision(root);
    const result = await runtime.exportWeb(project);
    expect(result.revision).toBe(source);
    expect(await readFile(path.join(root, "export_presets.cfg"), "utf8")).toBe(
      presets,
    );
    expect(await currentGodotWebDirectory(root)).toBe(
      path.join(root, ".data/godot-studio/web"),
    );
    expect(await resolvePreviewWorkspace(project)).toMatchObject({
      mode: "static",
      runnable: true,
    });
    await writeFile(path.join(root, "main.tscn"), "modified");
    await expect(currentGodotWebDirectory(root)).rejects.toThrow("stale");
    expect(await resolvePreviewWorkspace(project)).toMatchObject({
      runnable: false,
    });
  });
  it.each([{ exportError: true }, { missingPck: true }])(
    "preserves source and records failed export: %o",
    async (options) => {
      const { root, runtime, project } = await fixture(options);
      const before = await godotSourceRevision(root);
      await expect(runtime.exportWeb(project)).rejects.toThrow();
      expect(await godotSourceRevision(root)).toBe(before);
      await expect(currentGodotWebDirectory(root)).rejects.toThrow();
      expect(
        JSON.parse(
          await readFile(
            path.join(root, ".data/godot-studio/export-failure.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ acceptance: "failed" });
    },
  );
  it("rejects evidence directory links escaping the workspace", async () => {
    const { root, runtime, project } = await fixture();
    const outside = path.join(path.dirname(root), "outside");
    await mkdir(outside);
    await symlink(
      outside,
      path.join(root, ".data"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(runtime.start(project)).rejects.toThrow("symbolic links");
  });
  it("registers Godot tools only for Godot and excludes them in planning", async () => {
    const { runtime, project } = await fixture();
    const tools = createGodotTools(project, runtime);
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(["godot_runtime", "godot_export_web"]);
    expect(projectPiToolNames("planning", [], names)).not.toContain(
      "godot_runtime",
    );
    expect(projectPiToolNames("planning", [], names)).not.toContain(
      "godot_export_web",
    );
    expect(projectPiToolNames("normal", [], names)).toContain("godot_runtime");
    expect(createGodotTools({ ...project, type: "web-game" }, runtime)).toEqual(
      [],
    );
    expect(appendSystemPromptForProject(project).join("\n")).toContain(
      "Godot 2D",
    );
  });
  it("rejects an old browser session even after a changed source has been re-exported", async () => {
    const { root, runtime, project } = await fixture();
    await runtime.exportWeb(project);
    let calls = 0;
    const fake = defineTool({
      name: "game_use",
      label: "fixture",
      description: "fixture",
      parameters: Type.Object({
        operation: Type.String(),
        sessionId: Type.Optional(Type.String()),
      }),
      execute: async () => {
        calls++;
        return {
          content: [{ type: "text" as const, text: "fixture" }],
          details: { playtest: { sessionId: "browser-1" } },
        };
      },
    });
    const guarded = guardGodotGameUse(project, fake);
    await expect(
      guarded.execute(
        "wrong-root",
        { operation: "open", path: ".data/godot-studio/web/" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Preview root");
    expect(calls).toBe(0);
    await guarded.execute(
      "open",
      { operation: "open" },
      undefined,
      undefined,
      {} as never,
    );
    await writeFile(path.join(root, "main.tscn"), "new source");
    await runtime.exportWeb(project);
    await expect(
      guarded.execute(
        "inspect",
        { operation: "inspect", sessionId: "browser-1" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("browser session is stale");
    expect(calls).toBe(1);
    await guarded.execute(
      "close",
      { operation: "close", sessionId: "browser-1" },
      undefined,
      undefined,
      {} as never,
    );
    expect(calls).toBe(2);
  });
  it("reports an unavailable engine executable without a native run", async () => {
    const { root, project } = await fixture();
    const missing = new GodotRuntime({
      executable: path.join(root, "missing-engine.exe"),
    });
    cleanup.push(() => missing.close());
    await expect(missing.start(project)).rejects.toThrow();
    await expect(missing.operate(project, "inspect")).rejects.toThrow(
      "Start Godot",
    );
  });
});
