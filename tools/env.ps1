# 统一环境设置
# 本机系统代理 127.0.0.1:26001 已失效，cargo/rustup 会被它拖死；必须绕过。
$env:NO_PROXY = "*"
$env:no_proxy = "*"
$env:HTTP_PROXY = ""
$env:HTTPS_PROXY = ""
$env:http_proxy = ""
$env:https_proxy = ""
