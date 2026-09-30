let map, mapReady = false, TL, shown = [], idx = 0, timer = null, speed = 1;
let moverPos = [0, 0], moverIcon = "walk";
let baseKind = "street", baseFailed = {};
const $ = id => document.getElementById(id);
const BASE_MS = 1500;

const LIBERTY = "https://tiles.openfreemap.org/styles/liberty";
const OFM_VECTOR = "https://tiles.openfreemap.org/planet";
const DEM_TILES = ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"];
const ESRI_SAT = ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"];
function mapLabel(kind) {
  return { street: T("mapStreet"), sat: T("mapSat"), terrain: T("mapTerrain") }[kind] || kind;
}
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
  styleReady = true;
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
let moverOn = true;
try { moverOn = localStorage.getItem("tm_mover") !== "0"; } catch (e) {}
function applyMover() {
  try { if (map.getLayer("tm-mover")) map.setLayoutProperty("tm-mover", "visibility", moverOn ? "visible" : "none"); } catch (e) {}
  document.querySelectorAll("#moverBtn").forEach(b => b.classList.toggle("on", moverOn));
}
function applyBuildings() {
  for (const id of ["building-3d", "tm-build3d"]) {
    try { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", buildingsOn ? "visible" : "none"); } catch (e) {}
  }
  document.querySelectorAll('[data-map="bld"]').forEach(b => b.classList.toggle("on", buildingsOn));
}
function setBase(kind) {
  baseKind = kind;
  document.querySelectorAll(".mapbtn").forEach(b => { if (b.dataset.map !== "bld" && b.id !== "moverBtn") b.classList.toggle("on", b.dataset.map === kind); });
  try {
    map.setStyle(styleFor(kind));
    $("mapstatus").textContent = T("mapIs", { x: mapLabel(kind) });
  } catch (e) { onBaseError(kind); }
}
function onBaseError(kind) {
  if (baseFailed[kind]) return;
  baseFailed[kind] = true;
  const next = MAP_ORDER.find(k => !baseFailed[k]);
  if (next) { $("mapstatus").textContent = T("mapFailOver", { x: mapLabel(next) }); setBase(next); }
  else $("mapstatus").textContent = T("mapFailAll");
}

const EMO_ICONS = { walk: "🚶", transit: "🚇", plane: "✈️", ship: "🚢" };
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
  if (!a || !b) return ["walk", T("segStay")];
  if (b.method === "manual") return ["walk", "📍 " + (b.at || T("segManualFallback"))];
  if (b._ts <= a._ts) return ["walk", T("segStay")];
  const R = 6371, p1 = a.d_lat * Math.PI / 180, p2 = b.d_lat * Math.PI / 180;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((b.d_lon - a.d_lon) * Math.PI / 180) / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(h));
  const hrs = (b._ts - a._ts) / 3600;
  const v = km / hrs;
  if (b.transport === "ship" || a.transport === "ship") return ["ship", T("segShip")];
  if (v > 250) return ["plane", T("segPlane")];
  if (v > 12) return ["transit", T("segTransit")];
  return ["walk", T("segWalk")];
}

function dotColor(d) {
  if (d.type === "video") return "#e040fb";
  if (d.method === "gps") return "#ff9800";
  if (d.method === "manual") return "#64dd17";
  return d.method === "held_next" ? "#ab47bc" : "#29b6f6";
}

let tripRenderTries = 0, styleReady = false;
function renderTripLayers() {
  // 타일 로딩 여부와 무관하게 스타일 파싱 후면 레이어 추가 가능. 스타일 미완성 때만 재시도.
  if (!mapReady || !styleReady) {
    if (TL && shown.length && tripRenderTries < 30) {
      tripRenderTries++;
      setTimeout(() => { if (TL && shown.length) renderTripLayers(); }, 1000);
    } else if (TL && shown.length) {
      $("mapstatus").textContent = T("styleFail");
    }
    return;
  }
  tripRenderTries = 0;
  try {
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
  // 숙소 라벨: 첫날은 첫 사진에 공항, 이후 일차는 전날 마지막 사진에 숙소
  const dayFeats = [];
  groups.forEach((g, n) => {
    if (n === 0) {
      const f = g[0];
      dayFeats.push({ type: "Feature", geometry: { type: "Point", coordinates: [f.d.d_lon, f.d.d_lat] },
        properties: { i: f.i, label: T("airport") } });
    } else {
      const prev = groups[n - 1], last = prev[prev.length - 1];
      dayFeats.push({ type: "Feature", geometry: { type: "Point", coordinates: [last.d.d_lon, last.d.d_lat] },
        properties: { i: last.i, label: T("stay") } });
    }
  });
  map.addSource("tm-days-src", { type: "geojson",
    data: { type: "FeatureCollection", features: dayFeats } });
  map.addLayer({ id: "tm-days", type: "symbol", source: "tm-days-src",
    layout: { "text-field": ["get", "label"], "text-size": 14, "text-offset": [0, -1.6],
      "text-allow-overlap": true, "text-font": ["Noto Sans Bold"] },
    paint: { "text-color": "#111", "text-halo-color": "#fff", "text-halo-width": 2 } });
  applyFilter();
  applyMover();
  } catch (e) {
    // 스타일 교체 중 등 일시 실패 → 재시도
    if (TL && shown.length && tripRenderTries < 30) {
      tripRenderTries++;
      setTimeout(() => { if (TL && shown.length) renderTripLayers(); }, 1000);
    }
  }
}

async function main() {
  map = new maplibregl.Map({ container: "map", style: styleFor("street"),
    center: [127.5, 36.5], zoom: 2, pitch: 0, attributionControl: { compact: true } });
  if (map.setProjection) { try { map.setProjection({ type: "globe" }); } catch (e) {} }
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.on("load", () => { mapReady = true; setup3D(); });
  map.on("style.load", () => setup3D());
  map.on("error", () => { $("mapstatus").textContent = T("mapTileErr"); });
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
  $("moverBtn").onclick = () => {
    moverOn = !moverOn;
    try { localStorage.setItem("tm_mover", moverOn ? "1" : "0"); } catch (e) {}
    applyMover();
  };
  applyMover();
  $("mapstatus").textContent = T("mapIs", { x: mapLabel(baseKind) });

  $("home").onclick = showHome;
  const langSel = $("langSel");
  if (langSel) {
    if (LANG) { langSel.value = LANG; setLang(LANG); }
    langSel.onchange = e => setLang(e.target.value);
  }
  $("localOpen").onclick = async () => {
    if (window.showDirectoryPicker) {
      try {
        const files = await pickLocalFolderFS();
        if (files && files.length) { loadLocalFiles(files); return; }
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return; // cancel /取消
        $("tripNote").textContent = T("openFailRo") + (e.message || e);
      }
    } else if (window.showOpenFilePicker) {
      // 모바일 크롬 등: 파일 직접 선택 (폴더 API 없음, 쓰기 불가)
      try {
        const handles = await window.showOpenFilePicker({ multiple: true, types: [{
          description: "photos", accept: {
            "image/*": [".jpg", ".jpeg", ".png", ".heic", ".heif"],
            "video/*": [".mp4", ".mov", ".m4v"] } }] });
        const files = [];
        for (const h of handles) files.push(await h.getFile());
        if (files.length) { LOCAL.write = false; loadLocalFiles(files); }
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    $("localPick").click();
  };
  async function loadLocalFiles(files) {
    try {
      await parseLocalFiles(files, (a, b) => { $("tripNote").textContent = T("reading", { a, b }); });
      showHome();
    } catch (err) { $("tripNote").textContent = T("readFail") + err.message; }
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
        if (!Array.isArray(list)) throw new Error(T("notArray"));
        MANUAL[TL.trip] = list;
        saveManual(); renderRules(); applyManual(); renderAll(idx);
      } catch (err) { $("mapstatus").textContent = T("importFail") + err; }
    };
    rd.readAsText(f);
    e.target.value = "";
  };
  showHome();
}

// 사진 패널 드래그 이동 (위치 기억)
function initPanelDrag() {
  const el = $("panel"), EDGE = 9;
  try {
    const saved = JSON.parse(localStorage.getItem("tm_panel_pos") || "null");
    if (saved && +saved.top >= 0 && +saved.left >= 0) {
      el.style.top = saved.top + "px"; el.style.left = saved.left + "px"; el.style.right = "auto";
      if (+saved.width > 0) el.style.width = saved.width + "px";
      if (+saved.height > 0) el.style.height = saved.height + "px";
    }
  } catch (e) {}
  let mode = null, sx, sy, r0;
  const zone = (e) => {
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const w = x < EDGE ? "w" : (r.width - x < EDGE ? "e" : "");
    const h = y < EDGE ? "n" : (r.height - y < EDGE ? "s" : "");
    return w + h;
  };
  const cursors = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
  el.addEventListener("mousemove", (e) => {
    if (mode || panelMin) return;
    const z = zone(e);
    el.style.cursor = z ? cursors[z] : "";
  });
  el.addEventListener("mousedown", (e) => {
    if (panelMin) return;
    if (e.target.closest("button,input,img,video,a,select,textarea")) return;
    const z = zone(e);
    mode = z || "move";
    sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect();
    r0 = { left: r.left, top: r.top, width: r.width, height: r.height };
    el.style.left = r0.left + "px"; el.style.top = r0.top + "px"; el.style.right = "auto";
    el.style.cursor = mode === "move" ? "move" : cursors[mode];
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!mode) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    let { left, top } = r0;
    if (mode === "move") {
      left = Math.max(0, left + dx); top = Math.max(0, top + dy);
    } else {
      // 사진 비율 고정: 한 축으로 끌면 다른 축이 비율대로 따라옴
      const mediaBox = el.querySelector("#media");
      const mel = el.querySelector("#media img, #media video");
      let ratio = 4 / 3;
      if (mel) {
        const nw = mel.naturalWidth || mel.videoWidth, nh = mel.naturalHeight || mel.videoHeight;
        if (nw && nh) ratio = nw / nh;
      }
      const cs = getComputedStyle(el);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const chromeH = r0.height - mediaBox.getBoundingClientRect().height;
      const maxW = window.innerWidth * 0.9, maxH = window.innerHeight * 0.9;
      let width, height;
      if (mode.includes("e") || mode.includes("w")) {
        width = Math.min(maxW, Math.max(220, r0.width + (mode.includes("e") ? dx : -dx)));
        let iw = width - padX, ih = iw / ratio;
        height = ih + chromeH;
        if (height > maxH) { height = maxH; ih = height - chromeH; iw = ih * ratio; width = iw + padX; }
      } else {
        height = Math.min(maxH, Math.max(150, r0.height + (mode.includes("s") ? dy : -dy)));
        let ih = height - chromeH, iw = ih * ratio;
        width = iw + padX;
        if (width > maxW) { width = maxW; iw = width - padX; ih = iw / ratio; height = ih + chromeH; }
      }
      if (mode.includes("w")) left = Math.max(0, r0.left + (r0.width - width));
      if (mode.includes("n")) top = Math.max(0, r0.top + (r0.height - height));
      el.style.width = width + "px"; el.style.height = height + "px";
    }
    el.style.left = left + "px"; el.style.top = top + "px";
  });
  window.addEventListener("mouseup", () => {
    if (!mode) return; mode = null; el.style.cursor = "";
    try {
      localStorage.setItem("tm_panel_pos", JSON.stringify({
        left: parseInt(el.style.left, 10), top: parseInt(el.style.top, 10),
        width: Math.round(el.getBoundingClientRect().width), height: Math.round(el.getBoundingClientRect().height),
      }));
    } catch (e) {}
  });
}

async function showHome() {
  stop();
  if (glideRAF) { cancelAnimationFrame(glideRAF); glideRAF = null; }
  try {
    for (const l of ["tm-route", "tm-photos", "tm-sel", "tm-mover", "tm-days", "tm-hill"]) if (map.getLayer(l)) map.removeLayer(l);
    for (const s of ["tm-route-src", "tm-photos-src", "tm-sel-src", "tm-mover-src", "tm-days-src"]) if (map.getSource(s)) map.removeSource(s);
  } catch (e) {}
  moverPos = [0, 0]; moverIcon = "walk";
  TL = null; shown = []; idx = 0; shownDay = null;
  $("hud").classList.add("hidden");
  $("panel").classList.add("hidden");
  $("manual").classList.add("hidden");
  $("trips").classList.remove("hidden");
  $("daybadge").classList.add("hidden");
  $("tripname").textContent = "";
  $("tripNote").textContent = "";
  $("localPath").textContent = LOCAL.root ? "📁 " + LOCAL.root : "";
  try { map.jumpTo({ center: [25, 30], zoom: 1.5, pitch: 0 }); } catch (e) {}
  $("triplist").innerHTML = "";
  if (!LOCAL.order.length) {
    $("triplist").innerHTML = `<small>${T("noTrips")}</small>`;
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
    b.innerHTML = `📂 ${n} ${T("localTag")}<br><small>${m.total}${T("photoUnit")} · GPS ${m.gps} · ${m.route_km}km · ${m.start || "?"} ~ ${m.end || "?"}</small>`;
    b.onclick = () => openLocalTrip(n);
    row.appendChild(b);
    $("triplist").appendChild(row);
  });
}

function openLocalTrip(name) {
  enterTrip(LOCAL.trips[name], "📂 " + name + " " + T("localTag"));
}

function enterTrip(tl, label) {
  stop();
  shownDay = null;
  tripRenderTries = 0;
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
  $("mapstatus").textContent = T("mapIs", { x: mapLabel(baseKind) });
  if (TL.meta.start) { $("mfrom").value = TL.meta.start.replace(" ", "T"); $("mto").value = TL.meta.end.replace(" ", "T"); }
  renderRules();
  snapMover = true; // 새 여행: 아이콘 점프 방지용 스냅
  renderAll(0);
  frameCurrent();
}

function renderAll(startIdx) {
  renderTripLayers();
  if (!shown.length) { $("mapstatus").textContent = T("emptyTrip"); return; }
  const m = TL.meta;
  const c = { gps: 0, held: 0, held_next: 0, manual: 0 };
  shown.forEach(d => { if (c[d.method] !== undefined) c[d.method]++; });
  $("stats").textContent = T("stats", { total: m.total, gps: c.gps, held: c.held + c.held_next, manual: c.manual, start: m.start, end: m.end });
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
  // 1) 사진별 직접지정 매칭 (force 규칙은 GPS 사진에도 적용)
  const match = new Map();
  for (const d of shown) {
    for (const r of rules) {
      if (d.method === "gps" && !r.force) continue;
      const hit = r.mode === "before" ? (d._ts < fat)
        : r.mode === "current" ? (d.file === r.file)
        : (d._ts >= r.fromTs && d._ts <= r.toTs);
      if (hit) { match.set(d, r); break; }
    }
  }
  // 2) 시간순 앵커 체인 재계산: GPS + 직접지정이 모두 앵커, 나머지는 직전 앵커에 hold
  const order = [...shown].sort((a, b) => (a._ts - b._ts) || (a.id < b.id ? -1 : 1));
  const anchorOf = (d) => {
    const r = match.get(d);
    if (r) return { lat: r.lat, lon: r.lon, label: r.name, ref: r };
    if (d.method === "gps") return { lat: d.d_lat, lon: d.d_lon, label: d.id, ref: null };
    return null;
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
    if (a && d.method === "gps" && !match.get(d)) { cur = a; return; }
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
  $("mresults").textContent = T("searching");
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=${LANG || "ko"}&q=${encodeURIComponent(q)}`);
    const list = await r.json();
    if (!list.length) { $("mresults").textContent = T("noResult"); return; }
    $("mresults").innerHTML = "";
    list.forEach(p => {
      const b = document.createElement("button");
      b.className = "tripcard";
      b.innerHTML = `${p.display_name}<br><small>${p.lat}, ${p.lon}</small>`;
      b.onclick = () => mPick(p);
      $("mresults").appendChild(b);
    });
  } catch (e) { $("mresults").textContent = T("searchFail") + e; }
}
function mPick(p) {
  MPLACE = { name: (p.name || (p.display_name || "").split(",")[0] || T("placeFallback")), lat: +p.lat, lon: +p.lon, addr: p.display_name };
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
  let nr = null, gpsHit = 0;
  const fat = firstAnchorTs();
  if (mode === "current") {
    const cur = shown[idx];
    if (!cur) return;
    nr = { mode, file: cur.file, name: MPLACE.name, lat: MPLACE.lat, lon: MPLACE.lon };
    gpsHit = cur.method === "gps" ? 1 : 0;
  } else if (mode === "before") {
    nr = { mode, name: MPLACE.name, lat: MPLACE.lat, lon: MPLACE.lon };
    gpsHit = shown.filter(d => d.method === "gps" && d._ts < fat).length;
  } else {
    const f = $("mfrom").value, t = $("mto").value;
    if (!f || !t) { $("mapstatus").textContent = T("needRange"); return; }
    nr = { mode: "range", name: MPLACE.name, lat: MPLACE.lat, lon: MPLACE.lon, fromTs: Date.parse(f), toTs: Date.parse(t) };
    gpsHit = shown.filter(d => d.method === "gps" && d._ts >= nr.fromTs && d._ts <= nr.toTs).length;
  }
  if (gpsHit > 0) {
    nr.force = true;
    if (!confirm(T("gpsOverwrite", { n: gpsHit }))) return;
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
  if (typeof piexif === "undefined") { box.textContent = T("wNoPiexif"); return; }
  if (!LOCAL.write) { box.textContent = T("wNoPerm", { n: targets.length }); return; }
  if (!jpegs.length) { box.textContent = T("wNoJpeg", { n: skip }); return; }
  let ok = 0, fail = 0;
  for (const d of jpegs) {
    try {
      await writeGpsExif(d._handle, rule.lat, rule.lon);
      d.has_gps = true; d.lat = rule.lat; d.lon = rule.lon;
      d._orig = { lat: rule.lat, lon: rule.lon, method: "gps", at: d.id };
      ok++;
    } catch (e) { fail++; }
    box.textContent = T("wProg", { a: ok + fail, b: jpegs.length });
  }
  applyManual(); renderAll(idx);
  box.textContent = T("wDone", { ok, fail: fail ? T("wDoneFail", { n: fail }) : "", skip: skip ? T("wDoneSkip", { n: skip }) : "" });
}
function renderRules() {
  const box = $("mrules");
  const rules = (TL && MANUAL[TL.trip]) || [];
  box.innerHTML = rules.length ? "" : `<small>${T("none")}</small>`;
  rules.forEach((r, i) => {
    const div = document.createElement("div");
    div.className = "mrule";
    const scope = r.mode === "before" ? T("scopeBeforeList")
      : r.mode === "current" ? T("photoOne") + (r.file || "")
      : `${new Date(r.fromTs).toLocaleString()} ~ ${new Date(r.toTs).toLocaleString()}`;
    div.innerHTML = `<span>📍 ${r.name}<br><small>${scope}</small></span>`;
    const del = document.createElement("button");
    del.textContent = T("del");
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
  const map = { gps: [T("badgeGps"), "gps"], held: [T("badgeHeld"), "held"], held_next: [T("badgeHeld"), "heldnext"], manual: [T("badgeManual"), "man"] };
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
function glowDay(b) {
  b.classList.remove("glow");
  void b.offsetWidth;
  b.classList.add("glow");
  clearTimeout(b._glowTO);
  b._glowTO = setTimeout(() => b.classList.remove("glow"), 2000);
}
function go(i) {
  if (!shown.length) return;
  idx = Math.max(0, Math.min(shown.length - 1, i));
  // 레이어가 스타일 로드 타이밍에 밀려 없으면 복구
  if (TL && mapReady && !map.getLayer("tm-photos")) renderTripLayers();
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
  if (dk !== shownDay) {
    shownDay = dk;
    const b = $("daybadge");
    b.textContent = T("day", { n: dayNum(idx) });
    glowDay(b);
  }
  const isHeic = /\.(heic|heif)$/i.test(d.file || "");
  if (d.type === "photo" && isHeic) {
    $("media").innerHTML = `<div class="heic">${T("heic")}<br><small>${d.file}</small><br><a href="${d.u}" download="${d.file}">${T("heicDl")}</a></div>`;
  } else if (d.type === "video") {
    $("media").innerHTML = `<video controls src="${d.u}"></video>`;
  } else {
    $("media").innerHTML = `<img src="${d.u}" alt="">`;
  }
  $("info").innerHTML = `${badge(d)}<br>${T("infoTime")}: ${d.datetime}<br>${T("infoMove")}: ${label}<br>${T("infoAt")}: ${d.at || "-"} @ ${d.d_lat.toFixed(5)}, ${d.d_lon.toFixed(5)}<br>${T("infoFile")}: ${d.file}`;
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
  $("play").textContent = T("pause");
  startTimer();
}
function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(stepOnce, BASE_MS / speed);
}
function stepOnce() {
  if (idx >= shown.length - 1) { stop(); return; }
  go(idx + 1);
}
function stop() {
  playing = false;
  if (timer) { clearInterval(timer); timer = null; }
  const p = $("play"); if (p) p.textContent = T("play");
}

// ---- 일차 표시: dayKey/dayNum ----
let playing = false;
function dayKey(i) { const d = shown[i]; return d ? (d.datetime || "").slice(0, 10) : ""; }
function dayNum(i) {
  const s = new Set();
  for (let k = 0; k <= i && k < shown.length; k++) s.add(dayKey(k));
  return s.size;
}
// 수동 이동: 재생 중이면 타이머 복구
function nav(i) {
  go(i);
  if (playing && !timer) startTimer();
}

main().catch(e => { const t = $("triplist"); if (t) t.innerHTML = T("initFail") + e; const m = $("mapstatus"); if (m) m.textContent = T("initFail") + e; });
