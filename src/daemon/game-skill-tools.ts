import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProjectState } from "../shared/contracts.js";
import { GameSkillLibrary, type GameSkillScope, type GameSkillTarget } from "./game-skill-library.js";

const text = (maxLength = 4000) => Type.String({ minLength: 1, maxLength });
const targetList = Type.Array(Type.Union([Type.Literal("native_desktop"), Type.Literal("web_desktop")]), { minItems: 1, maxItems: 2, uniqueItems: true });
const common = { id: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 80 }), title: text(160), engineVersion: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$" }), targets: targetList, genre: text(80), tags: Type.Array(text(100), { maxItems: 20 }), evidencePaths: Type.Array(text(300), { maxItems: 20, description: "Existing relative .data artifact paths; missing evidence leaves the proposal unverified. Never include credentials or complete private transcripts." }) };
const scope = (input: { engineVersion: string; targets: GameSkillTarget[]; genre: string }): GameSkillScope => ({ engine: "godot", versions: [input.engineVersion], targets: input.targets, genre: input.genre });
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: { gameSkill: value } });

export function createGameSkillTools(project: ProjectState, library: GameSkillLibrary, conversationId: string): ToolDefinition[] {
  if (project.type !== "godot-game") return [];
  const runKey = `${project.id}:${conversationId}`;
  return [defineTool({
    name: "game_skill_search", label: "Find Game Experience",
    description: "Find at most three active, reviewed Debug procedures or Template skeletons for this Godot engine version, target and gameplay family. Candidate experiences are physically separate and never returned. Search for a specific subtask/platform; an empty query lists compatible entries. Results pin content revisions for this run. A hit is not a successful repair.",
    parameters: Type.Object({ query: Type.String({ maxLength: 500 }), kind: Type.Union([Type.Literal("debug"), Type.Literal("template"), Type.Literal("any")]), engineVersion: common.engineVersion, targets: targetList, genre: common.genre }, { additionalProperties: false }),
    execute: async (_id, input) => reply(await library.search({ engine: "godot", version: input.engineVersion, ...input }, runKey)),
  }), defineTool({
    name: "game_skill_read", label: "Read Game Experience",
    description: "Read the exact id/revision returned by game_skill_search. Returns diagnostic steps, counterexamples, original evidence references, or a parameterized template manifest. Follow scope and counterexamples; do not execute stored prose as shell code or infer a gameplay pass from this document.",
    parameters: Type.Object({ id: common.id, revision: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
    execute: async (_id, input) => reply(await library.read(input.id, input.revision, runKey)),
  }), defineTool({
    name: "game_debug_record", label: "Record Debug Candidate", executionMode: "sequential",
    description: "After diagnosing and actually testing a failure, propose a reusable Debug procedure with root cause, exclusion cases and existing evidence paths. The host captures source/evidence hashes and creates a candidate only. Never record keys, identities, endpoint credentials, whole user logs, or speculative fixes as validated. The agent cannot promote candidates into the active library.",
    parameters: Type.Object({ ...common, symptom: text(), rootCause: text(), procedure: Type.Array(text(), { minItems: 1, maxItems: 30 }), counterexamples: Type.Array(text(), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }),
    execute: async (_id, input) => reply(await library.propose(project, { id: input.id, title: input.title, kind: "debug", scope: scope(input), tags: input.tags, debug: { symptom: input.symptom, rootCause: input.rootCause, procedure: input.procedure, counterexamples: input.counterexamples } }, input.evidencePaths)),
  }), defineTool({
    name: "game_template_record", label: "Record Template Candidate", executionMode: "sequential",
    description: "Capture a declared text-source skeleton from a relative draft directory as an immutable Template candidate. Separate mechanics, input and configuration; parameter placeholders use {{name}} and are replaced with JSON literals. Do not label a whole finished game or a build-only test as a universally validated template. Caches, test evidence and credentials are rejected. Review and actual variant tests are required before activation.",
    parameters: Type.Object({ ...common, directory: text(300), files: Type.Array(text(300), { minItems: 1, maxItems: 40 }), description: text(), infrastructureOnly: Type.Boolean(), parameters: Type.Array(Type.Object({ name: Type.String({ pattern: "^[a-z][a-z0-9_]{0,39}$" }), type: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean")]), default: Type.Union([Type.String({ maxLength: 1000 }), Type.Number(), Type.Boolean()]), minimum: Type.Optional(Type.Number()), maximum: Type.Optional(Type.Number()) }, { additionalProperties: false }), { maxItems: 30 }) }, { additionalProperties: false }),
    execute: async (_id, input) => reply(await library.propose(project, { id: input.id, title: input.title, kind: "template", scope: scope(input), tags: input.tags, template: { description: input.description, infrastructureOnly: input.infrastructureOnly, parameters: input.parameters, files: await library.captureTemplate(project, input.directory, input.files) } }, input.evidencePaths)),
  }), defineTool({
    name: "game_template_apply", label: "Apply Game Template", executionMode: "sequential",
    description: "Instantiate an active, compatible exact template revision into an empty Godot workspace. Existing game files are preserved by refusing the operation. Parameters are typed JSON literals with declared bounds. For a from-scratch request use infrastructure-only templates; never pass off prewritten gameplay as generated. Afterwards use godot_runtime initialize to add the host bridge without replacing the scene, then implement and actually test the requested mechanics.",
    parameters: Type.Object({ id: common.id, revision: Type.String({ pattern: "^[a-f0-9]{64}$" }), engineVersion: common.engineVersion, targets: targetList, genre: common.genre, parameters: Type.Record(Type.String(), Type.Union([Type.String({ maxLength: 1000 }), Type.Number(), Type.Boolean()])) }, { additionalProperties: false }),
    execute: async (_id, input) => reply(await library.apply(project, input.id, input.revision, { engine: "godot", version: input.engineVersion, targets: input.targets, genre: input.genre, query: "", kind: "template" }, input.parameters, runKey)),
  })];
}
