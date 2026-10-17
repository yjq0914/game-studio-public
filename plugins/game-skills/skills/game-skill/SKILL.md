---
name: game-skill
description: Route Godot creation and debugging through reviewed Template skeletons and Debug experience, then record new evidence-based candidates.
---

# Game Skill

Pi owns the agent loop and OhMyGame owns execution. This layer adds reusable project structure and diagnostic experience. It does not replace the native Skill loader, Godot tools, Canvas or model runtime.

Read the existing project and its target requirements. Search game_skill_search with the exact engine version, target subset, gameplay family and focused keywords. Only active reviewed entries are returned. Read their exact id/revision using game_skill_read; check counterexamples before following a procedure. No match means proceed with ordinary implementation and testing, not force an unrelated template. Do not load the entire history.

For creation read game-template. For a failure read game-debug. For actual runtime verification follow godot-2d-studio and the appropriate gameplay assertions. Keep the design and acceptance checklist visible in the existing Canvas.

After a real repair, use game_debug_record to propose a reusable procedure with root cause, exclusions and existing .data artifacts. After abstracting a verified skeleton use game_template_record. Proposals remain candidates outside declared skills directories; no agent tool can activate them. Host review requires source/evidence integrity and reproduction, regression and counterexample checks. Do not treat fewer errors, a match count, export success or agent.completed as gameplay success. Record scope and limitations; never copy credentials or full private transcripts into reusable material.

Terminal timeouts are seconds. Native sequence waits are integer milliseconds and require press, wait, release. Read known host paths directly; never recursively scan node_modules, .runtime or .data to locate a named helper. Execution errors must terminate a helper with a failure result.
