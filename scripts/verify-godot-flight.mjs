import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {
  GodotRuntime,
  godotSourceRevision,
} from "../dist/daemon/godot-runtime.js";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function game(reply) {
  return reply.state?.game ?? reply.gameState?.game ?? reply.gameState ?? {};
}
function playing(s) {
  return s.phase === "playing";
}
function failed(s) {
  return (
    s.phase === "game_over" ||
    s.phase === "gameover" ||
    s.player?.alive === false
  );
}
function target(s, height) {
  const player = s.player ?? {};
  const obstacle = (s.obstacles ?? [])
    .filter(
      (o) => Number(o.x) + Number(o.width ?? 72) > Number(player.x ?? 100) - 18,
    )
    .sort((a, b) => a.x - b.x)[0];
  return obstacle
    ? Number(obstacle.gap_y ?? obstacle.gap_center_y ?? height / 2)
    : height / 2;
}
async function exercise(label, observe, pulse, capture, height, step) {
  const checks = {};
  let state = await observe();
  await capture(`${label}-menu`);
  for (let i = 0; i < 3 && !playing(state); i++) {
    await pulse();
    await sleep(100);
    state = await observe();
  }
  assert(
    playing(state),
    `${label}: player input must start gameplay, got ${JSON.stringify(state)}`,
  );
  checks.start = true;
  const initialY = Number(state.player?.y);
  await pulse();
  await sleep(100);
  state = await observe();
  assert(
    Number.isFinite(initialY) && Number(state.player?.y) !== initialY,
    `${label}: player input must change position`,
  );
  checks.motion = true;
  const scoreBefore = Number(state.score);
  const end = Date.now() + 45000;
  let lastFlap = 0;
  while (
    Date.now() < end &&
    playing(state) &&
    Number(state.score) < scoreBefore + 3
  ) {
    const y = Number(state.player?.y),
      vy = Number(state.player?.velocity_y ?? 0);
    const flap =
      y > target(state, height) - 20 && vy > -40 && Date.now() - lastFlap > 180;
    if (step) {
      state = await step(flap);
      if (flap) lastFlap = Date.now();
    } else {
      if (flap) {
        await pulse();
        lastFlap = Date.now();
      }
      await sleep(35);
      state = await observe();
    }
  }
  assert(
    Number(state.score) >= scoreBefore + 3,
    `${label}: three real traversals must increment score, got ${JSON.stringify(state)}`,
  );
  checks.scoring = true;
  checks.scoredState = state;
  await capture(`${label}-scored`);
  const deathEnd = Date.now() + 10000;
  while (Date.now() < deathEnd && !failed(state)) {
    await sleep(150);
    state = await observe();
  }
  assert(
    failed(state),
    `${label}: no input must lead to actual collision/boundary failure`,
  );
  checks.failure = true;
  checks.failedState = state;
  await capture(`${label}-failed`);
  for (let i = 0; i < 3 && (failed(state) || !playing(state)); i++) {
    await pulse();
    await sleep(80);
    state = await observe();
  }
  assert(
    playing(state) &&
      Number(state.score) === 0 &&
      state.player?.alive !== false,
    `${label}: player restart must reset score and alive state`,
  );
  checks.restart = true;
  checks.restartedState = state;
  await capture(`${label}-restarted`);
  return checks;
}

const workspacePath = path.resolve(process.argv[2] ?? ".");
const runtime = new GodotRuntime();
const project = { id: "flight-acceptance", workspacePath };
const report = {
  kind: "native flight scenario; real input and observations",
  projectPath: workspacePath,
  captures: [],
};
try {
  const config = await fs.readFile(
    path.join(workspacePath, "project.godot"),
    "utf8",
  );
  const height = Number(
    config.match(/window\/size\/viewport_height\s*=\s*(\d+)/)?.[1] ?? 720,
  );
  const script = await fs.readFile(path.join(workspacePath, "main.gd"), "utf8");
  const action =
    script.match(/is_action_(?:just_)?pressed\("([^"]+)"\)/)?.[1] ?? "flap";
  const started = await runtime.start(project);
  report.revision = started.revision;
  report.runId = started.runId;
  const observe = async () => game(await runtime.operate(project, "inspect"));
  const pulse = async () => {
    await runtime.operate(project, "input", {
      kind: "action",
      action,
      pressed: true,
    });
    await runtime.operate(project, "input", {
      kind: "action",
      action,
      pressed: false,
    });
  };
  const capture = async (label) => {
    const value = await runtime.operate(project, "capture");
    report.captures.push({
      label,
      path: path.join(workspacePath, value.capturePath),
    });
  };
  const step = async (flap) =>
    game(
      await runtime.sequence(project, [
        ...(flap
          ? [
              { kind: "action", action, pressed: true },
              { kind: "action", action, pressed: false },
            ]
          : []),
        { kind: "wait", milliseconds: 35 },
      ]),
    );
  report.checks = await exercise(
    "native",
    observe,
    pulse,
    capture,
    height,
    step,
  );
  assert.equal(
    await godotSourceRevision(workspacePath),
    report.revision,
    "Source changed during acceptance",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await runtime.close();
  const directory = path.join(workspacePath, ".data/godot-studio");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "native-acceptance.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
