# Development status

This repository contains an OhMyGame-based Godot 2D studio prototype. The upstream source and license are retained. The current work is based on upstream commit `313281f2d6b24e209591c0cdbc7faca6131cec06`.

## Implemented and exercised locally

- Godot 4.7.2 native process management, mapped input, input sequences, observations and screenshots.
- Single-thread Godot Web export and Electron playtesting, with source revision checks.
- Parallel chat, editable Canvas and game preview for Godot projects.
- Real-model creation and real-input native/Web acceptance of two flight games and a Breakout game. Breakout cleared twelve bricks and exercised victory, three-life failure and reset on both targets.

Local acceptance reports, generated games, toolchain downloads, model credentials and application profiles are intentionally excluded from Git.

## Work in progress

The new Template/Debug experience layer in `src/daemon/game-skill-*.ts` and `plugins/game-skills` is a source draft. Tools, storage and host review routes have been connected, but this layer has not completed typechecking, new unit tests, a fresh build or real-model integration verification. No active experience library has been seeded. Review flags are host review decisions, not an implemented universal automatic gameplay verifier.

The previously passing 180-test and later 64-test focused runs predate this experience-layer draft. They must not be treated as validation of the new code. The upstream full-suite baseline had 53 failing tests. Recent standard Node runtime checks have also encountered a 15-second startup timeout; that remains unresolved despite one successful instrumented diagnostic run.

## Requirements and next work

Use the locked dependencies and the repository's documented setup. Godot work needs a matching Godot editor and Web export templates. Local `.runtime` toolchain files are not distributed here. See [Godot 2D Studio](godot-2d-studio.md) for runtime contracts.

Before treating the experience layer as ready, complete a single typecheck, add lifecycle/compatibility/path/evidence/template tests, build the host, and verify retrieval, candidate recording and template variants through the actual agent. Keep candidate experiences separate from active Skills, preserve immutable revisions, and distinguish agent completion from gameplay acceptance.
