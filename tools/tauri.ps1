# 用法: pwsh -File tools/tauri.ps1 dev   /   ... build
. "$PSScriptRoot\env.ps1"
$npx = Join-Path $env:ProgramFiles "nodejs\npx.cmd"
& $npx tauri @args
exit $LASTEXITCODE
