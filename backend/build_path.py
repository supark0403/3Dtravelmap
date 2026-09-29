"""Path builder: GPS+time anchors first, time-only items interpolated.

- sort by datetime
- anchors = items with valid GPS
- no-GPS item: linear time-weighted interpolation between prev/next anchors
  (same place stay -> prev==next so interpolation == snap, matches spec).
  One-sided -> snap to nearest anchor. No anchors at all -> unplaced.
- sequential place clustering on anchors (150m threshold).
"""
import json
import math
import os
import sys
from datetime import datetime

CLUSTER_M = 150.0


def haversine_m(a_lat, a_lon, b_lat, b_lon):
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = math.radians(b_lat - a_lat)
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def to_ts(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").timestamp()
    except (ValueError, TypeError):
        return None


def build(items):
    for m in items:
        m["_ts"] = to_ts(m.get("datetime"))
    dated = [m for m in items if m["_ts"] is not None]
    nodate = [m for m in items if m["_ts"] is None]
    dated.sort(key=lambda m: (m["_ts"], m["id"]))
    anchors = [m for m in dated if m["has_gps"]]

    # place clustering over anchors
    places = []
    for a in anchors:
        if places and haversine_m(a["lat"], a["lon"],
                                  places[-1]["lat"], places[-1]["lon"]) <= CLUSTER_M:
            p = places[-1]
            n = p["count"]
            p["lat"] = (p["lat"] * n + a["lat"]) / (n + 1)
            p["lon"] = (p["lon"] * n + a["lon"]) / (n + 1)
            p["count"] += 1
            p["end"] = a["datetime"]
            a["_place"] = p["id"]
        else:
            pid = f"p{len(places):03d}"
            places.append({"id": pid, "lat": a["lat"], "lon": a["lon"],
                           "count": 1, "start": a["datetime"], "end": a["datetime"]})
            a["_place"] = pid

    # anchor index in dated order for neighbour search
    anchor_pos = {id(m): k for k, m in enumerate(anchors)}
    dated_anchor_ts = sorted(m["_ts"] for m in anchors)

    out_items = []
    n_interp = n_prev = n_next = 0
    for m in dated:
        d = dict(m)
        if m["has_gps"]:
            d["d_lat"], d["d_lon"] = m["lat"], m["lon"]
            d["method"] = "gps"
            d["place"] = m.get("_place")
        else:
            prev = next_ = None
            for a in anchors:
                if a["_ts"] <= m["_ts"]:
                    if prev is None or a["_ts"] > prev["_ts"]:
                        prev = a
                if a["_ts"] >= m["_ts"]:
                    if next_ is None or a["_ts"] < next_["_ts"]:
                        next_ = a
            if prev and next_ and next_["_ts"] > prev["_ts"]:
                f = (m["_ts"] - prev["_ts"]) / (next_["_ts"] - prev["_ts"])
                d["d_lat"] = prev["lat"] + (next_["lat"] - prev["lat"]) * f
                d["d_lon"] = prev["lon"] + (next_["lon"] - prev["lon"]) * f
                d["method"] = "interpolated"
                d["between"] = [prev["id"], next_["id"]]
                n_interp += 1
            elif prev:
                d["d_lat"], d["d_lon"] = prev["lat"], prev["lon"]
                d["method"] = "prev_anchor"
                d["between"] = [prev["id"], prev["id"]]
                n_prev += 1
            elif next_:
                d["d_lat"], d["d_lon"] = next_["lat"], next_["lon"]
                d["method"] = "next_anchor"
                d["between"] = [next_["id"], next_["id"]]
                n_next += 1
            else:
                d["d_lat"] = d["d_lon"] = None
                d["method"] = "unplaced"
        d.pop("_ts", None)
        d.pop("_place", None)
        out_items.append(d)

    for m in nodate:
        d = dict(m)
        d.update({"d_lat": None, "d_lon": None, "method": "no_datetime"})
        d.pop("_ts", None)
        out_items.append(d)

    route = [[a["lon"], a["lat"]] for a in anchors]
    dist = sum(haversine_m(anchors[i]["lat"], anchors[i]["lon"],
                           anchors[i + 1]["lat"], anchors[i + 1]["lon"])
               for i in range(len(anchors) - 1))

    meta = {
        "total": len(items),
        "dated": len(dated),
        "no_datetime": len(nodate),
        "gps": len(anchors),
        "interpolated": n_interp,
        "prev_anchor": n_prev,
        "next_anchor": n_next,
        "unplaced": sum(1 for d in out_items if d["method"] in ("unplaced", "no_datetime")),
        "places": len(places),
        "route_km": round(dist / 1000, 2),
        "start": dated[0]["datetime"] if dated else None,
        "end": dated[-1]["datetime"] if dated else None,
    }
    return {"meta": meta, "places": places, "route": route, "items": out_items}


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "frontend/data/items.json"
    dst = sys.argv[2] if len(sys.argv) > 2 else "frontend/data/timeline.json"
    items = json.load(open(src, encoding="utf-8"))
    tl = build(items)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(tl, f, ensure_ascii=False, indent=1)
    print(f"meta={json.dumps(tl['meta'], ensure_ascii=False)} -> {dst}")
