// 로컬 폴더 모드: 서버 없이 브라우저가 직접 읽음 (File API + exifr + blob URL).
// 사진은 업로드되지 않고 로컬에서만 처리됨. 영상 GPS는 미지원(시간 hold로 배치).
const LOCAL = { trips: {}, order: [], root: "", write: false };
const LOCAL_IMG = /\.(jpe?g|png|heic|heif)$/i;
const LOCAL_VID = /\.(mp4|mov|m4v)$/i;
const LOCAL_TS = /(\d{8})_(\d{6})/;

function localFmtDT(dt) {
  const p = n => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}
function localHavKm(a, b, c, d) {
  const R = 6371, p1 = b * Math.PI / 180, p2 = d * Math.PI / 180;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((c - a) * Math.PI / 180) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function parseLocalFiles(fileList, onProgress) {
  if (typeof exifr === "undefined") throw new Error(T("exifrFail"));
  const files = [...fileList].filter(f => LOCAL_IMG.test(f.name) || LOCAL_VID.test(f.name));
  if (!files.length) throw new Error(T("noPhotos"));
  const groups = {};
  let flat = false;
  for (const f of files) {
    const rp = f._relpath || f.webkitRelativePath || "";
    const parts = rp.split("/").filter(Boolean);
    let trip;
    if (parts.length > 2) trip = parts[1];
    else if (parts.length === 2) trip = parts[0];
    else { trip = T("pickedTrip"); flat = true; }
    (groups[trip] || (groups[trip] = [])).push(f);
  }
  LOCAL.trips = {};
  LOCAL.order = [];
  const rp0 = (files[0]._relpath || files[0].webkitRelativePath || "").split("/").filter(Boolean);
  LOCAL.root = rp0.length > 1 ? rp0[0] : "";
  const names = Object.keys(groups).sort();
  let done = 0;
  for (const name of names) {
    const fl = groups[name].sort((a, b) => (a.name < b.name ? -1 : 1));
    const items = [];
    let k = 0;
    for (const f of fl) {
      items.push(await parseLocalFile(f, name, k++));
      if (++done % 25 === 0 && onProgress) onProgress(done, files.length);
    }
    const tl = buildLocalTimeline(name, items);
    LOCAL.trips[name] = tl;
    LOCAL.order.push(name);
  }
  if (onProgress) onProgress(files.length, files.length);
  return LOCAL.order.map(n => ({ id: n, name: n, local: true, ...LOCAL.trips[n].meta }));
}

async function parseLocalFile(f, trip, k) {
  const m = { id: "m" + String(k).padStart(4, "0"), trip, file: f.name,
    type: LOCAL_VID.test(f.name) ? "video" : "photo",
    has_gps: false, lat: null, lon: null, datetime: null, size: f.size,
    u: URL.createObjectURL(f), _handle: f._handle || null };
  try {
    if (m.type === "photo" && typeof exifr !== "undefined") {
      const ex = await exifr.parse(f, { tiff: true, exif: true, gps: true }).catch(() => null);
      if (ex) {
        const dt = ex.DateTimeOriginal || ex.CreateDate || ex.ModifyDate;
        if (dt instanceof Date && !isNaN(dt)) m.datetime = localFmtDT(dt);
        if (typeof ex.latitude === "number" && typeof ex.longitude === "number" &&
            Math.abs(ex.latitude) <= 90 && Math.abs(ex.longitude) <= 180) {
          m.lat = ex.latitude; m.lon = ex.longitude; m.has_gps = true;
        }
      }
    }
  } catch (e) { /* no gps */ }
  if (!m.datetime) {
    const mm = LOCAL_TS.exec(f.name);
    if (mm) m.datetime = `${mm[1].slice(0, 4)}-${mm[1].slice(4, 6)}-${mm[1].slice(6, 8)} ${mm[2].slice(0, 2)}:${mm[2].slice(2, 4)}:${mm[2].slice(4, 6)}`;
    else if (f.lastModified) m.datetime = localFmtDT(new Date(f.lastModified));
  }
  return m;
}

// build_path.py step-hold 포팅: GPS 앵커 + 시간 hold, 보간 없음
function buildLocalTimeline(trip, items) {
  const toTs = s => { const t = Date.parse(s ? s.replace(" ", "T") : ""); return isNaN(t) ? null : t; };
  items.forEach(m => { m._ts = toTs(m.datetime); });
  const dated = items.filter(m => m._ts != null).sort((a, b) => (a._ts - b._ts) || (a.id < b.id ? -1 : 1));
  const nodate = items.filter(m => m._ts == null);
  const anchors = dated.filter(m => m.has_gps);
  const out = [];
  let last = null;
  for (const m of dated) {
    const d = { ...m };
    delete d._ts;
    if (m.has_gps) {
      last = m;
      Object.assign(d, { d_lat: m.lat, d_lon: m.lon, method: "gps", at: m.id });
    } else if (last) {
      Object.assign(d, { d_lat: last.lat, d_lon: last.lon, method: "held", at: last.id });
    } else {
      const nx = anchors.find(a => a._ts >= m._ts);
      if (nx) Object.assign(d, { d_lat: nx.lat, d_lon: nx.lon, method: "held_next", at: nx.id });
      else Object.assign(d, { d_lat: null, d_lon: null, method: "unplaced" });
    }
    out.push(d);
  }
  for (const m of nodate) {
    const d = { ...m };
    delete d._ts;
    Object.assign(d, { d_lat: null, d_lon: null, method: "no_datetime" });
    out.push(d);
  }
  let dist = 0;
  for (let i = 0; i + 1 < anchors.length; i++) {
    dist += localHavKm(anchors[i].lon, anchors[i].lat, anchors[i + 1].lon, anchors[i + 1].lat);
  }
  const meta = {
    total: items.length, dated: dated.length, no_datetime: nodate.length,
    gps: anchors.length,
    held: out.filter(d => d.method === "held").length,
    held_next: out.filter(d => d.method === "held_next").length,
    unplaced: out.filter(d => d.method === "unplaced" || d.method === "no_datetime").length,
    places: 0, route_km: Math.round(dist * 100) / 100,
    start: dated.length ? dated[0].datetime : null,
    end: dated.length ? dated[dated.length - 1].datetime : null,
  };
  return { trip, meta, places: [], route: anchors.map(a => [a.lon, a.lat]), items: out };
}

// ---- 쓰기 허용 폴더 선택 (File System Access API, 폴백은 읽기 전용) ----
async function pickLocalFolderFS() {
  const dir = await window.showDirectoryPicker({ mode: "readwrite" });
  let perm = "granted";
  try { perm = await dir.requestPermission({ mode: "readwrite" }); } catch (e) {}
  LOCAL.write = (perm === "granted");
  const files = [];
  async function walk(h, trail) {
    for await (const [name, e] of h.entries()) {
      if (e.kind === "file") {
        const f = await e.getFile();
        f._handle = e;
        f._relpath = [dir.name, ...trail, name].join("/");
        files.push(f);
      } else if (e.kind === "directory") {
        await walk(e, [...trail, name]);
      }
    }
  }
  await walk(dir, []);
  return files;
}

// ---- 원본 JPEG에 GPS 기록 (piexif) ----
function degToDms(v) {
  const d = Math.floor(v), m = Math.floor((v - d) * 60), s = ((v - d) * 60 - m) * 60;
  return [[d, 1], [m, 1], [Math.round(s * 100), 100]];
}
function buildGpsJpeg(buf, lat, lon) {
  if (typeof piexif === "undefined") throw new Error(T("wPiexif"));
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  let ex;
  try { ex = piexif.load(bin); }
  catch (e) { ex = { "0th": {}, Exif: {}, GPS: {}, Interop: {}, "1st": {}, thumbnail: null }; }
  ex.GPS[piexif.GPSIFD.GPSLatitudeRef] = lat < 0 ? "S" : "N";
  ex.GPS[piexif.GPSIFD.GPSLatitude] = degToDms(Math.abs(lat));
  ex.GPS[piexif.GPSIFD.GPSLongitudeRef] = lon < 0 ? "W" : "E";
  ex.GPS[piexif.GPSIFD.GPSLongitude] = degToDms(Math.abs(lon));
  const out = piexif.insert(piexif.dump(ex), bin);
  const u8 = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) u8[i] = out.charCodeAt(i);
  return u8;
}
async function writeGpsExif(handle, lat, lon) {
  const u8 = buildGpsJpeg(await (await handle.getFile()).arrayBuffer(), lat, lon);
  const w = await handle.createWritable();
  await w.write(u8);
  await w.close();
  // 검증: 다시 읽어 좌표 확인
  const vf = await handle.getFile();
  const ex = await exifr.parse(vf, { gps: true }).catch(() => null);
  if (!ex || Math.abs((ex.latitude ?? 9999) - lat) > 0.0002 || Math.abs((ex.longitude ?? 9999) - lon) > 0.0002) {
    throw new Error(T("wVerify"));
  }
}
