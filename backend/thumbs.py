"""Thumbnails for frontend popups. Photos: Pillow. Videos: ffmpeg frame."""
import json
import os
import subprocess
import sys

from PIL import Image, ImageOps

SIZE = (480, 480)


def src_of(root, m):
    c1 = os.path.join(root, m.get("trip", ""), m["file"])
    if os.path.exists(c1):
        return c1
    return os.path.join(root, m["file"])


def make_thumb(src, dst, is_video):
    if os.path.exists(dst):
        return "skip"
    try:
        if is_video:
            tmp = dst + ".tmp.jpg"
            r = subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-ss", "1", "-i", src,
                 "-frames:v", "1", "-q:v", "5", tmp],
                capture_output=True, timeout=120)
            if r.returncode != 0 or not os.path.exists(tmp):
                return "ffmpeg_fail"
            im = Image.open(tmp)
            im = ImageOps.exif_transpose(im)
            im.thumbnail(SIZE)
            im.convert("RGB").save(dst, "JPEG", quality=70)
            os.remove(tmp)
            return "ok"
        im = Image.open(src)
        im = ImageOps.exif_transpose(im)
        im.thumbnail(SIZE)
        im.convert("RGB").save(dst, "JPEG", quality=70)
        return "ok"
    except Exception as e:
        return f"err:{str(e)[:80]}"


if __name__ == "__main__":
    items_path = sys.argv[1] if len(sys.argv) > 1 else "frontend/data/items.json"
    src_dir = sys.argv[2] if len(sys.argv) > 2 else "sample"
    out_dir = sys.argv[3] if len(sys.argv) > 3 else "frontend/data/thumbs"
    os.makedirs(out_dir, exist_ok=True)
    items = json.load(open(items_path, encoding="utf-8"))
    ok = skip = fail = 0
    for m in items:
        dst = os.path.join(out_dir, m.get("thumb", m["id"] + ".jpg"))
        r = make_thumb(src_of(src_dir, m), dst, m.get("type") == "video")
        if r == "ok":
            ok += 1
        elif r == "skip":
            skip += 1
        else:
            fail += 1
            print(m["file"], r)
    print(f"thumbs ok={ok} skip={skip} fail={fail} -> {out_dir}")
