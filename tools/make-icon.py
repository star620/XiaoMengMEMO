# -*- coding: utf-8 -*-
"""生成小梦备忘录应用图标（暖黄便利贴 + 手写墨线 + 翘角），透明背景 1024x1024"""
from PIL import Image, ImageDraw, ImageFilter
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon-source.png")

W = H = 1400           # 便签原始尺寸
SS = 1024              # 最终输出尺寸
CANVAS = 2048

# 1) 渐变纸面
c1, c2 = (255, 248, 196), (255, 216, 74)
grad = Image.new("RGBA", (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
for y in range(H):
    t = y / (H - 1)
    gd.line([(0, y), (W, y)], fill=(
        int(c1[0] + (c2[0] - c1[0]) * t),
        int(c1[1] + (c2[1] - c1[1]) * t),
        int(c1[2] + (c2[2] - c1[2]) * t), 255))

mask = Image.new("L", (W, H), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, H - 1], radius=26, fill=255)
note = Image.composite(grad, Image.new("RGBA", (W, H), (0, 0, 0, 0)), mask)

# 2) 手写墨线（4 行，长度不一，像写下的备忘）
d = ImageDraw.Draw(note)
ink = (104, 84, 26, 240)
pad_x, line_h, gap = 150, 40, 168
widths = [0.80, 0.64, 0.72, 0.44]
for i, w in enumerate(widths):
    yy = 330 + i * gap
    d.rounded_rectangle([pad_x, yy, int(pad_x + (W - 2 * pad_x) * w), yy + line_h],
                        radius=line_h // 2, fill=ink)

# 3) 右下角翘角：切掉一个三角，露出浅色背面
fold = 210
top = Image.new("RGBA", (W, H), (0, 0, 0, 0))
td = ImageDraw.Draw(top)
td.polygon([(W, H - fold), (W - fold, H), (W, H)], fill=(255, 244, 176, 255))
d.polygon([(W - fold, H), (W, H - fold), (W - fold, H - fold)], fill=(232, 202, 92, 255))
note = Image.alpha_composite(note, top)

# 4) 阴影：用纸面轮廓做模糊
shadow_mask = mask.rotate(-7, resample=Image.BICUBIC, expand=False)
shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
shadow.putalpha(shadow_mask.point(lambda v: int(v * 0.22)))
shadow = shadow.filter(ImageFilter.GaussianBlur(26))

rotated = note.rotate(-7, resample=Image.BICUBIC, expand=True)
srot = shadow.rotate(-7, resample=Image.BICUBIC, expand=True)

canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
cx = (CANVAS - srot.width) // 2
cy = (CANVAS - srot.height) // 2 + 30
canvas.alpha_composite(srot, (cx, cy - 24))
canvas.alpha_composite(rotated, ((CANVAS - rotated.width) // 2, (CANVAS - rotated.height) // 2 - 20))

canvas.resize((SS, SS), Image.LANCZOS).save(OUT)
print("saved", OUT)
