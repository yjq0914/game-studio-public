import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Infrastructure only: no movement, collision, scoring or game loop is supplied. */
export const GODOT_TEST_BRIDGE = String.raw`extends Node

var peer: StreamPeerTCP
var incoming := ""
var callbacks: Array = []
var web_testing := false
var web_elapsed := 0.0

func _ready() -> void:
    process_mode = Node.PROCESS_MODE_ALWAYS
    if OS.has_feature("web"):
        web_testing = bool(JavaScriptBridge.eval("new URLSearchParams(location.search).has('ohmygamePlaytest')"))
        if web_testing:
            var reset_callback = JavaScriptBridge.create_callback(_web_reset)
            callbacks.append(reset_callback)
            var window = JavaScriptBridge.get_interface("window")
            window.__godotStudioReset = reset_callback
            JavaScriptBridge.eval("globalThis.__OHMYGAME_PLAYTEST__={snapshot:()=>globalThis.__godotStudioState,reset:()=>{globalThis.__godotStudioReset();return true}}")
        return
    var port := OS.get_environment("GODOT_STUDIO_TEST_PORT")
    var token := OS.get_environment("GODOT_STUDIO_TEST_TOKEN")
    if port.is_empty() or token.is_empty():
        return
    peer = StreamPeerTCP.new()
    peer.connect_to_host("127.0.0.1", int(port))
    set_meta("token", token)

func _web_reset(_args: Array) -> void:
    get_tree().reload_current_scene.call_deferred()

func _snapshot() -> Dictionary:
    var scene = get_tree().current_scene
    var state: Dictionary = {}
    if scene != null and scene.has_method("studio_snapshot"):
        var custom = scene.call("studio_snapshot")
        if custom is Dictionary:
            state = custom
    return {"scene": scene.scene_file_path if scene != null else "", "game": state}

func _process(delta: float) -> void:
    if web_testing:
        web_elapsed += delta
        if web_elapsed >= 0.1:
            web_elapsed = 0.0
            JavaScriptBridge.eval("globalThis.__godotStudioState=" + JSON.stringify(_snapshot()))
    if peer == null:
        return
    peer.poll()
    if peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
        return
    if has_meta("token"):
        _send({"token": get_meta("token"), "version": 1})
        remove_meta("token")
    if peer.get_available_bytes() > 0:
        var packet = peer.get_data(peer.get_available_bytes())
        if packet[0] != OK:
            return
        incoming += packet[1].get_string_from_utf8()
    if incoming.length() > 1048576:
        peer.disconnect_from_host()
        return
    while incoming.contains("\n"):
        var end := incoming.find("\n")
        var line := incoming.substr(0, end)
        incoming = incoming.substr(end + 1)
        var command = JSON.parse_string(line)
        if command is Dictionary:
            _handle(command)

func _handle(command: Dictionary) -> void:
    var response: Dictionary = {"id": command.get("id", "")}
    match command.get("operation", ""):
        "inspect":
            response["state"] = _snapshot()
        "input":
            var kind: String = command.get("kind", "action")
            if kind == "action":
                var action: String = command.get("action", "")
                if not InputMap.has_action(action):
                    response["error"] = "Unknown input action: " + action
                else:
                    var event := InputEventAction.new()
                    event.action = action
                    event.pressed = command.get("pressed", true)
                    event.strength = 1.0 if event.pressed else 0.0
                    Input.parse_input_event(event)
                    response["accepted"] = true
            elif kind == "click":
                var event := InputEventMouseButton.new()
                event.position = Vector2(float(command.get("x", 0)), float(command.get("y", 0)))
                event.global_position = event.position
                event.button_index = MOUSE_BUTTON_LEFT
                event.pressed = command.get("pressed", true)
                Input.parse_input_event(event)
                response["accepted"] = true
        "capture":
            response["png"] = Marshalls.raw_to_base64(get_viewport().get_texture().get_image().save_png_to_buffer())
        "reset":
            get_tree().reload_current_scene.call_deferred()
            response["accepted"] = true
        _:
            response["error"] = "Unsupported bridge operation"
    _send(response)

func _send(value: Dictionary) -> void:
    peer.put_data((JSON.stringify(value) + "\n").to_utf8_buffer())
`;

/** Only this exact shipped bridge is eligible for the compatibility migration. */
export const LEGACY_GODOT_TEST_BRIDGE = GODOT_TEST_BRIDGE.replace(
  `web_testing = bool(JavaScriptBridge.eval("new URLSearchParams(location.search).has('ohmygamePlaytest')"))`,
  `web_testing = JavaScriptBridge.eval("new URLSearchParams(location.search).has('ohmygamePlaytest')") == true`,
);

export async function initializeGodotWorkspace(root: string): Promise<void> {
  const bridge = path.join(root, "studio_test_bridge.gd");
  const existing = await readFile(bridge, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    },
  );
  if (
    existing !== undefined &&
    existing !== GODOT_TEST_BRIDGE &&
    existing !== LEGACY_GODOT_TEST_BRIDGE
  )
    throw new Error(
      "studio_test_bridge.gd already exists with different contents; preserve it and resolve the conflict explicitly",
    );
  await mkdir(root, { recursive: true });
  if (existing === undefined)
    await writeFile(bridge, GODOT_TEST_BRIDGE, { flag: "wx" });
  else if (existing === LEGACY_GODOT_TEST_BRIDGE)
    await writeFile(bridge, GODOT_TEST_BRIDGE);
  const projectPath = path.join(root, "project.godot");
  let project = await readFile(projectPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    },
  );
  if (project === undefined) {
    project =
      'config_version=5\n\n[application]\nconfig/name="New 2D Game"\nrun/main_scene="res://main.tscn"\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nrenderer/rendering_method.mobile="gl_compatibility"\n';
    await writeFile(
      path.join(root, "main.tscn"),
      '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n',
      { flag: "wx" },
    );
  }
  const autoload = 'StudioTestBridge="*res://studio_test_bridge.gd"';
  if (/^StudioTestBridge=/m.test(project) && !project.includes(autoload))
    throw new Error(
      "StudioTestBridge autoload conflicts with an existing project entry",
    );
  if (!project.includes(autoload))
    project = project.includes("[autoload]")
      ? project.replace("[autoload]", `[autoload]\n${autoload}`)
      : `${project}\n[autoload]\n${autoload}\n`;
  await writeFile(projectPath, project);
}

export const GODOT_WEB_PRESET = `[preset.0]
name="Studio Web"
platform="Web"
runnable=true
export_filter="all_resources"
include_filter=""
exclude_filter=".data/*,.runtime/*"
export_path=""

[preset.0.options]
variant/extensions_support=false
variant/thread_support=false
html/export_icon=true
html/custom_html_shell=""
html/canvas_resize_policy=2
progressive_web_app/enabled=false
`;
