"""EXIF + video metadata extractor. Each subfolder of input = one trip."""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

from PIL import Image
from PIL.ExifTags import IFD

IMG_EXTS = {".jpg", ".jpeg", ".png"}
VID_EXTS = {".mp4", ".mov", ".m4v"}
FNAME_TS = re.compile(r"(\d{8})_(\d{6})")
ISO6709 = re.compile(r"([+-]\d+(?:\.\d+))([+-]\d+(?:\.\d+))")


def parse_exif_dt(s):
    try:
        return datetime.strptime(s.strip(), "%Y:%m:%d %H:%M:%S")
    except (ValueError, AttributeError):
        return None


def dms_to_deg(dms):
    try:
        d, m, s = (float(x) for x in dms)
        return d + m / 60.0 + s / 3600.0
    except (TypeError, ValueError):
        return None


def gps_from_exif(ex):
    """(lat, lon) or None. Standard lat/lon tags required (thumbnail residue ignored)."""
    try:
        gps = ex.get_ifd(IFD.GPSInfo)
    except Exception:
        return None
    if not gps or 1 not in gps or 2 not in gps or 3 not in gps or 4 not in gps:
        return None
    lat = dms_to_deg(gps[2])
    lon = dms_to_deg(gps[4])
    if lat is None or lon is None:
        return None
    if gps[1] == "S":
        lat = -lat
    if gps[3] == "W":
        lon = -lon
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return (lat, lon)


def extract_image(path):
    out = {"type": "photo", "has_gps": False, "lat": None, "lon": None,
           "datetime": None, "width": None, "height": None}
    try:
        im = Image.open(path)
        out["width"], out["height"] = im.size
        ex = im.getexif()
        if ex:
            try:
                ex_ifd = ex.get_ifd(IFD.Exif)
            except Exception:
                ex_ifd = {}
            dt = ex_ifd.get(36867) or ex.get(306)
            if isinstance(dt, str):
                out["datetime"] = dt.replace(":", "-", 2)
            g = gps_from_exif(ex)
            if g:
                out["lat"], out["lon"] = g
                out["has_gps"] = True
    except Exception as e:
        out["error"] = str(e)[:150]
    return out


def parse_iso6709(s):
    m = ISO6709.search(s or "")
    if not m:
        return None
    try:
        lat, lon = float(m.group(1)), float(m.group(2))
    except ValueError:
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return (lat, lon)


def extract_video(path):
    out = {"type": "video", "has_gps": False, "lat": None, "lon": None,
           "datetime": None, "duration": None, "width": None, "height": None}
    try:
        p = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", "-o", "-", path],
            capture_output=True, text=True, timeout=60)
        info = json.loads(p.stdout)
        tags = info.get("format", {}).get("tags", {})
        ct = tags.get("creation_time", "")
        if ct:
            try:
                dt_utc = datetime.fromisoformat(ct.replace("Z", "+00:00"))
                out["datetime"] = dt_utc.astimezone().strftime("%Y-%m-%d %H:%M:%S")
            except ValueError:
                pass
        g = parse_iso6709(tags.get("location") or tags.get("location-eng") or "")
        if g:
            out["lat"], out["lon"] = g
            out["has_gps"] = True
        try:
            out["duration"] = float(info.get("format", {}).get("duration"))
        except (TypeError, ValueError):
            pass
        for st in info.get("streams", []):
            if st.get("codec_type") == "video":
                out["width"] = st.get("width")
                out["height"] = st.get("height")
                break
    except Exception as e:
        out["error"] = str(e)[:150]
    return out


def fallback_from_filename(path, out):
    if out.get("datetime"):
        return
    m = FNAME_TS.search(os.path.basename(path))
    if m:
        try:
            dt = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")
            out["datetime"] = dt.strftime("%Y-%m-%d %H:%M:%S")
            out["datetime_source"] = "filename"
        except ValueError:
            pass


def scan_one(folder, trip, start_idx):
    items = []
    for name in sorted(os.listdir(folder)):
        ext = os.path.splitext(name)[1].lower()
        if ext not in IMG_EXTS and ext not in VID_EXTS:
            continue
        full = os.path.join(folder, name)
        if not os.path.isfile(full):
            continue
        meta = extract_video(full) if ext in VID_EXTS else extract_image(full)
        fallback_from_filename(full, meta)
        meta["id"] = f"m{start_idx:04d}"
        meta["trip"] = trip
        meta["thumb"] = f"{trip}_{meta['id']}.jpg"
        meta["file"] = name.replace("\\", "/")
        meta["relpath"] = f"{trip}/{meta['file']}" if trip != os.path.basename(folder) else meta["file"]
        try:
            meta["size"] = os.path.getsize(full)
        except OSError:
            meta["size"] = None
        items.append(meta)
        start_idx += 1
    return items, start_idx


def scan_trips(root):
    """Subfolder = one trip. Media directly in root = trip named after root."""
    trips = {}
    idx = 0
    root_files, _ = scan_one(root, os.path.basename(root.rstrip("/\\")), idx)
    if root_files:
        trips[root_files[0]["trip"]] = root_files
        idx += len(root_files)
    for name in sorted(os.listdir(root)):
        full = os.path.join(root, name)
        if not os.path.isdir(full):
            continue
        items, idx = scan_one(full, name, idx)
        if items:
            trips[name] = items
    return trips


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "sample"
    dst = sys.argv[2] if len(sys.argv) > 2 else "frontend/data/items.json"
    trips = scan_trips(src)
    items = [m for t in trips.values() for m in t]
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    gps = sum(1 for m in items if m["has_gps"])
    dt = sum(1 for m in items if m.get("datetime"))
    print(f"trips={list(trips)} scanned={len(items)} with_datetime={dt} with_gps={gps} -> {dst}")
