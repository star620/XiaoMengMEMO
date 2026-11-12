# -*- coding: utf-8 -*-
"""从 icon-source.png 生成 Windows 打包所需图标集（PNG + 多尺寸 ICO），不依赖 tauri CLI"""
from PIL import Image
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 项目根
SRC = os.path.join(BASE, "tools", "icon-source.png")
OUT = os.path.join(BASE, "src-tauri", "icons")
os.makedirs(OUT, exist_ok=True)

src = Image.open(SRC).convert("RGBA")
print("source", src.size, src.mode)

pngs = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "StoreLogo.png": 50,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
}
for name, size in pngs.items():
    src.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name))
    print("png", name, size)

# ICO：多尺寸内嵌（Windows 任务栏/资源管理器/安装包共用）
ico = os.path.join(OUT, "icon.ico")
src.save(ico, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("ico", ico, os.path.getsize(ico), "bytes")
