import type { FastifyInstance } from "fastify";
import type { ProjectManager } from "./projects.js";
import { GameSkillLibrary, type GameSkillReview } from "./game-skill-library.js";

/** Authenticated host review endpoints; no promotion tool is exposed to Pi. */
export function registerGameSkillRoutes(app: FastifyInstance, library: GameSkillLibrary, projects: ProjectManager, invalidate: () => void): void {
  const params = { type: "object", required: ["id", "revision"], properties: { id: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 80 }, revision: { type: "string", pattern: "^[a-f0-9]{64}$" } }, additionalProperties: false };
  app.get("/game-skills", async () => ({ entries: await library.list() }));
  app.get<{ Params: { id: string; revision: string } }>("/game-skills/:id/:revision", { schema: { params } }, async request => library.document(request.params.id, request.params.revision));
  app.post<{ Params: { id: string; revision: string }; Body: { decision: "validate" | "activate" | "reject"; reviewer: string; note: string; checks: GameSkillReview["checks"] } }>("/game-skills/:id/:revision/review", { schema: {
    params,
    body: { type: "object", required: ["decision", "reviewer", "note", "checks"], properties: { decision: { type: "string", enum: ["validate", "activate", "reject"] }, reviewer: { type: "string", minLength: 1, maxLength: 100 }, note: { type: "string", minLength: 1, maxLength: 4000 }, checks: { type: "object", required: ["reproduction", "regression", "counterexample"], properties: { reproduction: { type: "boolean" }, regression: { type: "boolean" }, counterexample: { type: "boolean" } }, additionalProperties: false } }, additionalProperties: false },
  } }, async (request, response) => {
    const header = (await library.list()).find(entry => entry.id === request.params.id && entry.revision === request.params.revision);
    if (!header) return response.code(404).send({ error: "Game skill revision not found" });
    const project = projects.get(header.originProjectId);
    if (!project) return response.code(404).send({ error: "Origin project not found" });
    try {
      const { decision, ...review } = request.body;
      const result = await library.review(project, header.id, header.revision, decision, review); invalidate(); return result;
    } catch (error) { return response.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
