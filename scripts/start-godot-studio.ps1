param([string]$GodotPath = $env:GODOT_PATH)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot
Set-Location -LiteralPath $repoRoot
$node = Join-Path $repoRoot '.runtime/toolchain/node.exe'
$bunDir = Join-Path $repoRoot '.runtime/toolchain/bun-windows-x64'
if (-not (Test-Path -LiteralPath $node)) { throw 'Prepare the isolated Node 22.19.0 toolchain first.' }
if (-not $GodotPath -or -not (Test-Path -LiteralPath $GodotPath)) { throw 'Pass -GodotPath pointing to the Godot 4.7.2 console executable.' }
$template = Join-Path $repoRoot '.runtime/toolchain/web_nothreads_debug.zip'
if (-not (Test-Path -LiteralPath $template)) { throw 'Prepare the matching Godot 4.7.2 Web export template first.' }
$env:PATH = (Split-Path $node) + ';' + $bunDir + ';' + $env:PATH
$env:GODOT_PATH = $GodotPath
$env:GODOT_WEB_TEMPLATE = $template
$env:OHMYGAME_DATA_DIR = Join-Path $repoRoot '.data/studio-app'
$env:PI_CODING_AGENT_DIR = Join-Path $repoRoot '.data/studio-pi'
$env:OHMYGAME_USER_DATA_DIR = Join-Path $repoRoot '.data/studio-electron-profile'
New-Item -ItemType Directory -Path $env:OHMYGAME_USER_DATA_DIR -Force | Out-Null
$settingsPath = Join-Path $env:PI_CODING_AGENT_DIR 'settings.json'
if (Test-Path -LiteralPath $settingsPath) {
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    if (-not $settings.shellPath) {
        $git = Get-Command git.exe -ErrorAction SilentlyContinue
        if ($git) {
            $gitBash = Join-Path (Split-Path (Split-Path $git.Source)) 'bin/bash.exe'
            if (Test-Path -LiteralPath $gitBash) {
                $settings | Add-Member -NotePropertyName shellPath -NotePropertyValue $gitBash
                $settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $settingsPath
            }
        }
    }
}
& $node node_modules/electron/cli.js . --built-renderer
exit $LASTEXITCODE
