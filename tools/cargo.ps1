# 用法: pwsh -File tools/cargo.ps1 build --manifest-path src-tauri/Cargo.toml
. "$PSScriptRoot\env.ps1"
& cargo @args
exit $LASTEXITCODE
