---
name: game-template
description: Select, instantiate and improve compatible parameterized Godot project skeletons without copying a complete game as supposed from-scratch generation.
---

# Template Skill

1. Lock engine/version, targets, controls, requested mechanics and acceptance criteria. Search reviewed templates and read the exact revision. A playable source project is not automatically a reusable template.
2. If the user requested creation from an empty project, use only infrastructureOnly templates. If no suitable active entry exists use godot_runtime initialize and author gameplay. Explicitly distinguish a template-based variant from original generation.
3. Use game_template_apply only in an empty game workspace. It preserves existing source by refusal, validates typed parameter bounds and copies the immutable reviewed snapshot. Values replace {{name}} with JSON literals. Then run godot_runtime initialize to add the current host bridge while preserving the template's scene.
4. Implement the requested mechanics and art. Build, play natively, export the same source and play Web. Template evidence never substitutes for acceptance of the new game.
5. To accumulate a new template, create a small text-source draft under .data with declared parameters and explicit files. Separate reusable mechanics/input/configuration from theme, user content, evidence and credentials. Record it using game_template_record. Review standard/boundary parameters, at least one variation and a non-applicable request before activation. Preserve old revisions; never merge code by length or promote based on frequency.
