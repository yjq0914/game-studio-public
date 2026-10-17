const { app } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const root = process.argv[2],
  resultFile = process.argv[3];
const outputFile =
  process.argv[4] ?? path.join(root, ".runtime/independent-acceptance.json");
app.setPath("userData", path.join(root, ".data/independent-game-check"));
app.on("window-all-closed", () => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  kind: "independent real-input native and Web acceptance",
  cases: [],
};
let native, driver, server;
const deadline = setTimeout(
  () => {
    console.error("Acceptance timed out");
    app.exit(2);
  },
  8 * 60 * 1000,
);
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
app.whenReady().then(async () => {
  try {
    const { GodotRuntime, currentGodotWebDirectory } = await import(
      pathToFileURL(path.join(root, "dist/daemon/godot-runtime.js"))
    );
    const { startStaticPreview } = await import(
      pathToFileURL(path.join(root, "dist/daemon/preview-static.js"))
    );
    const { ElectronPlaytestDriver } = await import(
      pathToFileURL(path.join(root, "dist/desktop/playtest-driver.js"))
    );
    const { createGameUseTool } = await import(
      pathToFileURL(path.join(root, "dist/daemon/playtest-tools.js"))
    );
    const { guardGodotGameUse } = await import(
      pathToFileURL(path.join(root, "dist/daemon/godot-tools.js"))
    );
    native = new GodotRuntime();
    driver = new ElectronPlaytestDriver(() => {});
    const creation = JSON.parse(await fs.readFile(resultFile, "utf8"));
    for (const entry of creation.cases) {
      const project = {
        id: entry.projectId,
        workspacePath: entry.projectPath,
        type: "godot-game",
      };
      const item = {
        projectId: project.id,
        projectPath: project.workspacePath,
        captures: [],
      };
      report.cases.push(item);
      try {
        const config = await fs.readFile(
          path.join(project.workspacePath, "project.godot"),
          "utf8",
        );
        const width = Number(
          config.match(/window\/size\/viewport_width\s*=\s*(\d+)/)?.[1] ?? 480,
        );
        const height = Number(
          config.match(/window\/size\/viewport_height\s*=\s*(\d+)/)?.[1] ?? 720,
        );
        const main = await fs.readFile(
          path.join(project.workspacePath, "main.gd"),
          "utf8",
        );
        const action =
          main.match(/is_action_(?:just_)?pressed\("([^"]+)"\)/)?.[1] ??
          "ui_accept";
        const started = await native.start(project);
        item.nativeRevision = started.revision;
        const nativeObserve = async () =>
          game(await native.operate(project, "inspect"));
        const nativePulse = async () => {
          await native.operate(project, "input", {
            kind: "action",
            action,
            pressed: true,
          });
          await native.operate(project, "input", {
            kind: "action",
            action,
            pressed: false,
          });
        };
        const nativeCapture = async (label) => {
          const capture = await native.operate(project, "capture");
          item.captures.push({
            label,
            path: path.join(project.workspacePath, capture.capturePath),
          });
        };
        const nativeStep = async (flap) =>
          game(
            await native.sequence(project, [
              ...(flap
                ? [
                    { kind: "action", action, pressed: true },
                    { kind: "action", action, pressed: false },
                  ]
                : []),
              { kind: "wait", milliseconds: 35 },
            ]),
          );
        item.native = await exercise(
          "native",
          nativeObserve,
          nativePulse,
          nativeCapture,
          height,
          nativeStep,
        );
        await native.stop(project.id);
        const exported = await native.exportWeb(project);
        item.webRevision = exported.revision;
        assert.equal(
          item.nativeRevision,
          item.webRevision,
          "Native and Web must use identical source",
        );
        server = await startStaticPreview(
          await currentGodotWebDirectory(project.workspacePath),
          0,
        );
        const tool = guardGodotGameUse(
          project,
          createGameUseTool(driver, async () => ({
            runtime: "web",
            url: server.url + "/?ohmygamePlaytest=1",
            visible: true,
          })),
        );
        const call = (input) =>
          tool.execute("acceptance", input, undefined, undefined, {});
        let opened = await call({
          operation: "open",
          viewport: { width, height },
        });
        const sessionId = opened.details.playtest.sessionId;
        await sleep(2500);
        const webObserve = async () =>
          game(
            (await call({ operation: "inspect", sessionId })).details.playtest,
          );
        const webReadyDeadline = Date.now() + 30000;
        while (!(await webObserve()).phase && Date.now() < webReadyDeadline)
          await sleep(250);
        const webPulse = async () => {
          await call({
            operation: "act",
            sessionId,
            actions: [
              { type: "press", key: "Space", duration: 15 },
              { type: "wait", milliseconds: 60 },
            ],
          });
        };
        const webCapture = async (label) => {
          const capture = await call({ operation: "capture", sessionId });
          const image = capture.content.find((block) => block.type === "image");
          const filename = path.join(
            project.workspacePath,
            ".data/godot-studio",
            `${label}.jpg`,
          );
          await fs.writeFile(filename, Buffer.from(image.data, "base64"));
          item.captures.push({ label, path: filename });
        };
        const webStep = async (flap) =>
          game(
            (
              await call({
                operation: "act",
                sessionId,
                actions: [
                  ...(flap
                    ? [{ type: "press", key: "Space", duration: 15 }]
                    : []),
                  { type: "wait", milliseconds: 35 },
                ],
              })
            ).details.playtest,
          );
        item.web = await exercise(
          "web",
          webObserve,
          webPulse,
          webCapture,
          height,
          webStep,
        );
        let pointerBefore = await webObserve();
        if (!playing(pointerBefore)) {
          await webPulse();
          pointerBefore = await webObserve();
        }
        await call({
          operation: "act",
          sessionId,
          actions: [
            { type: "click", target: { x: width / 2, y: height / 2 } },
            { type: "wait", milliseconds: 90 },
          ],
        });
        const pointerAfter = await webObserve();
        assert(
          playing(pointerAfter) &&
            Number(pointerAfter.player?.y) !==
              Number(pointerBefore.player?.y) &&
            Number(pointerAfter.player?.velocity_y) < 0,
          "Web pointer input must cause a real flap",
        );
        item.web.pointer = true;
        const observation = (await call({ operation: "inspect", sessionId }))
          .details.playtest;
        assert(
          !observation.logs.some((log) => log.level === "error"),
          `Web runtime errors: ${JSON.stringify(observation.logs)}`,
        );
        assert.equal(
          observation.failedRequests.length,
          0,
          "Web must load without failed requests",
        );
        await call({ operation: "close", sessionId });
        await server.close();
        server = undefined;
        item.status = "passed";
        console.log(
          JSON.stringify({
            event: "independent_acceptance_passed",
            project: project.id,
          }),
        );
      } catch (error) {
        item.status = "failed";
        item.error = String(error);
        console.error(JSON.stringify(item));
      } finally {
        await native.stop(project.id);
        if (server) {
          await server.close();
          server = undefined;
        }
        await driver.request({ operation: "closeAll" });
      }
      await fs.writeFile(
        path.join(root, ".runtime/independent-acceptance.json"),
        JSON.stringify(report, null, 2),
      );
    }
    report.expectedCases = creation.cases.length;
    report.status =
      report.expectedCases > 0 &&
      report.cases.length === report.expectedCases &&
      report.cases.every((item) => item.status === "passed")
        ? "passed"
        : "failed";
  } catch (error) {
    report.status = "failed";
    report.error = String(error);
    console.error(String(error));
  } finally {
    clearTimeout(deadline);
    await native?.close();
    driver?.close();
    if (server) await server.close();
    await fs.writeFile(outputFile, JSON.stringify(report, null, 2));
    app.exit(report.status === "passed" ? 0 : 1);
  }
});
