---
name: game-debug
description: Diagnose Godot integration and gameplay failures using scoped prior procedures, real input, exclusion cases and source-bound repair evidence.
---

# Debug Skill

1. Fix the requested behavior and current version/target. Capture a reproducible failure and actual logs; distinguish the game, host tool, model request and test controller.
2. Search active Debug experience with engine version and affected platform; read the pinned revision. A similar message alone is not a matching root cause. Follow exclusion cases and inspect actual code/state.
3. Apply the smallest justified change. Use existing Godot runtime/browser tools and mapped real inputs. Continuous games need an external feedback controller; do not replace gameplay with state assignment or in-game automatic play. Store helpers/evidence under .data.
4. Repeat the failing case, neighboring regression and a non-applicable counterexample. Separately report build, engine startup, controls, mechanics, visuals, victory/failure/reset and native/Web source parity. Do not call a partly improved failure verified.
5. Propose a concise candidate through game_debug_record: symptom, confirmed cause, diagnostic procedure, exclusions, exact scope and evidence paths. Keep observations separate from hypotheses. The host records immutable source/evidence references. Candidate proposals are not automatically active; human/host review is separate from model self-assessment.
