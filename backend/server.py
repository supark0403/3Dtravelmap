"""3Dtravelmap local server: static frontend + travel media + trip-folder API.

Run from repo root:  python backend/server.py [--port 8000] [--sample travel]

API (JSON):
  GET    /api/trips            -> [{id, name, total, gps, ..., is_dir}]
  POST   /api/trips            {name} -> mkdir + rebuild
  PATCH  /api/trips/{old}      {name} -> rename dir + rebuild
  DELETE /api/trips/{name}     -> rmtree + rebuild
  POST   /api/rebuild          -> background rescan
  GET    /api/rebuild          -> {running, log}
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE_ROOT = os.path.join(ROOT, "travel")
FRONTEND_DIR = os.path.join(ROOT, "frontend")
DATA_DIR = os.path.join(FRONTEND_DIR, "data")
ITEMS_JSON = os.path.join(DATA_DIR, "items.json")
TRIPS_JSON = os.path.join(DATA_DIR, "trips.json")
TRIPS_DIR = os.path.join(DATA_DIR, "trips")
THUMBS_DIR = os.path.join(DATA_DIR, "thumbs")

NAME_RE = re.compile(r"^[^/\\]+$")
IMG_EXTS = {".jpg", ".jpeg", ".png"}
VID_EXTS = {".mp4", ".mov", ".m4v"}

rebuild_state = {"running": False, "log": []}
rebuild_lock = threading.Lock()


def log(msg):
    rebuild_state["log"].append(msg)
    rebuild_state["log"] = rebuild_state["log"][-50:]
    print(f"[rebuild] {msg}", flush=True)


def valid_name(name):
    return (isinstance(name, str) and 1 <= len(name.strip()) <= 60
            and bool(NAME_RE.match(name.strip())) and ".." not in name
            and name.strip() not in (".", ".."))


def trip_path(name):
    return os.path.join(SAMPLE_ROOT, name)


def root_trip_name():
    return os.path.basename(os.path.normpath(SAMPLE_ROOT))


def name_taken(name):
    if os.path.exists(trip_path(name)):
        return True
    if name == root_trip_name():
        return True
    try:
        with open(TRIPS_JSON, encoding="utf-8") as f:
            if any(t.get("id") == name for t in json.load(f)):
                return True
    except (OSError, ValueError):
        pass
    return False


def count_media(folder):
    n = 0
    try:
        for f in os.listdir(folder):
            if os.path.splitext(f)[1].lower() in IMG_EXTS | VID_EXTS:
                n += 1
    except OSError:
        pass
    return n


# ---------- pipeline (imports, no subprocess) ----------

def migrate_thumbs(new_items):
    """Copy old-scheme thumbs to new stable names by (file, size) match."""
    try:
        with open(ITEMS_JSON, encoding="utf-8") as f:
            old_items = json.load(f)
    except (OSError, ValueError):
        return 0
    by_key, by_file = {}, {}
    for m in old_items:
        th = m.get("thumb")
        if not th:
            continue
        by_key.setdefault((m.get("file"), m.get("size")), th)
        by_file.setdefault(m.get("file"), th)
    n = 0
    for m in new_items:
        dst = os.path.join(THUMBS_DIR, m["thumb"])
        if os.path.exists(dst):
            continue
        cand = by_key.get((m.get("file"), m.get("size"))) or by_file.get(m.get("file"))
        src = os.path.join(THUMBS_DIR, cand) if cand else None
        if src and src != dst and os.path.exists(src):
            try:
                shutil.copyfile(src, dst)
                n += 1
            except OSError:
                pass
    return n


def prune_thumbs(items):
    keep = {m["thumb"] for m in items if m.get("thumb")}
    n = 0
    try:
        for f in os.listdir(THUMBS_DIR):
            if f.lower().endswith(".jpg") and f not in keep:
                try:
                    os.remove(os.path.join(THUMBS_DIR, f))
                    n += 1
                except OSError:
                    pass
    except OSError:
        pass
    return n


def run_pipeline():
    from extract import scan_trips
    from build_path import build
    from thumbs import make_thumb, src_of

    items_by_trip = scan_trips(SAMPLE_ROOT)
    items = [m for t in items_by_trip.values() for m in t]
    log(f"scanned trips={list(items_by_trip)} files={len(items)}")

    os.makedirs(THUMBS_DIR, exist_ok=True)
    n_mig = migrate_thumbs(items)
    log(f"migrated thumbs={n_mig}")

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(ITEMS_JSON, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)

    by_trip = {}
    for m in items:
        by_trip.setdefault(m.get("trip", "main"), []).append(m)
    os.makedirs(TRIPS_DIR, exist_ok=True)
    # stale per-trip files
    for f in os.listdir(TRIPS_DIR):
        if f.endswith(".json") and f[:-5] not in by_trip:
            os.remove(os.path.join(TRIPS_DIR, f))
    index = []
    for trip, ms in sorted(by_trip.items()):
        tl = build(ms)
        tl["trip"] = trip
        with open(os.path.join(TRIPS_DIR, f"{trip}.json"), "w", encoding="utf-8") as f:
            json.dump(tl, f, ensure_ascii=False, indent=1)
        index.append({"id": trip, "name": trip, **tl["meta"]})
    with open(TRIPS_JSON, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)

    ok = skip = fail = 0
    for m in items:
        r = make_thumb(src_of(SAMPLE_ROOT, m),
                       os.path.join(THUMBS_DIR, m["thumb"]),
                       m.get("type") == "video")
        if r == "ok":
            ok += 1
        elif r == "skip":
            skip += 1
        else:
            fail += 1
    log(f"thumbs ok={ok} skip={skip} fail={fail}")
    n_prune = prune_thumbs(items)
    log(f"pruned={n_prune} done total={len(items)}")


def rebuild_bg():
    with rebuild_lock:
        if rebuild_state["running"]:
            return False
        rebuild_state["running"] = True
    def _run():
        try:
            run_pipeline()
        except Exception as e:  # never leave running stuck
            log(f"ERROR {e}")
        finally:
            with rebuild_lock:
                rebuild_state["running"] = False
    threading.Thread(target=_run, daemon=True).start()
    return True


def trips_from_index():
    try:
        with open(TRIPS_JSON, encoding="utf-8") as f:
            index = json.load(f)
    except (OSError, ValueError):
        index = []
    by_id = {t["id"]: t for t in index}
    out = []
    for t in index:
        t = dict(t)
        t["is_dir"] = os.path.isdir(trip_path(t["id"]))
        out.append(t)
    # dirs with no built index yet (fresh folders)
    try:
        names = sorted(os.listdir(SAMPLE_ROOT))
    except OSError:
        names = []
    for n in names:
        if n in by_id or not os.path.isdir(trip_path(n)):
            continue
        out.append({"id": n, "name": n, "total": count_media(trip_path(n)),
                    "is_dir": True, "pending": True})
    return out


# ---------- HTTP ----------

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            ln = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            ln = 0
        try:
            return json.loads(self.rfile.read(ln).decode("utf-8") or "{}")
        except ValueError:
            return {}

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/rebuild":
            with rebuild_lock:
                self._json(dict(rebuild_state))
            return
        if parsed.path == "/api/trips":
            self._json(trips_from_index())
            return
        if parsed.path.startswith("/travel/"):
            import mimetypes
            import shutil as _sh
            rel = urllib.parse.unquote(parsed.path[len("/travel/"):])
            full = os.path.normpath(os.path.join(SAMPLE_ROOT, rel))
            root_n = os.path.normpath(SAMPLE_ROOT)
            if full != root_n and not full.startswith(root_n + os.sep):
                self.send_error(403)
                return
            if not os.path.isfile(full):
                self.send_error(404)
                return
            ctype, _ = mimetypes.guess_type(full)
            try:
                with open(full, "rb") as f:
                    self.send_response(200)
                    self.send_header("Content-Type", ctype or "application/octet-stream")
                    self.send_header("Content-Length", str(os.path.getsize(full)))
                    self.send_header("Accept-Ranges", "none")
                    self.end_headers()
                    _sh.copyfileobj(f, self.wfile)
            except (OSError, ConnectionError):
                pass
            return
        self.directory = FRONTEND_DIR
        return SimpleHTTPRequestHandler.do_GET(self)

    def _mutate(self, op):
        parts = urllib.parse.urlparse(self.path).path.split("/")
        if len(parts) != 4 or parts[1] != "api" or parts[2] != "trips":
            self.send_error(404)
            return
        old = urllib.parse.unquote(parts[3])
        data = self._body() if op in ("rename",) else {}
        if op == "create":
            name = (data.get("name") or "").strip()
            if not valid_name(name):
                self._json({"error": "invalid name"}, 400)
                return
            if name_taken(name):
                self._json({"error": "exists"}, 409)
                return
            os.makedirs(trip_path(name))
            rebuild_bg()
            self._json({"ok": True, "name": name})
            return
        # rename / delete target an existing subdir
        if not valid_name(old) or not os.path.isdir(trip_path(old)):
            self._json({"error": "not found"}, 404)
            return
        if op == "rename":
            new = (data.get("name") or "").strip()
            if not valid_name(new):
                self._json({"error": "invalid name"}, 400)
                return
            if name_taken(new):
                self._json({"error": "exists"}, 409)
                return
            os.rename(trip_path(old), trip_path(new))
            rebuild_bg()
            self._json({"ok": True, "old": old, "name": new})
        elif op == "delete":
            shutil.rmtree(trip_path(old))
            rebuild_bg()
            self._json({"ok": True, "name": old})

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path == "/api/rebuild":
            self._json({"started": rebuild_bg()})
            return
        if urllib.parse.urlparse(self.path).path == "/api/trips":
            # create: path has no name part
            data = self._body()
            self.path = "/api/trips/"
            # reuse _mutate create branch via direct logic
            name = (data.get("name") or "").strip()
            if not valid_name(name):
                self._json({"error": "invalid name"}, 400)
                return
            if name_taken(name):
                self._json({"error": "exists"}, 409)
                return
            os.makedirs(trip_path(name))
            rebuild_bg()
            self._json({"ok": True, "name": name})
            return
        self.send_error(404)

    def do_PATCH(self):
        self._mutate("rename")

    def do_DELETE(self):
        self._mutate("delete")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--sample", default=SAMPLE_ROOT)
    args = ap.parse_args()
    SAMPLE_ROOT = os.path.abspath(args.sample)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"serving app at http://localhost:{args.port}  travel={SAMPLE_ROOT}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
