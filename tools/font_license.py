from fontTools.ttLib import TTFont
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
f = TTFont(root / "tools" / "fonts" / "LXGWWenKai-Regular.ttf")
for rec in f["name"].names:
    if rec.nameID in (0, 7, 8, 11, 13, 14, 5):
        try:
            txt = rec.toUnicode()
        except Exception:
            continue
        print("=== nameID", rec.nameID, rec.platformID, rec.langID, "len", len(txt))
        print(txt[:1500])
