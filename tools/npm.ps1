# 用法: pwsh -File tools/npm.ps1 run build
. "$PSScriptRoot\env.ps1"
$npm = Join-Path $env:ProgramFiles "nodejs\npm.cmd"
& $npm @args
exit $LASTEXITCODE
