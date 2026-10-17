---
name: godot-2d-studio
description: Create complete Godot 4.7.2 2D games from an idea and verify the same project natively and as a single-thread Web export.
---

# Godot 2D Studio

Read current files before changing an existing project. Keep the requested scope. For a new game use godot_runtime initialize: it supplies only an empty Node2D scene, project configuration and a test bridge. Author gameplay yourself. Use GDScript and Compatibility rendering. Code-drawn simple art is allowed; make controls, HUD and feedback clear.

## Creation

1. Use the existing Canvas for a concise design and acceptance checklist. Define start, input, core loop, score/progression, failure and restart. No new Canvas format is needed.
2. Implement main.tscn and scripts, bind keyboard plus pointer input, and create a visible playable loop. Preserve studio_test_bridge.gd and its autoload; it is host infrastructure, not game logic. Do not store generated files in .data.
3. Bind every control, including start and restart, to InputMap actions. Handle event.is_action_pressed() or Input polling, rather than accepting only InputEventKey, because native testing sends InputEventAction. Physical keyboard and pointer controls must still work for players. Implement studio_snapshot() on the main scene returning a compact dictionary with phase, score/progression, relevant entities and resources, and real gameplay event counters. Choose fields for this genre: ball/paddle/bricks/lives for Breakout, or player/obstacles for flight. The bridge invokes it for observations. Never make normal gameplay depend on the test bridge.
4. Use godot_runtime start; fix import or script errors. Use input for real InputMap actions or coordinate clicks, sending pressed true then false. For timed gameplay, use godot_runtime sequence with actions to batch presses, releases and waits; do not alter gameplay physics, collision rules or difficulty merely to hide model network latency. Use inspect and capture to verify actual changes and visuals. Restart after modifying source. Do not verify scoring by setting score or verify collision by forcing game_over. Exercise start, movement, score, failure and restart through gameplay; snapshots support assertions but do not replace input/screenshots.
5. Call godot_export_web, then game_use open/act/capture on the exported project. Test keyboard and pointer/touch, collision, score and restart. game_use's optional bridge can inspect/reset, but normal player input remains required. Native and Web evidence must reference the same source revision. Source changes require re-export and re-test.
6. Summarize player-visible behavior, source revision, actual checks and evidence paths. A build, export, nonblank image or model claim alone is not a gameplay pass. Report missing model/environment/runtime capabilities as blocked or unverified, never successful.

OhMyGame owns engine and preview processes; do not start persistent Shell servers or install another browser automation stack. Stop native runs after use. Do not alter the host test bridge to fabricate observations. Public games must work without test mode. Export presets are temporarily managed and restored by the export tool.


## Test scripts and terminal commands

Read known helper paths directly. Do not recursively scan the host repository, node_modules, .runtime, .godot or .data to locate a named file. Shell tool timeout values are seconds, not milliseconds; always provide a bounded timeout (for example 120 for a file command or 600 for a playtest). Godot sequence waits are milliseconds and require explicit wait steps between press and release.

For continuous games, use a separate feedback controller that observes snapshots and sends real player input. Store test scripts, logs and reports under .data so writing evidence does not change the game's source revision. Do not place automatic play, test-only state setters or a forced win path inside game logic. Build an acceptance checklist for the requested mechanics; a flight checker cannot validate Breakout rules.
