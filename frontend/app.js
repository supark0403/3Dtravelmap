let viewer, TL, shown = [], entities = [], mover = null, idx = 0, timer = null, speed = 1;
const $ = id => document.getElementById(id);
const BASE_MS = 1500;

const MAPS = {
  // NOTE: ArcGisMapServerImageryProvider는 메타데이터 실패 시 렌더 크래시를 내서 사용 금지.
  // 직접 타일 URL(UrlTemplate)만 사용 — 실패해도 errorEvent로 정상 처리됨.
  street: () => new Cesium.UrlTemplateImageryProvider({
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    credit: "© OpenStreetMap contributors", maximumLevel: 19 }),
  sat: () => new Cesium.UrlTemplateImageryProvider({
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    credit: "Esri World Imagery", maximumLevel: 19 }),
  carto: () => new Cesium.UrlTemplateImageryProvider({
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    credit: "Esri World Topo", maximumLevel: 19 }),
};
const MAP_ORDER = ["street", "sat", "carto"];
const MAP_LABEL = { street: "일반(OSM)", sat: "위성(Esri)", carto: "지형(Esri)" };
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
  const next = MAP_ORDER.find(k => !mapFailed[k]);
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
  for (const k of MAP_ORDER) {
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
  $("follow").onchange = () => {
    if ($("follow").checked) frameCurrent();
    else viewer.camera.cancelFlight();
  };
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
  if (typeof viewer !== "undefined" && viewer) viewer.camera.cancelFlight();
  $("home").onclick = showHome;
  $("hud").classList.add("hidden");
  $("panel").classList.add("hidden");
  $("manual").classList.add("hidden");
  $("trips").classList.remove("hidden");
  $("tripname").textContent = "";
  $("tripNote").textContent = "";
  let trips = [];
  API_OK = false;
  try { trips = await api("/api/trips", "GET"); API_OK = true; }
  catch (e) {
    try { trips = await (await fetch("data/trips.json")).json(); }
    catch (e2) { $("triplist").innerHTML = "data/trips.json 없음 — backend 파이프라인을 먼저 실행하세요."; return; }
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
  if (TL.meta.start) { $("mfrom").value = TL.meta.start.replace(" ", "T"); $("mto").value = TL.meta.end.replace(" ", "T"); }
  renderRules();
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

function pointColor(d) {
  if (d.type === "video") return Cesium.Color.MAGENTA;
  if (d.method === "gps") return Cesium.Color.ORANGE;
  if (d.method === "manual") return Cesium.Color.LIME;
  return d.method === "held_next" ? Cesium.Color.PURPLE : Cesium.Color.DEEPSKYBLUE;
}

function renderAll(startIdx) {
  viewer.entities.removeAll();
  entities = [];
  const pts = routePoints();
  if (pts.length > 1)
    viewer.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray(pts.flat()), width: 3, material: Cesium.Color.GOLD } });
  shown.forEach((d, i) => {
    const big = d.method === "gps" || d.method === "manual";
    entities.push(viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(d.d_lon, d.d_lat, big ? 60 : 30),
      point: { pixelSize: big ? 10 : 6, color: pointColor(d),
        outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
      _i: i,
    }));
  });
  mover = viewer.entities.add({ position: Cesium.Cartesian3.fromDegrees(shown[0].d_lon, shown[0].d_lat, 120),
    billboard: { image: EMOJI.walk, scale: 0.9, verticalOrigin: Cesium.VerticalOrigin.BOTTOM }, _i: 0 });

  const m = TL.meta;
  const man = shown.filter(d => d.method === "manual").length;
  $("stats").textContent = `전체 ${m.total} · GPS ${m.gps} · 같은장소 ${m.held + m.held_next} · 직접 ${man} · ${m.start} ~ ${m.end}`;
  $("scrub").max = shown.length - 1;
  applyFilter();
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
      const hit = r.mode === "before" ? (d._ts < fat) : (d._ts >= r.fromTs && d._ts <= r.toTs);
      if (!hit) continue;
      if (!d._orig) d._orig = { lat: d.d_lat, lon: d.d_lon, method: d.method, at: d.at };
      d.d_lat = r.lat; d.d_lon = r.lon; d.method = "manual"; d.at = r.name;
    }
  }
}

let MPLACE = null;
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
  $("mbeforeN").textContent = shown.filter(d => d.method !== "gps" && d._ts < firstAnchorTs()).length;
}
function mApply() {
  if (!MPLACE || !TL) return;
  const mode = document.querySelector('input[name=mscope]:checked').value;
  const rules = MANUAL[TL.trip] || (MANUAL[TL.trip] = []);
  if (mode === "before") {
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
    const scope = r.mode === "before" ? "첫 GPS 이전 전부" : `${new Date(r.fromTs).toLocaleString()} ~ ${new Date(r.toTs).toLocaleString()}`;
    div.innerHTML = `<span>📍 ${r.name}<br><small>${scope}</small></span>`;
    const del = document.createElement("button");
    del.textContent = "삭제";
    del.onclick = () => { rules.splice(i, 1); saveManual(); renderRules(); applyManual(); renderAll(idx); };
    div.appendChild(del);
    box.appendChild(div);
  });
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
  const map = { gps: ["GPS확정", "gps"], held: ["같은장소", "held"], held_next: ["같은장소", "heldnext"], manual: ["직접지정", "man"] };
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
  entities.forEach((e, k) => { const mm = shown[k].method; e.point.pixelSize = k === idx ? 16 : ((mm === "gps" || mm === "manual") ? 10 : 6); });
  if ($("follow").checked) {
    // 배속 적응 비행: 간격의 90% 안에 도착 → 끊김 없이 연속 활공
    const p = shown[idx - 1];
    let h = 1600;
    if (p) {
      const km = Math.hypot((d.d_lon - p.d_lon) * 91, (d.d_lat - p.d_lat) * 111);
      h = Math.min(8000, Math.max(350, km * 1000 * 1.2)); // 가까우면 낮게, 멀면 높게
    }
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(d.d_lon, d.d_lat, h),
      orientation: { heading: 0, pitch: -0.55, roll: 0 },
      duration: Math.max(0.25, Math.min(1.6, (BASE_MS / speed) / 1000 * 0.9)),
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT });
  } else viewer.camera.cancelFlight();
  // 다음 썸네일 미리 로드 (패널 깜빡임 완화)
  for (let k = 1; k <= 3; k++) {
    const n = shown[idx + k];
    if (n) { const im = new Image(); im.src = `data/thumbs/${n.thumb || n.id + ".jpg"}`; }
  }
}

// 현재 위치로 스냅 (비행 없이 즉시)
function frameCurrent() {
  const d = shown[idx];
  if (!d) return;
  viewer.camera.cancelFlight();
  viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(d.d_lon, d.d_lat, 1600),
    orientation: { heading: 0, pitch: -0.55, roll: 0 } });
}

function toggle() {
  if (timer) { stop(); return; }
  $("play").textContent = "⏸ 정지";
  timer = setInterval(() => { if (idx >= shown.length - 1) { stop(); return; } go(idx + 1); }, BASE_MS / speed);
}
function stop() { if (timer) { clearInterval(timer); timer = null; } $("play").textContent = "▶ 재생"; }

main().catch(e => { $("triplist").innerHTML = "초기화 실패: " + e; });
