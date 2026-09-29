let map, mapReady = false, TL, shown = [], idx = 0, timer = null, speed = 1;
let moverEl, mover, baseKind = "street", baseFailed = {};
const $ = id => document.getElementById(id);
const BASE_MS = 1500;

const LIBERTY = "https://tiles.openfreemap.org/styles/liberty";
const OFM_VECTOR = "https://tiles.openfreemap.org/planet";
const DEM_TILES = ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"];
const ESRI_SAT = ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"];
const MAP_LABEL = { street: "일반+3D건물", sat: "위성+3D건물", terrain: "지형(고도×2)" };
const MAP_ORDER = ["street", "sat", "terrain"];

const BUILD3D = (src) => ({
  id: "tm-build3d", type: "fill-extrusion", source: src, "source-layer": "building",
  minzoom: 14, filter: ["!=", ["get", "hide_3d"], true],
  paint: {
    "fill-extrusion-color": ["interpolate", ["linear"], ["get", "render_height"], 0, "#cfc8bd", 200, "#9fb3c8", 400, "#c8d8e8"],
    "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 14, 0, 15.5, ["get", "render_height"]],
    "fill-extrusion-base": ["case", [">=", ["get", "zoom"], 15.5], ["get", "render_min_height"], 0],
    "fill-extrusion-opacity": 0.85,
  },
});

function satStyle() {
  return { version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      esri: { type: "raster", tiles: ESRI_SAT, tileSize: 256, maxzoom: 19, attribution: "Esri World Imagery" },
      ofm: { type: "vector", url: OFM_VECTOR },
    },
    layers: [{ id: "esri", type: "raster", source: "esri" }, BUILD3D("ofm")],
  };
}
function styleFor(kind) { return kind === "sat" ? satStyle() : LIBERTY; }

// style (re)loaded: terrain + hillshade + trip layers
function setup3D() {
  try {
    if (!map.getSource("dem")) {
      map.addSource("dem", { type: "raster-dem", tiles: DEM_TILES, tileSize: 256, maxzoom: 15, encoding: "terrarium" });
    }
    map.setTerrain({ source: "dem", exaggeration: baseKind === "terrain" ? 2 : 1 });
    if (baseKind === "terrain" && !map.getLayer("tm-hill")) {
      map.addLayer({ id: "tm-hill", type: "hillshade", source: "dem",
        paint: { "hillshade-shadow-color": "#473B24" } });
    }
  } catch (e) { /* terrain optional */ }
  if (TL && shown.length) renderTripLayers();
}

function setBase(kind) {
  baseKind = kind;
  document.querySelectorAll(".mapbtn").forEach(b => b.classList.toggle("on", b.dataset.map === kind));
  try {
    map.setStyle(styleFor(kind));
    $("mapstatus").textContent = "지도: " + MAP_LABEL[kind];
  } catch (e) { onBaseError(kind); }
}
function onBaseError(kind) {
  if (baseFailed[kind]) return;
  baseFailed[kind] = true;
  const next = MAP_ORDER.find(k => !baseFailed[k]);
  if (next) { $("mapstatus").textContent = `지도 실패 → ${MAP_LABEL[next]}로 전환`; setBase(next); }
  else $("mapstatus").textContent = "지도 로드 실패 (네트워크 확인 필요)";
}

function emojiImage(emoji) { return emoji; } // mover uses text marker
const EMOJI = { walk: "🚶", transit: "🚇", plane: "✈️", ship: "🚢" };

// segment mode by speed between consecutive displayed items (ship = manual override only)
function segMode(a, b) {
  if (!a || !b) return ["walk", "🚶 체류"];
  if (b.method === "manual") return ["walk", "📍 " + (b.at || "직접지정")];
  if (b._ts <= a._ts) return ["walk", "🚶 체류"];
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

function dotColor(d) {
  if (d.type === "video") return "#e040fb";
  if (d.method === "gps") return "#ff9800";
  if (d.method === "manual") return "#64dd17";
  return d.method === "held_next" ? "#ab47bc" : "#29b6f6";
}

function renderTripLayers() {
  if (!mapReady || !map.isStyleLoaded()) return;
  for (const l of ["tm-route", "tm-photos", "tm-sel"]) if (map.getLayer(l)) map.removeLayer(l);
  for (const s of ["tm-route-src", "tm-photos-src", "tm-sel-src"]) if (map.getSource(s)) map.removeSource(s);
  const pts = routePoints();
  if (pts.length > 1) {
    map.addSource("tm-route-src", { type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: pts } } });
    map.addLayer({ id: "tm-route", type: "line", source: "tm-route-src",
      paint: { "line-color": "#ffd54f", "line-width": 3 } });
  }
  map.addSource("tm-photos-src", { type: "geojson",
    data: { type: "FeatureCollection", features: shown.map((d, i) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [d.d_lon, d.d_lat] },
      properties: { i, method: d.method, color: dotColor(d),
        size: (d.method === "gps" || d.method === "manual" || d.type === "video") ? 7 : 5 } })) } });
  map.addLayer({ id: "tm-photos", type: "circle", source: "tm-photos-src",
    paint: { "circle-radius": ["get", "size"], "circle-color": ["get", "color"],
      "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
  map.addSource("tm-sel-src", { type: "geojson",
    data: { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] } } });
  map.addLayer({ id: "tm-sel", type: "circle", source: "tm-sel-src",
    paint: { "circle-radius": 13, "circle-color": "rgba(255,255,255,0.35)",
      "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  applyFilter();
}

async function main() {
  map = new maplibregl.Map({ container: "map", style: styleFor("street"),
    center: [127.5, 36.5], zoom: 2, pitch: 0, attributionControl: true });
  if (map.setProjection) { try { map.setProjection({ type: "globe" }); } catch (e) {} }
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.on("load", () => { mapReady = true; setup3D(); });
  map.on("style.load", () => setup3D());
  map.on("error", () => { $("mapstatus").textContent = "지도 타일 오류 — 네트워크 확인"; });
  map.on("click", "tm-photos", e => { const f = e.features && e.features[0]; if (f) go(f.properties.i); });
  map.on("mouseenter", "tm-photos", () => map.getCanvas().style.cursor = "pointer");
  map.on("mouseleave", "tm-photos", () => map.getCanvas().style.cursor = "");

  moverEl = document.createElement("div");
  moverEl.className = "mover";
  moverEl.textContent = EMOJI.walk;
  moverEl.onclick = () => go(idx);
  mover = new maplibregl.Marker({ element: moverEl }).setLngLat([0, 0]).addTo(map);

  document.querySelectorAll(".mapbtn").forEach(b => b.onclick = () => { baseFailed = {}; setBase(b.dataset.map); });
  $("mapstatus").textContent = "지도: " + MAP_LABEL[baseKind];

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
  $("follow").onchange = () => { if ($("follow").checked) frameCurrent(); };
  $("close").onclick = () => $("panel").classList.add("hidden");
  $("manualBtn").onclick = () => $("manual").classList.toggle("hidden");
  $("mclose").onclick = () => $("manual").classList.add("hidden");
  $("msearch").onclick = mSearch;
  $("mq").onkeydown = e => { if (e.key === "Enter") mSearch(); };
  $("mapply").onclick = mApply;
  $("mexport").onclick = () => {
    if (!TL) return;
    const blob = new Blob([JSON.stringify(MANUAL[TL.trip] || [], null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${TL.trip}.manual.json`;
    a.click();
  };
  $("mimportBtn").onclick = () => $("mimport").click();
  $("mimport").onchange = e => {
    const f = e.target.files[0];
    if (!f || !TL) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const list = JSON.parse(rd.result);
        if (!Array.isArray(list)) throw new Error("배열 아님");
        MANUAL[TL.trip] = list;
        saveManual(); renderRules(); applyManual(); renderAll(idx);
      } catch (err) { $("mapstatus").textContent = "가져오기 실패: " + err; }
    };
    rd.readAsText(f);
    e.target.value = "";
  };
  showHome();
}

let API_OK = false;
async function api(path, method, body) {
  const r = await fetch(path, { method, headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j && j.error) || r.status);
  return j;
}
async function waitRebuild() {
  for (let i = 0; i < 120; i++) {
    try {
      const s = await api("/api/rebuild", "GET");
      $("tripNote").textContent = s.running ? "갱신 중..." : "";
      if (!s.running) return;
    } catch (e) { return; }
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function showHome() {
  stop();
  $("hud").classList.add("hidden");
  $("panel").classList.add("hidden");
  $("manual").classList.add("hidden");
  $("trips").classList.remove("hidden");
  $("tripname").textContent = "";
  $("tripNote").textContent = "";
  try { map.jumpTo({ center: [127.8, 36.3], zoom: 6.2, pitch: 0 }); } catch (e) {}
  let trips = [];
  API_OK = false;
  try { trips = await api("/api/trips", "GET"); API_OK = true; }
  catch (e) {
    try { trips = await (await fetch("data/trips.json")).json(); }
    catch (e2) { $("triplist").innerHTML = "data/trips.json 없음 — backend 파이프라인을 먼저 실행하세요."; return; }
    $("tripNote").textContent = "폴더 추가·이름변경·삭제 버튼은 python backend/server.py 로 실행해야 보입니다.";
  }
  $("tripAdd").classList.toggle("hidden", !API_OK);
  $("tripAdd").onclick = async () => {
    const name = (prompt("새 여행 폴더 이름") || "").trim();
    if (!name) return;
    try { await api("/api/trips", "POST", { name }); await waitRebuild(); showHome(); }
    catch (e) { $("tripNote").textContent = "추가 실패: " + e.message; }
  };
  $("triplist").innerHTML = "";
  if (!trips.length) $("triplist").innerHTML = "<small>여행 없음 — 새 폴더를 만들고 사진을 넣으세요.</small>";
  trips.forEach(t => {
    const row = document.createElement("div");
    row.className = "tcard";
    const b = document.createElement("button");
    b.className = "tripcard";
    b.innerHTML = `📁 ${t.name}<br><small>${t.total ?? "?"}장 · GPS ${t.gps ?? "?"} · ${t.route_km ?? "?"}km · ${t.start || "?"} ~ ${t.end || "?"}</small>`;
    b.onclick = () => openTrip(t.id);
    row.appendChild(b);
    if (API_OK && t.is_dir) {
      const rn = document.createElement("button");
      rn.className = "ticon"; rn.title = "이름 변경"; rn.textContent = "✏️";
      rn.onclick = async () => {
        const nn = ((prompt("새 폴더 이름", t.name)) || "").trim();
        if (!nn || nn === t.name) return;
        try {
          await api(`/api/trips/${encodeURIComponent(t.id)}`, "PATCH", { name: nn });
          if (MANUAL[t.id]) { MANUAL[nn] = MANUAL[t.id]; delete MANUAL[t.id]; saveManual(); }
          await waitRebuild(); showHome();
        } catch (e) { $("tripNote").textContent = "변경 실패: " + e.message; }
      };
      const del = document.createElement("button");
      del.className = "ticon danger"; del.title = "폴더 삭제"; del.textContent = "🗑️";
      del.onclick = async () => {
        if (!confirm(`'${t.name}' 폴더와 사진 ${t.total ?? "?"}장을 삭제할까?`)) return;
        try {
          await api(`/api/trips/${encodeURIComponent(t.id)}`, "DELETE");
          if (MANUAL[t.id]) { delete MANUAL[t.id]; saveManual(); }
          await waitRebuild(); showHome();
        } catch (e) { $("tripNote").textContent = "삭제 실패: " + e.message; }
      };
      row.appendChild(rn); row.appendChild(del);
    }
    $("triplist").appendChild(row);
  });
}

async function openTrip(id) {
  $("mapstatus").textContent = "여행 로딩 중...";
  try {
    TL = await (await fetch(`data/trips/${encodeURIComponent(id)}.json`)).json();
  } catch (e) {
    $("mapstatus").textContent = "여행 로드 실패: " + e;
    return;
  }
  TL.items.forEach(d => d._ts = d.datetime ? (Date.parse(d.datetime.replace(" ", "T")) || 0) : 0);
  shown = TL.items.filter(d => d.d_lat != null);
  loadManual();
  applyManual();
  $("trips").classList.add("hidden");
  $("hud").classList.remove("hidden");
  $("tripname").textContent = "📁 " + TL.trip;
  $("mapstatus").textContent = "지도: " + MAP_LABEL[baseKind];
  if (TL.meta.start) { $("mfrom").value = TL.meta.start.replace(" ", "T"); $("mto").value = TL.meta.end.replace(" ", "T"); }
  renderRules();
  snapMover = true; // 새 여행: 아이콘 점프 방지용 스냅
  renderAll(0);
  frameCurrent();
}

// anchor + manual route (no interpolation, ever)
function routePoints() {
  const pts = [];
  for (const d of shown) {
    if (d.method !== "gps" && d.method !== "manual") continue;
    const p = [d.d_lon, d.d_lat];
    const l = pts[pts.length - 1];
    if (!l || l[0] !== p[0] || l[1] !== p[1]) pts.push(p);
  }
  return pts;
}

function renderAll(startIdx) {
  renderTripLayers();
  const m = TL.meta;
  const c = { gps: 0, held: 0, held_next: 0, manual: 0 };
  shown.forEach(d => { if (c[d.method] !== undefined) c[d.method]++; });
  $("stats").textContent = `전체 ${m.total} · GPS ${c.gps} · 같은장소 ${c.held + c.held_next} · 직접 ${c.manual} · ${m.start} ~ ${m.end}`;
  $("scrub").max = shown.length - 1;
  go(Math.max(0, Math.min(startIdx, shown.length - 1)));
}

// ---- manual anchors (localStorage, GPS never overridden) ----
let MANUAL = {};
try { MANUAL = JSON.parse(localStorage.getItem("tm_manual") || "{}"); } catch (e) { MANUAL = {}; }
function saveManual() { try { localStorage.setItem("tm_manual", JSON.stringify(MANUAL)); } catch (e) {} }
function loadManual() { if (!MANUAL[TL.trip]) MANUAL[TL.trip] = []; }
function firstAnchorTs() { const a = shown.find(d => d.method === "gps"); return a ? a._ts : Infinity; }

function applyManual() {
  shown.forEach(d => { if (d._orig) { d.d_lat = d._orig.lat; d.d_lon = d._orig.lon; d.method = d._orig.method; d.at = d._orig.at; } });
  const rules = MANUAL[TL.trip] || [];
  const fat = firstAnchorTs();
  for (const r of rules) {
    for (const d of shown) {
      if (d.method === "gps") continue;
      const hit = r.mode === "before" ? (d._ts < fat)
        : r.mode === "current" ? (d.file === r.file)
        : (d._ts >= r.fromTs && d._ts <= r.toTs);
      if (!hit) continue;
      if (!d._orig) d._orig = { lat: d.d_lat, lon: d.d_lon, method: d.method, at: d.at };
      d.d_lat = r.lat; d.d_lon = r.lon; d.method = "manual"; d.at = r.name;
    }
  }
}

let MPLACE = null;
let glideRAF = null, snapMover = true;

// 아이콘을 선 따라 미끄러지듯 이동 (구간 시간에 맞춤)
function glideMover(to, durMs) {
  if (glideRAF) { cancelAnimationFrame(glideRAF); glideRAF = null; }
  let from = to;
  try { const c = mover.getLngLat(); if (c) from = [c.lng, c.lat]; } catch (e) {}
  if (snapMover || durMs <= 0 || (from[0] === to[0] && from[1] === to[1])) {
    mover.setLngLat(to);
    snapMover = false;
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const f = Math.min(1, (t - t0) / durMs);
    const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
    mover.setLngLat([from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e]);
    glideRAF = f < 1 ? requestAnimationFrame(step) : null;
  };
  glideRAF = requestAnimationFrame(step);
}
async function mSearch() {
  const q = $("mq").value.trim();
  if (!q) return;
  $("mresults").textContent = "검색 중...";
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=ko&q=${encodeURIComponent(q)}`);
    const list = await r.json();
    if (!list.length) { $("mresults").textContent = "결과 없음"; return; }
    $("mresults").innerHTML = "";
    list.forEach(p => {
      const b = document.createElement("button");
      b.className = "tripcard";
      b.innerHTML = `${p.display_name}<br><small>${p.lat}, ${p.lon}</small>`;
      b.onclick = () => mPick(p);
      $("mresults").appendChild(b);
    });
  } catch (e) { $("mresults").textContent = "검색 실패(네트워크): " + e; }
}
function mPick(p) {
  MPLACE = { name: (p.name || (p.display_name || "").split(",")[0] || "지정위치"), lat: +p.lat, lon: +p.lon, addr: p.display_name };
  $("mscope").classList.remove("hidden");
  $("mplace").innerHTML = `<b>${MPLACE.name}</b><br><small>${MPLACE.addr}</small>`;
  const cur = shown[idx];
  const mc = $("mcurN");
  mc.textContent = cur ? cur.file : "-";
  mc.title = cur ? cur.file : "";
  $("mbeforeN").textContent = shown.filter(d => d.method !== "gps" && d._ts < firstAnchorTs()).length;
}
function mApply() {
  if (!MPLACE || !TL) return;
  const mode = document.querySelector('input[name=mscope]:checked').value;
  const rules = MANUAL[TL.trip] || (MANUAL[TL.trip] = []);
  if (mode === "current") {
    const cur = shown[idx];
    if (!cur) return;
    if (cur.method === "gps") { $("mapstatus").textContent = "GPS 확정 사진은 지정할 필요 없음"; return; }
    rules.push({ mode, file: cur.file, name: MPLACE.name, lat: MPLACE.lat, lon: MPLACE.lon });
  } else if (mode === "before") {
    rules.push({ mode, name: MPLACE.name, lat: MPLACE.lat, lon: MPLACE.lon });
  } else {
    const f = $("mfrom").value, t = $("mto").value;
    if (!f || !t) { $("mapstatus").textContent = "시간 범위를 입력하세요"; return; }
    rules.push({ mode: "range", name: MPLACE.name, lat: MPLACE.lat, lon: MPLACE.lon, fromTs: Date.parse(f), toTs: Date.parse(t) });
  }
  saveManual(); renderRules(); applyManual(); renderAll(idx);
}
function renderRules() {
  const box = $("mrules");
  const rules = (TL && MANUAL[TL.trip]) || [];
  box.innerHTML = rules.length ? "" : "<small>없음</small>";
  rules.forEach((r, i) => {
    const div = document.createElement("div");
    div.className = "mrule";
    const scope = r.mode === "before" ? "첫 GPS 이전 전부"
      : r.mode === "current" ? `사진 1장: ${r.file || ""}`
      : `${new Date(r.fromTs).toLocaleString()} ~ ${new Date(r.toTs).toLocaleString()}`;
    div.innerHTML = `<span>📍 ${r.name}<br><small>${scope}</small></span>`;
    const del = document.createElement("button");
    del.textContent = "삭제";
    del.onclick = () => { rules.splice(i, 1); saveManual(); renderRules(); applyManual(); renderAll(idx); };
    div.appendChild(del);
    box.appendChild(div);
  });
}

function applyFilter() {
  if (!mapReady || !map.getLayer("tm-photos")) return;
  const show = $("showHeld").checked;
  map.setFilter("tm-photos", show ? null : ["==", ["get", "method"], "gps"]);
}

function mediaSrc(d, base) {
  return `${base}/sample/${encodeURIComponent(TL.trip)}/${encodeURIComponent(d.file)}`;
}
function badge(d) {
  const map = { gps: ["GPS확정", "gps"], held: ["같은장소", "held"], held_next: ["같은장소", "heldnext"], manual: ["직접지정", "man"] };
  const [t, c] = map[d.method] || [d.method, "bad"];
  return `<span class="badge ${c}">${t}</span>` + (d.type === "video" ? ' <span class="badge held">VIDEO</span>' : "");
}

function hopKm(a, b) {
  if (!a || !b) return 0;
  return Math.hypot((b.d_lon - a.d_lon) * 91, (b.d_lat - a.d_lat) * 111);
}
function zoomForHop(km) { return Math.max(8.5, Math.min(16, 16 - Math.log2(km + 1) * 1.6)); }

function go(i) {
  idx = Math.max(0, Math.min(shown.length - 1, i));
  // 레이어가 스타일 로드 타이밍에 밀려 없으면 복구
  if (TL && mapReady && map.isStyleLoaded() && !map.getLayer("tm-photos")) renderTripLayers();
  $("scrub").value = idx;
  const d = shown[idx];
  const [mode, label] = segMode(shown[idx - 1], d);
  moverEl.textContent = EMOJI[mode];
  const dur = Math.max(300, Math.min(1600, (BASE_MS / speed) * 0.9));
  glideMover([d.d_lon, d.d_lat], dur);
  const sel = map.getSource("tm-sel-src");
  if (sel) sel.setData({ type: "Feature", geometry: { type: "Point", coordinates: [d.d_lon, d.d_lat] } });
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
  if ($("follow").checked) {
    // 배속 적응 비행: 아이콘 활공과 같은 시간 → 끊김 없이 연속 이동
    const km = hopKm(shown[idx - 1], d);
    map.flyTo({ center: [d.d_lon, d.d_lat], zoom: zoomForHop(km), pitch: 62,
      duration: dur, essential: true });
  }
  // 다음 썸네일 미리 로드 (패널 깜빡임 완화)
  for (let k = 1; k <= 3; k++) {
    const n = shown[idx + k];
    if (n) { const im = new Image(); im.src = `data/thumbs/${n.thumb || n.id + ".jpg"}`; }
  }
}

// 현재 위치로 스냅 (애니메이션 없이 즉시)
function frameCurrent() {
  const d = shown[idx];
  if (!d) return;
  try { map.jumpTo({ center: [d.d_lon, d.d_lat], zoom: 15, pitch: 60 }); } catch (e) {}
}

function toggle() {
  if (timer) { stop(); return; }
  $("play").textContent = "⏸ 정지";
  timer = setInterval(() => { if (idx >= shown.length - 1) { stop(); return; } go(idx + 1); }, BASE_MS / speed);
}
function stop() { if (timer) { clearInterval(timer); timer = null; } const p = $("play"); if (p) p.textContent = "▶ 재생"; }

main().catch(e => { const t = $("triplist"); if (t) t.innerHTML = "초기화 실패: " + e; });
