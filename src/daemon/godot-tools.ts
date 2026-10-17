import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import {
  currentGodotWebDirectory,
  type GodotRuntime,
} from "./godot-runtime.js";

export function createGodotTools(
  project: ProjectState,
  runtime: GodotRuntime,
): ToolDefinition[] {
  if (project.type !== "godot-game") return [];
  return [
    defineTool({
      name: "godot_runtime",
      label: "Godot Runtime",
      executionMode: "sequential",
      description:
        "Initialize an empty Godot 2D project and test bridge, start the current source, send actual input events, inspect state/logs, capture a PNG, reset, or stop. Use sequence with actions to batch real input presses, releases and bounded waits for timing-sensitive gameplay without a model roundtrip per frame. Hold a button with an action pressed=true step, a separate kind=wait milliseconds step, then action pressed=false. milliseconds only applies to wait steps, never to action/click steps. Up to 80 steps and 25 seconds total waits; returns a fresh state. Never directly set score or player position. Initialize supplies infrastructure only. Source changes require restart. Evidence is not an automatic gameplay pass. Input requires kind=action with an InputMap action, or kind=click with viewport coordinates; send both pressed=true and pressed=false.",
      parameters: Type.Object(
        {
          operation: Type.Union(
            [
              "initialize",
              "start",
              "input",
              "sequence",
              "inspect",
              "capture",
              "reset",
              "stop",
            ].map((value) => Type.Literal(value)),
          ),
          kind: Type.Optional(
            Type.Union([Type.Literal("action"), Type.Literal("click")]),
          ),
          action: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          pressed: Type.Optional(Type.Boolean()),
          x: Type.Optional(Type.Number({ minimum: 0, maximum: 8192 })),
          y: Type.Optional(Type.Number({ minimum: 0, maximum: 8192 })),
          actions: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  kind: Type.Union([
                    Type.Literal("action"),
                    Type.Literal("click"),
                    Type.Literal("wait"),
                  ]),
                  action: Type.Optional(
                    Type.String({ minLength: 1, maxLength: 100 }),
                  ),
                  pressed: Type.Optional(Type.Boolean()),
                  x: Type.Optional(Type.Number({ minimum: 0, maximum: 8192 })),
                  y: Type.Optional(Type.Number({ minimum: 0, maximum: 8192 })),
                  milliseconds: Type.Optional(
                    Type.Integer({
                      minimum: 0,
                      maximum: 5000,
                      description:
                        "Only for kind=wait; action/click milliseconds must be omitted or zero. Use press, wait, release to hold input.",
                    }),
                  ),
                },
                { additionalProperties: false },
              ),
              { minItems: 1, maxItems: 80 },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, input, signal) => {
        let result: Record<string, unknown>;
        if (input.operation === "initialize")
          result = await runtime.initialize(project, signal);
        else if (input.operation === "start")
          result = await runtime.start(project, signal);
        else if (input.operation === "stop")
          result = await runtime.stop(project.id);
        else if (input.operation === "sequence")
          result = await runtime.sequence(project, input.actions ?? [], signal);
        else {
          if (input.operation === "input") {
            if (input.kind === "action" && !input.action)
              throw new Error("Action input requires action");
            if (
              input.kind === "click" &&
              (input.x === undefined || input.y === undefined)
            )
              throw new Error("Click input requires x and y");
            if (!input.kind || input.pressed === undefined)
              throw new Error("Input requires kind and pressed");
          }
          result = await runtime.operate(
            project,
            input.operation as "input" | "inspect" | "capture" | "reset",
            input,
            signal,
          );
        }
        const { imageBase64, ...details } = result;
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(details, null, 2) },
            ...(typeof imageBase64 === "string"
              ? [
                  {
                    type: "image" as const,
                    data: imageBase64,
                    mimeType: "image/png",
                  },
                ]
              : []),
          ],
          details: { godot: details },
        };
      },
    }),
    defineTool({
      name: "godot_export_web",
      label: "Godot Web Export",
      executionMode: "sequential",
      description:
        "Export the current Godot source using the fixed single-thread Studio Web preset. Preserves the user's export presets. Returns the source revision and export path. Then use game_use to play the exported game in Chromium; exporting alone is not gameplay verification.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_id, _input, signal) => {
        const result = await runtime.exportWeb(project, signal);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          details: { godotExport: result },
        };
      },
    }),
  ];
}

/** Validate before every browser operation, including captures on an already-open session. */
export function guardGodotGameUse(
  project: ProjectState,
  tool: ToolDefinition,
): ToolDefinition {
  if (project.type !== "godot-game" || tool.name !== "game_use") return tool;
  const execute = tool.execute;
  const sessionRevisions = new Map<string, string>();
  return {
    ...tool,
    description: `${tool.description} For Godot, open with no path: the export directory is already served at the Preview root. Do not pass .data/godot-studio/web as a URL path.`,
    execute: async (...args: Parameters<typeof execute>) => {
      const input = args[1] as {
        operation?: string;
        sessionId?: string;
        path?: string;
      };
      if (
        input.operation === "open" &&
        input.path?.replaceAll("\\", "/").includes(".data/godot-studio/web")
      )
        throw new Error(
          "Godot export is already the Preview root; call game_use open without a filesystem path",
        );
      let revision: string | undefined;
      if (input.operation !== "close") {
        await currentGodotWebDirectory(project.workspacePath);
        const exported = JSON.parse(
          await readFile(
            path.join(project.workspacePath, ".data/godot-studio/export.json"),
            "utf8",
          ),
        );
        revision = exported.revision;
        if (
          input.operation !== "open" &&
          sessionRevisions.get(input.sessionId ?? "") !== revision
        )
          throw new Error(
            "Godot browser session is stale; close it and open the current export",
          );
      }
      const result = await execute(...args);
      if (input.operation === "close" && input.sessionId)
        sessionRevisions.delete(input.sessionId);
      if (input.operation !== "close") {
        await currentGodotWebDirectory(project.workspacePath);
        const base = path.join(project.workspacePath, ".data/godot-studio");
        const exported = JSON.parse(
          await readFile(path.join(base, "export.json"), "utf8"),
        );
        if (exported.revision !== revision)
          throw new Error(
            "Godot export changed during the browser operation; open it again",
          );
        const snapshot = (
          result.details as { playtest?: { sessionId?: string } } | undefined
        )?.playtest;
        if (input.operation === "open" && snapshot?.sessionId)
          sessionRevisions.set(snapshot.sessionId, revision!);
        const captures: string[] = [];
        for (const block of result.content) {
          if (block.type !== "image") continue;
          const bytes = Buffer.from(block.data, "base64");
          if (
            bytes.length > 8_000_000 ||
            !["image/jpeg", "image/png"].includes(block.mimeType)
          )
            throw new Error("Invalid browser capture");
          const filename = `web-capture-${randomUUID()}.${block.mimeType === "image/png" ? "png" : "jpg"}`;
          await writeFile(path.join(base, filename), bytes);
          captures.push(`.data/godot-studio/${filename}`);
        }
        await writeFile(
          path.join(base, `web-evidence-${randomUUID()}.json`),
          JSON.stringify(
            {
              projectId: project.id,
              revision: exported.revision,
              operation: args[1],
              content: result.content.map((block) =>
                block.type === "image"
                  ? { type: "image", mimeType: block.mimeType }
                  : block,
              ),
              details: result.details,
              captures,
              acceptance: "needs_review",
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
      }
      return result;
    },
  };
}
