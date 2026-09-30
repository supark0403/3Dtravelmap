let map, mapReady = false, TL, shown = [], idx = 0, timer = null, speed = 1;
let moverPos = [0, 0], moverIcon = "walk";
let baseKind = "street", baseFailed = {};
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
    applyBuildings();
  registerMoverIcons();
  } catch (e) { /* terrain optional */ }
  if (TL && shown.length) renderTripLayers();
}

let buildingsOn = true;
function applyBuildings() {
  for (const id of ["building-3d", "tm-build3d"]) {
    try { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", buildingsOn ? "visible" : "none"); } catch (e) {}
  }
  document.querySelectorAll('[data-map="bld"]').forEach(b => b.classList.toggle("on", buildingsOn));
}
function setBase(kind) {
  baseKind = kind;
  document.querySelectorAll(".mapbtn").forEach(b => { if (b.dataset.map !== "bld") b.classList.toggle("on", b.dataset.map === kind); });
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

const EMO_ICONS = { walk: "🚶", transit: "🚇", plane: "✈️", ship: "🚢", bed: "🛏️", sleep: "🛌" };
function emoImage(emoji) {
  const c = document.createElement("canvas");
  c.width = c.height = 96;
  const g = c.getContext("2d");
  g.font = "78px serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(emoji, 48, 52);
  return g.getImageData(0, 0, 96, 96);
}
function registerMoverIcons() {
  try {
    for (const [k, e] of Object.entries(EMO_ICONS)) {
      if (!map.hasImage("mv-" + k)) map.addImage("mv-" + k, emoImage(e));
    }
  } catch (err) {}
}

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
  for (const l of ["tm-route", "tm-photos", "tm-sel", "tm-mover", "tm-days"]) if (map.getLayer(l)) map.removeLayer(l);
  for (const s of ["tm-route-src", "tm-photos-src", "tm-sel-src", "tm-mover-src", "tm-days-src"]) if (map.getSource(s)) map.removeSource(s);
  // 날짜별 그룹 (shown은 시간순)
  const groups = [];
  let curDate = null;
  shown.forEach((d, i) => {
    const dt = (d.datetime || "").slice(0, 10);
    if (dt !== curDate) { groups.push([]); curDate = dt; }
    groups[groups.length - 1].push({ d, i });
  });
  // 날짜별 경로 조각: 앵커 전체를 시간순으로 이으면서 일차마다 색 다르게
  // (앵커 1개뿐인 날도 앞 점과 연결되어 선이 끊기지 않음)
  const DAY_COLORS = ["#2196f3", "#ff9800", "#e040fb", "#64dd17", "#ff5252", "#00bcd4", "#ffee58"];
  const segFeats = [];
  let prev = null;
  groups.forEach((g, n) => {
    const mine = [];
    for (const { d } of g) {
      if (d.method !== "gps" && d.method !== "manual") continue;
      const p = [d.d_lon, d.d_lat];
      const l = mine.length ? mine[mine.length - 1] : prev;
      if (!l || l[0] !== p[0] || l[1] !== p[1]) mine.push(p);
    }
    if (mine.length) {
      const coords = prev ? [prev, ...mine] : mine;
      if (coords.length > 1) {
        segFeats.push({ type: "Feature",
          properties: { color: DAY_COLORS[n % DAY_COLORS.length], day: n + 1 },
          geometry: { type: "LineString", coordinates: coords } });
      }
      prev = mine[mine.length - 1];
    }
  });
  map.addSource("tm-route-src", { type: "geojson",
    data: { type: "FeatureCollection", features: segFeats } });
  if (segFeats.length) {
    map.addLayer({ id: "tm-route", type: "line", source: "tm-route-src",
      layout: { "line-cap": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 3,
        "line-dasharray": [2.5, 2, 0.1, 2] } });
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
  // 이동 아이콘: 캔버스 래스터 이미지 심볼 (이모지는 SDF 글리프에 없어 텍스트로 안 나옴)
  map.addSource("tm-mover-src", { type: "geojson",
    data: { type: "Feature", geometry: { type: "Point", coordinates: moverPos },
      properties: { icon: "mv-" + moverIcon } } });
  map.addLayer({ id: "tm-mover", type: "symbol", source: "tm-mover-src",
    layout: { "icon-image": ["get", "icon"], "icon-size": 1,
      "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-offset": [0, -14] } });
  // 날짜 경계: 해당 일차 첫 사진에 N일차 라벨 (1일차=공항, 이후=숙소)
  map.addSource("tm-days-src", { type: "geojson",
    data: { type: "FeatureCollection", features: groups.map((g, n) => {
      const first = g[0];
      return { type: "Feature", geometry: { type: "Point", coordinates: [first.d.d_lon, first.d.d_lat] },
        properties: { i: first.i, label: n === 0 ? "공항" : "숙소" } };
    }) } });
  map.addLayer({ id: "tm-days", type: "symbol", source: "tm-days-src",
    layout: { "text-field": ["get", "label"], "text-size": 14, "text-offset": [0, -1.6],
      "text-allow-overlap": true, "text-font": ["Noto Sans Bold"] },
    paint: { "text-color": "#111", "text-halo-color": "#fff", "text-halo-width": 2 } });
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
  map.on("click", e => {
    const fs = map.queryRenderedFeatures(e.point, { layers: ["tm-days", "tm-photos", "tm-mover"] });
    const f = fs && fs[0];
    if (f && f.properties && f.properties.i !== undefined) go(+f.properties.i);
    else if (f && f.source === "tm-mover-src") go(idx);
  });
  for (const l of ["tm-photos", "tm-days", "tm-mover"]) {
    map.on("mouseenter", l, () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", l, () => map.getCanvas().style.cursor = "");
  }

  document.querySelectorAll(".mapbtn").forEach(b => b.onclick = () => {
    if (b.dataset.map === "bld") { buildingsOn = !buildingsOn; applyBuildings(); return; }
    baseFailed = {}; setBase(b.dataset.map);
  });
  $("mapstatus").textContent = "지도: " + MAP_LABEL[baseKind];

  $("home").onclick = showHome;
  $("localOpen").onclick = async () => {
    if (window.showDirectoryPicker) {
      try {
        const files = await pickLocalFolderFS();
        if (files && files.length) { loadLocalFiles(files); return; }
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return; // 취소
        $("tripNote").textContent = "폴더 열기 실패, 읽기 전용으로 시도: " + (e.message || e);
      }
    }
    $("localPick").click();
  };
  async function loadLocalFiles(files) {
    try {
      await parseLocalFiles(files, (a, b) => { $("tripNote").textContent = `읽는 중 ${a}/${b}...`; });
      showHome();
    } catch (err) { $("tripNote").textContent = "읽기 실패: " + err.message; }
  }
  $("localPick").onchange = async e => {
    const files = e.target.files;
    e.target.value = "";
    if (!files || !files.length) return;
    LOCAL.write = false;
    loadLocalFiles(files);
  };
  $("prev").onclick = () => nav(idx - 1);
  $("next").onclick = () => nav(idx + 1);
  $("first").onclick = () => nav(0);
  $("play").onclick = toggle;
  $("scrub").oninput = e => nav(+e.target.value);
  const setSpeed = (v) => {
    speed = Math.max(0.1, Math.min(8, +v || 1));
    $("speedSlider").value = speed;
    $("speedVal").textContent = speed.toFixed(1) + "x";
    if (timer) { stop(); toggle(); }
  };
  $("speedSlider").oninput = e => setSpeed(e.target.value);
  $("speedReset").onclick = () => setSpeed(1);
  $("showHeld").onchange = applyFilter;
  $("follow").onchange = () => { if ($("follow").checked) frameCurrent(); };
  $("close").onclick = () => $("panel").classList.add("hidden");
  try { panelMin = localStorage.getItem("tm_panel_min") === "1"; } catch (e) {}
  applyPanelMin();
  $("minbtn").onclick = () => { panelMin = !panelMin; applyPanelMin(); };
  initPanelDrag();
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

// 사진 패널 드래그 이동 (위치 기억)
function initPanelDrag() {
  const el = $("panel");
  try {
    const saved = JSON.parse(localStorage.getItem("tm_panel_pos") || "null");
    if (saved && +saved.top >= 0 && +saved.left >= 0) {
      el.style.top = saved.top + "px"; el.style.left = saved.left + "px"; el.style.right = "auto";
    }
  } catch (e) {}
  let sx, sy, ox, oy, dragging = false;
  el.addEventListener("mousedown", (e) => {
    if (e.target.closest("button,input,img,video,a,select,textarea")) return;
    dragging = true; sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
    el.style.left = ox + "px"; el.style.top = oy + "px"; el.style.right = "auto";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    el.style.left = Math.max(0, ox + e.clientX - sx) + "px";
    el.style.top = Math.max(0, oy + e.clientY - sy) + "px";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return; dragging = false;
    try { localStorage.setItem("tm_panel_pos", JSON.stringify({ left: parseInt(el.style.left, 10), top: parseInt(el.style.top, 10) })); } catch (e) {}
  });
}

async function showHome() {
  stop();
  $("hud").classList.add("hidden");
  $("panel").classList.add("hidden");
  $("manual").classList.add("hidden");
  $("trips").classList.remove("hidden");
  $("daybadge").classList.add("hidden");
  $("tripname").textContent = "";
  $("tripNote").textContent = "";
  $("localPath").textContent = LOCAL.root ? "📁 " + LOCAL.root : "";
  try { map.jumpTo({ center: [127.8, 36.3], zoom: 6.2, pitch: 0 }); } catch (e) {}
  $("triplist").innerHTML = "";
  if (!LOCAL.order.length) {
    $("triplist").innerHTML = "<small>📂 내 폴더 열기로 로컬 travel 폴더를 지정하세요 (사진은 브라우저에서만 읽고 업로드되지 않음)</small>";
    return;
  }
  // 여행 시작일 순 정렬 (오래된 것 위로, 날짜 없음은 아래로)
  LOCAL.order.sort((x, y) => String(LOCAL.trips[x].meta.start || "~").localeCompare(String(LOCAL.trips[y].meta.start || "~")));
  LOCAL.order.forEach(n => {
    const m = LOCAL.trips[n].meta;
    const row = document.createElement("div");
    row.className = "tcard";
    const b = document.createElement("button");
    b.className = "tripcard";
    b.innerHTML = `📂 ${n} (내 폴더)<br><small>${m.total}장 · GPS ${m.gps} · ${m.route_km}km · ${m.start || "?"} ~ ${m.end || "?"}</small>`;
    b.onclick = () => openLocalTrip(n);
    row.appendChild(b);
    $("triplist").appendChild(row);
  });
}

function openLocalTrip(name) {
  enterTrip(LOCAL.trips[name], "📂 " + name + " (내 폴더)");
}

function enterTrip(tl, label) {
  stop();
  seenDays.clear();
  shownDay = null;
  TL = tl;
  TL.items.forEach(d => { if (d._ts === undefined) d._ts = d.datetime ? (Date.parse(d.datetime.replace(" ", "T")) || 0) : 0; });
  loadManual();
  // 직접지정 규칙이 있으면 미배치 항목도 후보에 포함 (앵커 체인에서 배치될 수 있음)
  const hasManual = (MANUAL[TL.trip] || []).length > 0;
  shown = TL.items.filter(d => d.d_lat != null || (hasManual && d._ts));
  applyManual();
  $("trips").classList.add("hidden");
  $("hud").classList.remove("hidden");
  $("tripname").textContent = label;
  $("daybadge").classList.remove("hidden");
  $("mapstatus").textContent = "지도: " + MAP_LABEL[baseKind];
  if (TL.meta.start) { $("mfrom").value = TL.meta.start.replace(" ", "T"); $("mto").value = TL.meta.end.replace(" ", "T"); }
  renderRules();
  snapMover = true; // 새 여행: 아이콘 점프 방지용 스냅
  renderAll(0);
  frameCurrent();
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
  // 원복 (GPS는 절대 손대지 않음)
  shown.forEach(d => { if (d._orig) { d.d_lat = d._orig.lat; d.d_lon = d._orig.lon; d.method = d._orig.method; d.at = d._orig.at; } delete d._rule; });
  const rules = MANUAL[TL.trip] || [];
  const fat = firstAnchorTs();
  // 1) 사진별 직접지정 매칭
  const match = new Map();
  for (const d of shown) {
    if (d.method === "gps") continue;
    for (const r of rules) {
      const hit = r.mode === "before" ? (d._ts < fat)
        : r.mode === "current" ? (d.file === r.file)
        : (d._ts >= r.fromTs && d._ts <= r.toTs);
      if (hit) { match.set(d, r); break; }
    }
  }
  // 2) 시간순 앵커 체인 재계산: GPS + 직접지정이 모두 앵커, 나머지는 직전 앵커에 hold
  const order = [...shown].sort((a, b) => (a._ts - b._ts) || (a.id < b.id ? -1 : 1));
  const anchorOf = (d) => {
    if (d.method === "gps") return { lat: d.d_lat, lon: d.d_lon, label: d.id, ref: null };
    const r = match.get(d);
    return r ? { lat: r.lat, lon: r.lon, label: r.name, ref: r } : null;
  };
  const nextAnchor = new Array(order.length).fill(null);
  let nxt = null;
  for (let i = order.length - 1; i >= 0; i--) { nextAnchor[i] = nxt; const a = anchorOf(order[i]); if (a) nxt = a; }
  const stamp = (d, lat, lon, method, at) => {
    if (!d._orig) d._orig = { lat: d.d_lat, lon: d.d_lon, method: d.method, at: d.at };
    d.d_lat = lat; d.d_lon = lon; d.method = method; d.at = at;
  };
  let cur = null;
  order.forEach((d, i) => {
    const a = anchorOf(d);
    if (a && d.method === "gps") { cur = a; return; }
    if (a) { stamp(d, a.lat, a.lon, "manual", a.label); cur = a; d._rule = a.ref; }
    else if (cur) stamp(d, cur.lat, cur.lon, "held", cur.label);
    else if (nextAnchor[i]) { const na = nextAnchor[i]; stamp(d, na.lat, na.lon, "held_next", na.label); }
    else stamp(d, null, null, "unplaced", null);
  });
  // 앵커가 하나도 없어 못 놓은 항목은 제외 (null 방어)
  shown = shown.filter(d => d.d_lat != null);
}

let MPLACE = null;
let glideRAF = null, snapMover = true;

// 이동 아이콘 상태 → 심볼 레이어 반영
function setMover(pos, icon) {
  moverPos = pos;
  if (icon !== undefined) moverIcon = icon;
  try {
    const s = mapReady && map.getSource("tm-mover-src");
    if (s) s.setData({ type: "Feature", geometry: { type: "Point", coordinates: moverPos },
      properties: { icon: "mv-" + moverIcon } });
  } catch (e) {}
}
function setMoverSize(px) {
  try { if (mapReady && map.getLayer("tm-mover")) map.setLayoutProperty("tm-mover", "icon-size", px); } catch (e) {}
}

// 아이콘을 선 따라 미끄러지듯 이동 (구간 시간에 맞춤)
function glideMover(to, durMs, icon) {
  if (glideRAF) { cancelAnimationFrame(glideRAF); glideRAF = null; }
  const from = moverPos.slice();
  if (icon !== undefined) moverIcon = icon;
  if (snapMover || durMs <= 0 || (from[0] === to[0] && from[1] === to[1])) {
    setMover(to);
    snapMover = false;
    if ($("follow").checked) { try { map.jumpTo({ center: to }); } catch (e) {} }
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const f = Math.min(1, (t - t0) / durMs);
    const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
    const lng = from[0] + (to[0] - from[0]) * e, lat = from[1] + (to[1] - from[1]) * e;
    setMover([lng, lat]);
    // 시점 고정: 매 프레임 아이콘 위치로 (딜레이 없음)
    if ($("follow").checked) { try { map.jumpTo({ center: [lng, lat] }); } catch (err) {} }
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
  let nr = null;
  if (mode === "current") {
    const cur = shown[idx];
    if (!cur) return;
    if (cur.method === "gps") { $("mapstatus").textContent = "GPS 확정 사진은 지정할 필요 없음"; return; }
    nr = { mode, file: cur.file, name: MPLACE.name, lat: MPLACE.lat, lon: MPLACE.lon };
  } else if (mode === "before") {
    nr = { mode, name: MPLACE.name, lat: MPLACE.lat, lon: MPLACE.lon };
  } else {
    const f = $("mfrom").value, t = $("mto").value;
    if (!f || !t) { $("mapstatus").textContent = "시간 범위를 입력하세요"; return; }
    nr = { mode: "range", name: MPLACE.name, lat: MPLACE.lat, lon: MPLACE.lon, fromTs: Date.parse(f), toTs: Date.parse(t) };
  }
  rules.push(nr);
  saveManual(); renderRules(); applyManual(); renderAll(idx);
  writeBackFor(nr);
}
async function writeBackFor(rule) {
  const box = $("mwrite");
  if (!box) return;
  const targets = shown.filter(d => d._rule === rule);
  const jpegs = targets.filter(d => /\.jpe?g$/i.test(d.file || "") && d._handle);
  const skip = targets.length - jpegs.length;
  if (typeof piexif === "undefined") { box.textContent = "원본 기록 불가: piexif 로드 실패"; return; }
  if (!LOCAL.write) { box.textContent = `원본 기록 불가: 쓰기 권한 없음(폴더를 다시 열어 허용) · ${targets.length}장 화면에만 적용`; return; }
  if (!jpegs.length) { box.textContent = `원본 기록: JPEG 아님 ${skip}장 제외, 화면에만 적용`; return; }
  let ok = 0, fail = 0;
  for (const d of jpegs) {
    try {
      await writeGpsExif(d._handle, rule.lat, rule.lon);
      d.has_gps = true; d.lat = rule.lat; d.lon = rule.lon;
      d._orig = { lat: rule.lat, lon: rule.lon, method: "gps", at: d.id };
      ok++;
    } catch (e) { fail++; }
    box.textContent = `원본 기록 중 ${ok + fail}/${jpegs.length}...`;
  }
  applyManual(); renderAll(idx);
  box.textContent = `원본 기록 완료: 성공 ${ok}${fail ? `, 실패 ${fail}` : ""}${skip ? `, 제외 ${skip}` : ""} — GPS 앵커 승격`;
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

function badge(d) {
  const map = { gps: ["GPS확정", "gps"], held: ["같은장소", "held"], held_next: ["같은장소", "heldnext"], manual: ["직접지정", "man"] };
  const [t, c] = map[d.method] || [d.method, "bad"];
  return `<span class="badge ${c}">${t}</span>` + (d.type === "video" ? ' <span class="badge held">VIDEO</span>' : "");
}

function hopKm(a, b) {
  if (!a || !b) return 0;
  return Math.hypot((b.d_lon - a.d_lon) * 91, (b.d_lat - a.d_lat) * 111);
}

let panelMin = false;
function applyPanelMin() {
  $("panel").classList.toggle("min", panelMin);
  const b = $("minbtn"); if (b) b.textContent = panelMin ? "□" : "–";
  try { localStorage.setItem("tm_panel_min", panelMin ? "1" : "0"); } catch (e) {}
}

let shownDay = null;
function go(i) {
  idx = Math.max(0, Math.min(shown.length - 1, i));
  // 레이어가 스타일 로드 타이밍에 밀려 없으면 복구
  if (TL && mapReady && map.isStyleLoaded() && !map.getLayer("tm-photos")) renderTripLayers();
  $("scrub").value = idx;
  const d = shown[idx];
  const [mode, label] = segMode(shown[idx - 1], d);
  const dur0 = Math.max(300, Math.min(1600, (BASE_MS / speed) * 0.9));
  // 장거리(5km+)는 절반 속도로 천천히
  const dur = hopKm(shown[idx - 1], d) > 5 ? Math.min(dur0 * 2, 3000) : dur0;
  glideMover([d.d_lon, d.d_lat], dur, mode);
  const sel = map.getSource("tm-sel-src");
  if (sel) sel.setData({ type: "Feature", geometry: { type: "Point", coordinates: [d.d_lon, d.d_lat] } });
  $("cur").textContent = `#${idx + 1}/${shown.length} · ${d.datetime} · ${label} · ${d.file}`;
  const dk = dayKey(idx);
  if (dk !== shownDay) { shownDay = dk; $("daybadge").textContent = dayNum(idx) + "일차"; }
  const isHeic = /\.(heic|heif)$/i.test(d.file || "");
  if (d.type === "photo" && isHeic) {
    $("media").innerHTML = `<div class="heic">HEIC 미리보기 미지원<br><small>${d.file}</small><br><a href="${d.u}" download="${d.file}">원본 다운로드</a></div>`;
  } else if (d.type === "video") {
    $("media").innerHTML = `<video controls src="${d.u}"></video>`;
  } else {
    $("media").innerHTML = `<img src="${d.u}" alt="">`;
  }
  $("info").innerHTML = `${badge(d)}<br>시간: ${d.datetime}<br>이동: ${label}<br>배치: ${d.at || "-"} @ ${d.d_lat.toFixed(5)}, ${d.d_lon.toFixed(5)}<br>파일: ${d.file}`;
  $("panel").classList.remove("hidden");
  // 카메라는 glideMover 프레임에서 아이콘에 고정 (flyTo 없음 → 딜레이 없음)
  // 다음 썸네일 미리 로드 (패널 깜빡임 완화)
  for (let k = 1; k <= 3; k++) {
    const n = shown[idx + k];
    if (n && n.u) { const im = new Image(); im.src = n.u; }
  }
}

// 현재 위치로 스냅 (애니메이션 없이 즉시)
function frameCurrent() {
  const d = shown[idx];
  if (!d) return;
  try { map.jumpTo({ center: [d.d_lon, d.d_lat], zoom: 15, pitch: 60 }); } catch (e) {}
}

function toggle() {
  if (playing) { stop(); return; }
  playing = true;
  $("play").textContent = "⏸ 정지";
  if (isDayStart(idx) && !seenDays.has(dayKey(idx))) interlude(idx, false);
  else startTimer();
}
function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(stepOnce, BASE_MS / speed);
}
function stepOnce() {
  if (idx >= shown.length - 1) { stop(); return; }
  const next = idx + 1;
  if (isDayStart(next) && !seenDays.has(dayKey(next))) { interlude(next, true); return; }
  go(next);
}
function stop() {
  playing = false;
  if (timer) { clearInterval(timer); timer = null; }
  cancelInterlude();
  const p = $("play"); if (p) p.textContent = "▶ 재생";
}

// ---- 일차 시작 인터루드: 기상 + 가방싸기 (배속 무시 고정시간, 사진 정지) ----
let playing = false, interludeTO = null, wakeInt = null, pendingInter = null;
const seenDays = new Set();
const INTERLUDE_MS = 2400;
function dayKey(i) { const d = shown[i]; return d ? (d.datetime || "").slice(0, 10) : ""; }
function isDayStart(i) { return i <= 0 || dayKey(i) !== dayKey(i - 1); }
function dayNum(i) {
  const s = new Set();
  for (let k = 0; k <= i && k < shown.length; k++) s.add(dayKey(k));
  return s.size;
}
function interlude(i, advance) {
  cancelInterlude();
  if (timer) { clearInterval(timer); timer = null; } // 사진 넘김 정지 (재생 상태 유지)
  seenDays.add(dayKey(i));
  pendingInter = { i, advance };
  // 점 위 아이콘만 침대 → 배낭 → 원래 이동 아이콘 순으로 (고정 시간, 배속 무시)
  const d = shown[i];
  setMover([d.d_lon, d.d_lat], "bed");
  setMoverSize(1.35);
  $("mapstatus").textContent = dayNum(i) + "일차 시작 — 기상 + 짐싸기";
  const seq = ["bed", "sleep", "bed"];
  let k = 0;
  wakeInt = setInterval(() => {
    k = Math.min(k + 1, seq.length - 1);
    setMover(moverPos, seq[k]);
    setMoverSize(k % 2 ? 1.35 : 1.0);
  }, 800);
  interludeTO = setTimeout(finishInterlude, INTERLUDE_MS);
}
function finishInterlude() {
  const p = pendingInter; pendingInter = null;
  cancelInterlude();
  if (!playing) return;
  if (p && p.advance) go(p.i);
  startTimer();
}
function cancelInterlude() {
  if (interludeTO) { clearTimeout(interludeTO); interludeTO = null; }
  if (wakeInt) { clearInterval(wakeInt); wakeInt = null; }
  pendingInter = null;
  setMoverSize(1.0);
  if (typeof TL !== "undefined" && TL) $("mapstatus").textContent = "지도: " + MAP_LABEL[baseKind];
}
// 수동 이동: 인터루드 취소 후 이동, 재생 중이면 타이머 복구
function nav(i) {
  cancelInterlude();
  go(i);
  if (playing && !timer) startTimer();
}

main().catch(e => { const t = $("triplist"); if (t) t.innerHTML = "초기화 실패: " + e; const m = $("mapstatus"); if (m) m.textContent = "초기화 실패: " + e; });
