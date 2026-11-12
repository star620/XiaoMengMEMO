"""从 LXGW 文楷（OFL 协议）里裁出本项目需要的字，生成 public/fonts/xm-wenkai.woff2。

原字体不随仓库分发（25 MB），需要先下载到 tools/fonts/ 下：
  https://github.com/lxgw/LxgwWenKai/releases  ->  LXGWWenKai-Regular.ttf
生成的 woff2 已经提交在 public/fonts/ 里，只有改字符集时才需要重跑本脚本。
"""
import codecs, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "fonts" / "LXGWWenKai-Regular.ttf"
OUT = ROOT / "public" / "fonts" / "xm-wenkai.woff2"
OUT.parent.mkdir(parents=True, exist_ok=True)

chars = set()
# ASCII printable
for c in range(0x20, 0x7F):
    chars.add(chr(c))
# GB2312 (level 1 + 2 + symbols): rows A1-F7, cells A1-FE
for hi in range(0xA1, 0xF8):
    for lo in range(0xA1, 0xFF):
        try:
            chars.add(bytes([hi, lo]).decode("gb2312"))
        except Exception:
            pass
# extra punctuation / symbols that are common in Chinese notes
extra = "·—…‘’“”「」『』【】〔〕《》〈〉、。，；：？！（）～﹏￥％＃＠＆＊＋－＝／＼｜＜＞＾｀　“”‘’–‑‒―′″℃№§¶•‥…※→←↑↓★☆○●◎◇◆□■△▲▽▼♠♥♦♣✓✔✕✖✗✘☑☐☒⚠⚡✎✏✒✍❤"
chars.update(extra)
chars = {c for c in chars if c.strip() or c == " "}
text = "".join(sorted(chars))
tf = ROOT / "tools" / "fonts" / "charset.txt"
tf.write_text(text, encoding="utf-8")
print("chars:", len(chars))

cmd = [
    sys.executable, "-m", "fontTools.subset", str(SRC),
    f"--text-file={tf}",
    f"--output-file={OUT}",
    "--flavor=woff2",
    "--layout-features=kern,liga,vert,vrt2,palt,halt",
    "--no-hinting",
    "--desubroutinize",
    "--drop-tables+=DSIG",
    "--name-IDs=*",
    "--recalc-bounds",
]
r = subprocess.run(cmd, capture_output=True, text=True)
print("rc:", r.returncode)
print(r.stdout[-2000:])
print(r.stderr[-2000:])
print("size:", OUT.stat().st_size if OUT.exists() else None)
