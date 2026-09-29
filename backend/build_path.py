"""Path builder (per trip).

Rule (step-hold, no interpolation):
- GPS+time items are anchors.
- A time-only item sits AT the last anchor seen (held).
- If no earlier anchor exists, it sits at the next anchor (held_next).
- Nothing is placed mid-route between two anchors.
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
    dated = sorted([m for m in items if m["_ts"] is not None],
                   key=lambda m: (m["_ts"], m["id"]))
    nodate = [m for m in items if m["_ts"] is None]
    anchors = [m for m in dated if m["has_gps"]]

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

    out_items = []
    last_anchor = None
    for m in dated:
        d = dict(m)
        if m["has_gps"]:
            last_anchor = m
            d.update({"d_lat": m["lat"], "d_lon": m["lon"],
                      "method": "gps", "at": m["id"], "place": m.get("_place")})
        elif last_anchor is not None:
            d.update({"d_lat": last_anchor["lat"], "d_lon": last_anchor["lon"],
                      "method": "held", "at": last_anchor["id"]})
        else:
            nxt = next((a for a in anchors if a["_ts"] >= m["_ts"]), None)
            if nxt is not None:
                d.update({"d_lat": nxt["lat"], "d_lon": nxt["lon"],
                          "method": "held_next", "at": nxt["id"]})
            else:
                d.update({"d_lat": None, "d_lon": None, "method": "unplaced"})
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
        "held": sum(1 for d in out_items if d["method"] == "held"),
        "held_next": sum(1 for d in out_items if d["method"] == "held_next"),
        "unplaced": sum(1 for d in out_items if d["method"] in ("unplaced", "no_datetime")),
        "places": len(places),
        "route_km": round(dist / 1000, 2),
        "start": dated[0]["datetime"] if dated else None,
        "end": dated[-1]["datetime"] if dated else None,
    }
    return {"meta": meta, "places": places, "route": route, "items": out_items}


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "frontend/data/items.json"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "frontend/data/trips"
    items = json.load(open(src, encoding="utf-8"))
    by_trip = {}
    for m in items:
        by_trip.setdefault(m.get("trip", "main"), []).append(m)
    os.makedirs(out_dir, exist_ok=True)
    index = []
    for trip, ms in sorted(by_trip.items()):
        tl = build(ms)
        tl["trip"] = trip
        with open(os.path.join(out_dir, f"{trip}.json"), "w", encoding="utf-8") as f:
            json.dump(tl, f, ensure_ascii=False, indent=1)
        index.append({"id": trip, "name": trip, **tl["meta"]})
        print(f"trip={trip} meta={json.dumps(tl['meta'], ensure_ascii=False)}")
    with open(os.path.join(os.path.dirname(out_dir), "trips.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    print(f"index {len(index)} trips -> {out_dir}/../trips.json")
