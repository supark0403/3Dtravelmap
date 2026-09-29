let TL, viewer, entities = [], idx = 0, timer = null;
const $ = id => document.getElementById(id);

async function main() {
  const r = await fetch("data/timeline.json");
  TL = await r.json();
  const items = TL.items.filter(d => d.d_lat != null);
  TL._shown = items;

  viewer = new Cesium.Viewer("cesium", {
    imageryProvider: new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }),
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    geocoder: false, baseLayerPicker: false, sceneModePicker: true,
    timeline: false, animation: false, homeButton: true, infoBox: false, selectionIndicator: false,
  });

  // GPS anchor route (yellow)
  if (TL.route.length > 1) {
    viewer.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray(TL.route.flat()),
      width: 3, material: Cesium.Color.GOLD } });
  }
  // full time-order path faint
  const seq = [];
  items.forEach(d => seq.push(d.d_lon, d.d_lat));
  if (seq.length > 3) {
    viewer.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray(seq),
      width: 1, material: Cesium.Color.CYAN.withAlpha(0.35) } });
  }

  items.forEach((d, i) => {
    const gps = d.method === "gps";
    const e = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(d.d_lon, d.d_lat, gps ? 60 : 30),
      point: { pixelSize: gps ? 10 : 6,
        color: gps ? Cesium.Color.ORANGE : (d.type === "video" ? Cesium.Color.MAGENTA : Cesium.Color.DEEPSKYBLUE),
        outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
      _i: i,
    });
    entities.push(e);
  });

  const m = TL.meta;
  $("stats").textContent = `전체 ${m.total} · GPS ${m.gps} · 추정 ${m.interpolated + m.prev_anchor + m.next_anchor} · ${m.route_km}km · ${m.start} ~ ${m.end}`;
  const sc = $("scrub"); sc.max = items.length - 1;
  sc.oninput = () => go(+sc.value);
  $("prev").onclick = () => go(idx - 1);
  $("next").onclick = () => go(idx + 1);
  $("play").onclick = toggle;
  $("speed").onchange = () => { if (timer) { stop(); toggle(); } };
  $("showInterp").onchange = applyFilter;
  $("close").onclick = () => $("panel").classList.add("hidden");

  const h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  h.setInputAction(c => {
    const p = viewer.scene.pick(c.position);
    if (p && p.id && p.id._i !== undefined) go(p.id._i);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  go(0);
  viewer.flyTo(viewer.entities);
}

function applyFilter() {
  const show = $("showInterp").checked;
  entities.forEach((e, i) => {
    const d = TL._shown[i];
    e.show = show || d.method === "gps";
  });
}

function badge(d) {
  const map = { gps: ["GPS", "gps"], interpolated: ["시간추정", "interp"],
    prev_anchor: ["직전위치", "prevnext"], next_anchor: ["직후위치", "prevnext"] };
  const [t, c] = map[d.method] || [d.method, "bad"];
  const v = d.type === "video" ? ' <span class="badge interp">VIDEO</span>' : "";
  return `<span class="badge ${c}">${t}</span>${v}`;
}

function go(i) {
  const items = TL._shown;
  idx = Math.max(0, Math.min(items.length - 1, i));
  $("scrub").value = idx;
  const d = items[idx];
  $("cur").textContent = `#${idx + 1}/${items.length} · ${d.datetime} · ${d.file}`;
  const thumb = `data/thumbs/${d.id}.jpg`;
  $("media").innerHTML = d.type === "video"
    ? `<video src="../sample/${encodeURIComponent(d.file)}" controls poster="${thumb}"></video>`
    : `<img src="${thumb}" onerror="this.onerror=null;this.src='../sample/${encodeURI(d.file)}'" alt="">`;
  $("info").innerHTML = `${badge(d)}<br>시간: ${d.datetime}<br>좌표: ${d.d_lat.toFixed(5)}, ${d.d_lon.toFixed(5)}<br>파일: ${d.file}`;
  $("panel").classList.remove("hidden");
  entities.forEach((e, k) => {
    const dd = items[k];
    const gps = dd.method === "gps";
    e.point.pixelSize = k === idx ? 16 : (gps ? 10 : 6);
  });
  if ($("follow").checked) {
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(d.d_lon, d.d_lat, 1500), duration: 1.2 });
  }
}

function toggle() {
  if (timer) { stop(); return; }
  $("play").textContent = "⏸ 정지";
  timer = setInterval(() => {
    if (idx >= TL._shown.length - 1) { stop(); return; }
    go(idx + 1);
  }, +$("speed").value);
}
function stop() { clearInterval(timer); timer = null; $("play").textContent = "▶ 재생"; }

main().catch(e => { document.getElementById("cur").textContent = "data/timeline.json 로드 실패: " + e; });
