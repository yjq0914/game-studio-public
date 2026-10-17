import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import { godotSourceRevision } from "./godot-runtime.js";

export type GameSkillTarget = "native_desktop" | "web_desktop";
export interface GameSkillScope { engine: "godot"; versions: string[]; targets: GameSkillTarget[]; genre: string }
export interface GameSkillQuery { engine: "godot"; version: string; targets: GameSkillTarget[]; genre: string; query: string; kind?: "debug" | "template" | "any" }
export interface DebugProcedure { symptom: string; rootCause: string; procedure: string[]; counterexamples: string[] }
export interface TemplateParameter { name: string; type: "string" | "number" | "boolean"; default: string | number | boolean; minimum?: number; maximum?: number }
export interface TemplateContent { description: string; infrastructureOnly: boolean; parameters: TemplateParameter[]; files: Record<string, string> }
export interface GameSkillDefinition { id: string; title: string; kind: "debug" | "template"; scope: GameSkillScope; tags: string[]; debug?: DebugProcedure; template?: TemplateContent }
export interface GameSkillEvidence { path: string; sha256: string; bytes: number }
export interface GameSkillDocument extends GameSkillDefinition { originProjectId: string; sourceRevision: string; evidence: GameSkillEvidence[] }
export interface GameSkillReview { reviewer: string; note: string; checks: { reproduction: boolean; regression: boolean; counterexample: boolean }; at: string }
export interface GameSkillHeader { id: string; revision: string; title: string; kind: "debug" | "template"; scope: GameSkillScope; tags: string[]; state: "candidate" | "validated" | "active" | "deprecated" | "rejected"; originProjectId: string; createdAt: string; review?: GameSkillReview; activatedAt?: string }
type Project = Pick<ProjectState, "id" | "workspacePath" | "type">;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVISION = /^[a-f0-9]{64}$/;
const targets = new Set(["native_desktop", "web_desktop"]);
function canonical(value: unknown): string {
  const order = (item: unknown): unknown => Array.isArray(item) ? item.map(order) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, order(v)])) : item;
  return JSON.stringify(order(value));
}
function safePath(value: string): string {
  if (!value || value.length > 300 || value.includes("\\") || value.includes(":")) throw new Error("Use a relative forward-slash path");
  if (value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Path escapes the permitted directory");
  return value;
}
function templatePath(value: string): string {
  safePath(value);
  if (value.split("/").some(part => [".git", ".godot", ".data", ".runtime", "node_modules"].includes(part)) || /(^|\/)(\.env[^/]*|auth\.json|models(?:-store)?\.json|settings\.json)$/i.test(value)) throw new Error("Templates cannot include credentials, caches or execution evidence");
  if (!/\.(gd|tscn|tres|godot|json|md|txt|svg)$/.test(value) && value !== ".gitignore") throw new Error("This template version accepts declared text source files only");
  return value;
}
async function checkedRead(root: string, relative: string, maxBytes: number): Promise<Buffer> {
  safePath(relative);
  const base = await realpath(root);
  let current = base;
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Symbolic links are not accepted in skills or evidence");
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(base + path.sep)) throw new Error("File escapes the permitted directory");
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error("File is missing, not regular, or exceeds its size limit");
  return readFile(resolved);
}
function validate(definition: GameSkillDefinition): void {
  if (!ID.test(definition.id) || definition.id.length > 80 || !definition.title?.trim() || definition.title.length > 160) throw new Error("Invalid skill identity");
  const scope = definition.scope;
  if (scope.engine !== "godot" || !scope.versions.length || scope.versions.some(version => !/^\d+\.\d+\.\d+$/.test(version)) || !scope.targets.length || scope.targets.some(target => !targets.has(target)) || !scope.genre?.trim()) throw new Error("Explicit engine versions, targets and genre are required");
  if (definition.tags.length > 20 || definition.tags.some(tag => !tag || tag.length > 100)) throw new Error("Invalid skill tags");
  if (definition.kind === "debug") {
    const debug = definition.debug;
    if (!debug || definition.template || !debug.symptom?.trim() || !debug.rootCause?.trim() || !debug.procedure.length || !debug.counterexamples.length) throw new Error("Debug skills require a root cause, procedure and counterexamples");
  } else if (definition.kind === "template") {
    const template = definition.template;
    if (!template || definition.debug || !template.description?.trim() || !Object.keys(template.files).length || Object.keys(template.files).length > 40) throw new Error("Template requires an explicit source snapshot");
    const names = new Set<string>();
    for (const parameter of template.parameters) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(parameter.name) || names.has(parameter.name)) throw new Error("Invalid or duplicate template parameter");
      names.add(parameter.name); parameterValue(parameter, parameter.default);
    }
    for (const [file, text] of Object.entries(template.files)) {
      templatePath(file);
      if (Buffer.byteLength(text) > 250_000 || text.includes("\0")) throw new Error("Template source is too large or binary");
      for (const match of text.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)) if (!names.has(match[1]!)) throw new Error("Template refers to an undeclared parameter");
    }
  } else throw new Error("Unknown game skill kind");
  if (Buffer.byteLength(canonical(definition)) > 2_000_000) throw new Error("Skill exceeds the content size limit");
}
function parameterValue(parameter: TemplateParameter, value: unknown): string {
  if (typeof value !== parameter.type || (typeof value === "string" && value.length > 1000) || (typeof value === "number" && (!Number.isFinite(value) || (parameter.minimum !== undefined && value < parameter.minimum) || (parameter.maximum !== undefined && value > parameter.maximum)))) throw new Error(`Invalid template parameter ${parameter.name}`);
  return JSON.stringify(value);
}
function compatible(scope: GameSkillScope, query: GameSkillQuery): boolean {
  return scope.engine === query.engine && scope.versions.includes(query.version) && query.targets.length > 0 && query.targets.every(target => scope.targets.includes(target)) && (scope.genre === "*" || scope.genre === query.genre);
}

/** Semantic experience storage; Pi remains responsible for loading and running Skills. */
export class GameSkillLibrary {
  readonly directory: string;
  #queue: Promise<unknown> = Promise.resolve();
  #pins = new Map<string, Set<string>>();
  #uses = new Map<string, Array<{ id: string; revision: string; operation: "read" | "apply" }>>();
  constructor(dataDirectory: string) { this.directory = path.join(dataDirectory, "game-skills"); }
  async #serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.catch(() => {}).then(operation); this.#queue = next.catch(() => {}); return next;
  }
  async list(): Promise<GameSkillHeader[]> {
    let text: string;
    try { text = await readFile(path.join(this.directory, "index.json"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const value = JSON.parse(text) as { version: number; entries: GameSkillHeader[] };
    if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 5000 || value.entries.some(entry => !ID.test(entry.id) || !REVISION.test(entry.revision) || !["candidate", "validated", "active", "deprecated", "rejected"].includes(entry.state))) throw new Error("Invalid game skill library index");
    return value.entries;
  }
  async #save(entries: GameSkillHeader[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `index-${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify({ version: 1, entries }, null, 2)); await rename(temporary, path.join(this.directory, "index.json")); }
    finally { await rm(temporary, { force: true }); }
  }
  async propose(project: Project, definition: GameSkillDefinition, evidencePaths: string[]): Promise<GameSkillHeader> {
    validate(definition);
    if (project.type !== "godot-game" || evidencePaths.length > 20) throw new Error("Unsupported project or excessive evidence");
    const sourceRevision = await godotSourceRevision(project.workspacePath);
    const evidence: GameSkillEvidence[] = [];
    for (const relative of [...new Set(evidencePaths)]) {
      safePath(relative); if (!relative.startsWith(".data/")) throw new Error("Evidence must be an existing project .data artifact");
      const contents = await checkedRead(project.workspacePath, relative, 2_000_000);
      evidence.push({ path: relative, sha256: hash(contents), bytes: contents.length });
    }
    const document: GameSkillDocument = { ...definition, originProjectId: project.id, sourceRevision, evidence };
    const content = canonical(document), revision = hash(content);
    return this.#serial(async () => {
      const entries = await this.list();
      const previous = entries.find(entry => entry.id === definition.id && entry.revision === revision); if (previous) return previous;
      const blob = path.join(this.directory, "objects", revision); await mkdir(blob, { recursive: true });
      await writeFile(path.join(blob, "entry.json"), content, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      const header: GameSkillHeader = { id: definition.id, revision, title: definition.title, kind: definition.kind, scope: definition.scope, tags: definition.tags, state: "candidate", originProjectId: project.id, createdAt: new Date().toISOString() };
      await this.#save([...entries, header]); return header;
    });
  }
  async captureTemplate(project: Project, directory: string, files: string[]): Promise<Record<string, string>> {
    safePath(directory); if (!files.length || files.length > 40) throw new Error("Declare 1 to 40 template files");
    const result: Record<string, string> = {};
    for (const file of [...new Set(files)].sort()) {
      templatePath(file); result[file] = (await checkedRead(project.workspacePath, `${directory}/${file}`, 250_000)).toString("utf8");
    }
    return result;
  }
  async document(id: string, revision: string): Promise<GameSkillDocument> {
    if (!ID.test(id) || !REVISION.test(revision)) throw new Error("Invalid game skill reference");
    const contents = await checkedRead(this.directory, `objects/${revision}/entry.json`, 2_500_000);
    if (hash(contents) !== revision) throw new Error("Game skill content revision mismatch");
    const document = JSON.parse(contents.toString("utf8")) as GameSkillDocument;
    if (document.id !== id) throw new Error("Game skill identity mismatch"); validate(document); return document;
  }
  async search(query: GameSkillQuery, runKey?: string): Promise<GameSkillHeader[]> {
    const words = query.query.toLowerCase().match(/[\p{L}\p{N}._-]+/gu) ?? [];
    const found = (await this.list()).filter(entry => entry.state === "active" && compatible(entry.scope, query) && (!query.kind || query.kind === "any" || entry.kind === query.kind)).map(entry => {
      const text = `${entry.id} ${entry.title} ${entry.tags.join(" ")}`.toLowerCase();
      const score = words.filter(word => text.includes(word) || entry.tags.some(tag => word.includes(tag.toLowerCase()))).length;
      return { entry, score };
    }).filter(item => !words.length || item.score > 0).sort((a, b) => b.score - a.score || b.entry.createdAt.localeCompare(a.entry.createdAt)).slice(0, 3).map(item => item.entry);
    if (runKey) { const pinned = this.#pins.get(runKey) ?? new Set<string>(); for (const item of found) pinned.add(`${item.id}:${item.revision}`); this.#pins.set(runKey, pinned); }
    return found;
  }
  async read(id: string, revision: string, runKey: string): Promise<GameSkillDocument> {
    const header = (await this.list()).find(entry => entry.id === id && entry.revision === revision);
    if (!header || (header.state !== "active" && !(header.activatedAt && this.#pins.get(runKey)?.has(`${id}:${revision}`)))) throw new Error("Only active or already pinned skill revisions may be used");
    const document = await this.document(id, revision); this.#used(runKey, id, revision, "read"); return document;
  }
  #used(runKey: string, id: string, revision: string, operation: "read" | "apply") {
    const used = this.#uses.get(runKey) ?? []; if (!used.some(value => value.id === id && value.revision === revision && value.operation === operation)) used.push({ id, revision, operation }); this.#uses.set(runKey, used);
  }
  async review(project: Project, id: string, revision: string, decision: "validate" | "activate" | "reject", review: Omit<GameSkillReview, "at">): Promise<GameSkillHeader> {
    return this.#serial(async () => {
      const entries = await this.list(), header = entries.find(entry => entry.id === id && entry.revision === revision);
      if (!header || header.originProjectId !== project.id) throw new Error("Skill origin does not match this review");
      const document = await this.document(id, revision);
      if (!review.reviewer?.trim() || !review.note?.trim()) throw new Error("A named review and rationale are required");
      if (decision !== "reject") {
        if (!document.evidence.length || !review.checks.reproduction || !review.checks.regression || !review.checks.counterexample) throw new Error("Reproduction, regression, counterexample review and evidence are required");
        if ((await godotSourceRevision(project.workspacePath)) !== document.sourceRevision) throw new Error("Source changed since the candidate was recorded");
        for (const evidence of document.evidence) if (hash(await checkedRead(project.workspacePath, evidence.path, 2_000_000)) !== evidence.sha256) throw new Error("Candidate evidence changed since recording");
      }
      header.state = decision === "activate" ? "active" : decision === "validate" ? "validated" : "rejected";
      header.review = { ...review, at: new Date().toISOString() };
      if (decision === "activate") { header.activatedAt = new Date().toISOString(); for (const item of entries) if (item.id === id && item.revision !== revision && item.state === "active") item.state = "deprecated"; }
      await this.#save(entries); return header;
    });
  }
  async apply(project: Project, id: string, revision: string, query: GameSkillQuery, values: Record<string, unknown>, runKey: string): Promise<{ files: string[]; skillRevision: string; infrastructureOnly: boolean }> {
    const document = await this.read(id, revision, runKey);
    if (document.kind !== "template" || !document.template || !compatible(document.scope, query)) throw new Error("Template is incompatible with this engine, version, target or genre");
    const template = document.template, declared = new Map(template.parameters.map(parameter => [parameter.name, parameter]));
    for (const key of Object.keys(values)) if (!declared.has(key)) throw new Error(`Unknown template parameter ${key}`);
    const substitutions = new Map(template.parameters.map(parameter => [parameter.name, parameterValue(parameter, values[parameter.name] ?? parameter.default)]));
    const files = Object.entries(template.files).map(([relative, text]) => [templatePath(relative), text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_, key: string) => substitutions.get(key)!)] as const);
    const root = await realpath(project.workspacePath);
    if ((await readdir(root)).some(name => ![".git", ".data", "canvas"].includes(name))) throw new Error("Template application requires an empty game workspace; existing source is preserved");
    const written: string[] = [];
    try {
      for (const [relative, contents] of files) {
        const parent = path.dirname(relative);
        if (parent !== ".") {
          let current = root;
          for (const part of parent.split("/")) { current = path.join(current, part); await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; }); if ((await lstat(current)).isSymbolicLink()) throw new Error("Template target contains a symbolic link"); }
        }
        const target = path.join(root, relative); await writeFile(target, contents, { flag: "wx" }); written.push(target);
      }
    } catch (error) { await Promise.all(written.map(file => rm(file, { force: true }))); throw error; }
    this.#used(runKey, id, revision, "apply");
    return { files: files.map(([file]) => file), skillRevision: revision, infrastructureOnly: template.infrastructureOnly };
  }
  async finishRun(project: Project, conversationId: string): Promise<void> {
    const key = `${project.id}:${conversationId}`, used = this.#uses.get(key) ?? [];
    this.#uses.delete(key); this.#pins.delete(key);
    if (!used.length) return;
    const directory = path.join(this.directory, "runs"); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${randomUUID()}.json`), JSON.stringify({ projectId: project.id, conversationId, event: "agent_run_ended", used, sourceRevision: await godotSourceRevision(project.workspacePath), gameplayAcceptance: "not_inferred", at: new Date().toISOString() }, null, 2));
  }
}
