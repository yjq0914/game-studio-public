# Godot 2D Studio

Godot projects keep their `godot-game` identity. The Godot 2D Studio plugin supplies a creation workflow; Pi's loop and session implementation are unchanged. Simple code-drawn art is allowed. New projects start with an empty scene and test infrastructure, not a prewritten game.

## Local setup

Use the repository's required Bun 1.4.2 and Node 22.19.0 toolchain. Set `GODOT_PATH` to the Godot 4.7.2 console executable. Set `GODOT_WEB_TEMPLATE` to the official matching `web_nothreads_debug.zip`, or install matching export templates through Godot. Desktop verification requires Electron.

`scripts/start-godot-studio.ps1 -GodotPath <console-executable>` uses `.runtime/toolchain/` and isolates projects under `.data/studio-app`, with Pi settings under `.data/studio-pi`. Configure a language model in that isolated profile. It launches the built renderer, so build the host, renderer and player first. No system-wide PATH or installed application data is changed.

## Tools and runtime

`godot_runtime` supports initialize, start, input, inspect, capture, reset and stop. Initialize preserves existing scenes and installs only an empty project plus an autoload test bridge. Native startup imports the project before recording its source revision. The daemon owns one native instance per project and cleans it up at conversation completion and shutdown. Runtime errors, source changes, cancellation and bridge failures invalidate observations and stop that instance.

Action inputs use real Godot InputEventAction events and require an existing InputMap action. Click inputs use viewport coordinates. Send both press and release. For timing-sensitive games, `sequence` accepts up to 80 action/click/wait steps, with each wait bounded to 5 seconds and total waits bounded to 25 seconds. The host validates the entire sequence before sending any input, executes it without model roundtrips between steps, and returns a fresh observation. Cancellation stops the owned run. No score, position or simulation-state assignment is exposed. The bridge reports compact state through `studio_snapshot()` on the current scene; snapshots do not prove that a gameplay path was exercised. Captures return actual viewport PNGs. The native bridge uses an authenticated loopback connection and is off unless the host supplies per-run environment variables.

`godot_export_web` temporarily uses the fixed single-thread Studio Web preset and restores the original preset file. A complete export must include HTML, JavaScript, Wasm and PCK files. Its source digest must match the current project. The existing static preview and Electron `game_use` can then play it. Every Godot browser tool operation checks freshness. Public games work without test mode; the optional browser state/reset bridge activates only for `ohmygamePlaytest` URLs.

## Evidence and acceptance

Native observations, captures, process commands and logs are saved under `.data/godot-studio/runs/<run-id>/`. The export manifest and Web tool evidence are saved alongside that directory. All observations carry a source revision. Generated cache and evidence directories are excluded from the source digest.

Evidence files use `acceptance: needs_review`. They never mark a game passed because a model said so, export succeeded or a screenshot was nonblank. An end-to-end report must independently check start, input, scoring, collision, failure/restart and source parity between native and Web. `agent.completed` retains its original meaning of an ended agent run. File evidence cannot roll back external model charges or MCP side effects.

## Validation

Run `test/godot-runtime.test.ts` for lifecycle, authentication, cancellation, source freshness, export failure, preset preservation and planning-mode tests. Its fake engine tests exercise host behavior and are not evidence of Godot gameplay. Real Godot and real model runs must be reported separately with project paths, revisions, screenshots and missing checks.

## Windows Web playtesting and compatibility

Godot Web playtesting explicitly shows the existing watch window (`visible: true`). In the verified Windows/Electron environment, hidden Godot Wasm windows did not advance frames. Other Web projects keep their existing visibility default. Space input uses the actual DOM space key and acquires focus before dispatch.

Open a Godot export at the preview root; do not pass `.data/godot-studio/web` as a browser URL path. Source changes invalidate both the export and its browser session. Host-owned root `canvas` data is excluded from source hashing; nested game assets remain included.

An exact match of the older shipped test bridge is upgraded at start/export. A different, custom bridge is preserved and reported as incompatible rather than overwritten.

`scripts/verify-godot-flight.mjs` checks native flight gameplay. `scripts/verify-godot-games.cjs <repo-root> <cases-json> [report-json]`, run under Electron, independently checks native and Web flight gameplay, pointer input and source parity. These validators expect the flight snapshot contract; they are not genre-independent acceptance tools. Both use real input and bounded feedback, not state assignment. See the delivered acceptance report for real model runs and the inherited full-suite failures.

## Parallel Canvas and genre-specific checks

Godot workspaces now show the existing editable Canvas beside Preview by default, alongside the chat pane. The combined entry is Canvas & Preview; Code and Assets remain available. Both the workspace and design routes use the same split view. Canvas selection context and save hooks stay connected to the chat.

Register every control, including start and restart, in InputMap. Native action input dispatches InputEventAction; code that handles only InputEventKey will ignore it. Snapshots should expose entities, resources and actual event counters for the requested genre, rather than require flight obstacles for every game.

For native sequences, milliseconds is valid only on wait steps and must be an integer. A nonzero duration on an action/click step is rejected before any input is sent; use press, wait, release. Shell command timeouts are seconds.

`scripts/verify-godot-breakout.cjs <repo-root> <creation-report.json> <output-directory>`, run under Electron, independently checks the 640x720 Neon Breaker snapshot contract: mapped input, actual ball motion, wall/paddle events, twelve bricks/1200 score, victory, three-life failure and reset on both native and Web. It is a Breakout-specific controller, not a universal validator. The creation report supplies cases[0].projectId and projectPath. BREAKOUT_ACTIONS can map native serve/restart/left/right actions. Evidence records source parity and fresh screenshots without assigning game state.
