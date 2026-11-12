<#
  小梦备忘录 · 代码签名脚本
  用法（有证书之后）：
    1) 把 .pfx 证书放到 tools\cert\xiaomeng.pfx（不要提交到 git）
    2) $env:XM_CERT_PASS='证书密码'
    3) powershell -ExecutionPolicy Bypass -File tools\sign.ps1

  会做两件事：
    - 签 src-tauri\target\release\xiaomeng-memo.exe
    - 签 src-tauri\target\release\bundle\nsis\XiaoMengMemo_*_x64-setup.exe
  签完把 setup.exe 复制到根目录 安装小梦备忘录.exe（脚本自动做）。

  说明：没有证书就无法消除 SmartScreen 的「未知发布者」提示。
  自签名证书（New-SelfSignedCertificate）只能用于内部测试，仍然会被拦。
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cert = Join-Path $PSScriptRoot 'cert\xiaomeng.pfx'
$pass = $env:XM_CERT_PASS

if (-not (Test-Path $cert)) { throw "找不到证书：$cert（先放 .pfx，见 docs/签名说明.md）" }
if (-not $pass) { throw '没设置证书密码：先 $env:XM_CERT_PASS=...' }

$signtool = @(
  "$env:ProgramFiles (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe",
  "$env:ProgramFiles (x86)\Windows Kits\10\bin\x64\signtool.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $signtool) { throw '找不到 signtool.exe：装 Windows SDK 或改用证书厂商提供的签名工具' }

$targets = @(
  (Join-Path $root 'src-tauri\target\release\xiaomeng-memo.exe')
) + (Get-ChildItem (Join-Path $root 'src-tauri\target\release\bundle\nsis') -Filter '*_x64-setup.exe' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })

foreach ($f in $targets) {
  if (-not (Test-Path $f)) { Write-Host "跳过（不存在）：$f" -ForegroundColor Yellow; continue }
  Write-Host "签名：$f" -ForegroundColor Cyan
  & $signtool sign /fd sha256 /td sha256 /tr http://timestamp.digicert.com /f $cert /p $pass $f
  if ($LASTEXITCODE -ne 0) { throw "签名失败：$f" }
  & $signtool verify /pa $f
}

$setup = Get-ChildItem (Join-Path $root 'src-tauri\target\release\bundle\nsis') -Filter '*_x64-setup.exe' | Select-Object -First 1
if ($setup) {
  Copy-Item $setup.FullName (Join-Path $root '安装小梦备忘录.exe') -Force
  Write-Host "已更新根目录安装包：安装小梦备忘录.exe" -ForegroundColor Green
}
Write-Host '签名完成。' -ForegroundColor Green
