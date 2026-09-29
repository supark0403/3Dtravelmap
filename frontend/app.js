let viewer, TL, shown = [], entities = [], mover = null, idx = 0, timer = null, speed = 1;
const $ = id => document.getElementById(id);
const BASE_MS = 1500;

const MAPS = {
  street: () => new Cesium.ArcGisMapServerImageryProvider({ url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer" }),
  sat: () => new Cesium.ArcGisMapServerImageryProvider({ url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer" }),
  osm: () => new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }),
};
const MAP_LABEL = { street: "일반지도(Esri)", sat: "위성(Esri)", osm: "OSM" };
let mapKind = "street", mapFailed = {}, errCount = 0;

function gridFallback() { return new Cesium.GridImageryProvider(); }

function emojiImage(emoji) {
  const c = document.createElement("canvas"); c.width = c.height = 72;
  const g = c.getContext("2d"); g.font = "56px serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(emoji, 36, 40);
  return c.toDataURL();
}
const EMOJI = { walk: emojiImage("🚶"), transit: emojiImage("🚇"), plane: emojiImage("✈️"), ship: emojiImage("🚢") };

// segment mode by speed between consecutive displayed items (ship = manual override only)
function segMode(a, b) {
  if (!a || !b || b._ts <= a._ts) return ["walk", "🚶 체류"];
  const R = 6371, p1 = a.d_lat * Math.PI / 180, p2 = b.d_lat * Math.PI / 180;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((b.d_lon - a.d_lon) * Math.PI / 180) / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(h));
  const hrs = (b._ts - a._ts) / 3600;
  const v = km / hrs;
  if (b.transport === "ship" || a.transport === "ship") return ["ship", "🚢 배"];
  if (v > 250) return ["plane", "✈️ 비행기"];
  if (v > 12) return ["transit", "🚇 탈것"];
  return ["walk", "🚶 도보/체류"];
}

function setImagery(kind) {
  mapKind = kind;
  document.querySelectorAll(".mapbtn").forEach(b => b.classList.toggle("on", b.dataset.map === kind));
  let p = null;
  try { p = MAPS[kind](); } catch (e) { p = null; }
  if (!p) { onMapError(kind); return; }
  errCount = 0;
  try {
    p.errorEvent.addEventListener(() => { if (++errCount >= 5) onMapError(kind); });
  } catch (e) { /* provider without errorEvent */ }
  const layers = viewer.imageryLayers;
  layers.removeAll();
  layers.addImageryProvider(p);
  $("mapstatus").textContent = "지도: " + MAP_LABEL[kind];
}
function onMapError(kind) {
  if (mapFailed[kind]) return;
  mapFailed[kind] = true;
  const next = ["street", "sat", "osm"].find(k => !mapFailed[k]);
  if (next) {
    $("mapstatus").textContent = `지도(${MAP_LABEL[kind]}) 실패 → ${MAP_LABEL[next]}로 전환`;
    setImagery(next);
  } else {
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(gridFallback());
    $("mapstatus").textContent = "온라인 지도 실패 → 오프라인 격자로 표시 (네트워크 확인 필요)";
  }
}

async function main() {
  let bootProvider = null;
  for (const k of ["street", "sat", "osm"]) {
    try { bootProvider = MAPS[k](); mapKind = k; break; } catch (e) { /* next */ }
  }
  viewer = new Cesium.Viewer("cesium", {
    imageryProvider: bootProvider || gridFallback(),
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    geocoder: false, baseLayerPicker: false, sceneModePicker: true,
    timeline: false, animation: false, infoBox: false, selectionIndicator: false,
  });
  document.querySelectorAll(".mapbtn").forEach(b => b.onclick = () => { mapFailed = {}; setImagery(b.dataset.map); });
  setImagery(mapKind);

  const h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  h.setInputAction(c => {
    const p = viewer.scene.pick(c.position);
    if (p && p.id && p.id._i !== undefined) go(p.id._i);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  $("home").onclick = showHome;
  $("prev").onclick = () => go(idx - 1);
  $("next").onclick = () => go(idx + 1);
  $("first").onclick = () => go(0);
  $("play").onclick = toggle;
  $("scrub").oninput = e => go(+e.target.value);
  document.querySelectorAll("#speeds button").forEach(b => b.onclick = () => {
    speed = +b.dataset.s;
    document.querySelectorAll("#speeds button").forEach(x => x.classList.toggle("on", x === b));
    if (timer) { stop(); toggle(); }
  });
  $("showHeld").onchange = applyFilter;
  $("close").onclick = () => $("panel").classList.add("hidden");
  showHome();
}

async function showHome() {
  stop();
  $("hud").classList.add("hidden");
  $("panel").classList.add("hidden");
  $("trips").classList.remove("hidden");
  $("tripname").textContent = "";
  let trips = [];
  try { trips = await (await fetch("data/trips.json")).json(); }
  catch (e) { $("triplist").innerHTML = "data/trips.json 없음 — backend 파이프라인을 먼저 실행하세요."; return; }
  $("triplist").innerHTML = "";
  trips.forEach(t => {
    const b = document.createElement("button");
    b.className = "tripcard";
    b.innerHTML = `📁 ${t.name}<br><small>${t.total}장 · GPS ${t.gps} · ${t.route_km}km · ${t.start || "?"} ~ ${t.end || "?"}</small>`;
    b.onclick = () => openTrip(t.id);
    $("triplist").appendChild(b);
  });
}

async function openTrip(id) {
  TL = await (await fetch(`data/trips/${encodeURIComponent(id)}.json`)).json();
  TL.items.forEach(d => d._ts = Date.parse(d.datetime.replace(" ", "T")) || 0);
  shown = TL.items.filter(d => d.d_lat != null);
  viewer.entities.removeAll();
  entities = [];
  $("trips").classList.add("hidden");
  $("hud").classList.remove("hidden");
  $("tripname").textContent = "📁 " + TL.trip;

  if (TL.route.length > 1)
    viewer.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray(TL.route.flat()), width: 3, material: Cesium.Color.GOLD } });
  shown.forEach((d, i) => {
    const gps = d.method === "gps";
    entities.push(viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(d.d_lon, d.d_lat, gps ? 60 : 30),
      point: { pixelSize: gps ? 10 : 6,
        color: d.type === "video" ? Cesium.Color.MAGENTA : (gps ? Cesium.Color.ORANGE : (d.method === "held_next" ? Cesium.Color.PURPLE : Cesium.Color.DEEPSKYBLUE)),
        outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
      _i: i,
    }));
  });
  mover = viewer.entities.add({ position: Cesium.Cartesian3.fromDegrees(shown[0].d_lon, shown[0].d_lat, 120),
    billboard: { image: EMOJI.walk, scale: 0.9, verticalOrigin: Cesium.VerticalOrigin.BOTTOM }, _i: 0 });

  const m = TL.meta;
  $("stats").textContent = `전체 ${m.total} · GPS ${m.gps} · 같은장소배치 ${m.held + m.held_next} · ${m.route_km}km · ${m.start} ~ ${m.end}`;
  $("scrub").max = shown.length - 1;
  applyFilter();
  go(0);
  viewer.flyTo(viewer.entities);
}

function applyFilter() {
  const show = $("showHeld").checked;
  entities.forEach((e, i) => { e.show = show || shown[i].method === "gps"; });
  if (mover) mover.show = true;
}

function mediaSrc(d, base) {
  return `${base}/sample/${encodeURIComponent(TL.trip)}/${encodeURIComponent(d.file)}`;
}
function badge(d) {
  const map = { gps: ["GPS확정", "gps"], held: ["같은장소", "held"], held_next: ["같은장소", "heldnext"] };
  const [t, c] = map[d.method] || [d.method, "bad"];
  return `<span class="badge ${c}">${t}</span>` + (d.type === "video" ? ' <span class="badge held">VIDEO</span>' : "");
}

function go(i) {
  idx = Math.max(0, Math.min(shown.length - 1, i));
  $("scrub").value = idx;
  const d = shown[idx];
  const [mode, label] = segMode(shown[idx - 1], d);
  mover.position = Cesium.Cartesian3.fromDegrees(d.d_lon, d.d_lat, 120);
  mover.billboard.image = EMOJI[mode];
  mover._i = idx;
  $("cur").textContent = `#${idx + 1}/${shown.length} · ${d.datetime} · ${label} · ${d.file}`;
  const thumb = `data/thumbs/${d.thumb || d.id + ".jpg"}`;
  const fb = `../sample/${encodeURI(d.file)}`;
  const primary = mediaSrc(d, "..");
  $("media").innerHTML = d.type === "video"
    ? `<video controls poster="${thumb}"><source src="${primary}"><source src="${fb}"></video>`
    : `<img src="${thumb}" alt="">`;
  const img = $("media").querySelector("img");
  if (img) img.onerror = () => { img.onerror = () => { img.onerror = null; img.src = fb; }; img.src = primary; };
  $("info").innerHTML = `${badge(d)}<br>시간: ${d.datetime}<br>이동: ${label}<br>배치: ${d.at || "-"} @ ${d.d_lat.toFixed(5)}, ${d.d_lon.toFixed(5)}<br>파일: ${d.file}`;
  $("panel").classList.remove("hidden");
  entities.forEach((e, k) => { e.point.pixelSize = k === idx ? 16 : (shown[k].method === "gps" ? 10 : 6); });
  if ($("follow").checked)
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(d.d_lon, d.d_lat, 1500), duration: 1.2 });
}

function toggle() {
  if (timer) { stop(); return; }
  $("play").textContent = "⏸ 정지";
  timer = setInterval(() => { if (idx >= shown.length - 1) { stop(); return; } go(idx + 1); }, BASE_MS / speed);
}
function stop() { if (timer) { clearInterval(timer); timer = null; } $("play").textContent = "▶ 재생"; }

main().catch(e => { $("triplist").innerHTML = "초기화 실패: " + e; });
