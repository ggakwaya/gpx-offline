// Lecture d'un GPX et calculs sur la trace (distances, dénivelé, accroche de position).

const R = 6371008.8;
const RAD = Math.PI / 180;

export function haversine(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function readPoint(el) {
  const lat = parseFloat(el.getAttribute('lat'));
  const lon = parseFloat(el.getAttribute('lon'));
  const eleEl = el.getElementsByTagName('ele')[0];
  const ele = eleEl ? parseFloat(eleEl.textContent) : NaN;
  return [lon, lat, ele];
}

export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Fichier GPX illisible');
  let pts = [...doc.getElementsByTagName('trkpt')];
  if (!pts.length) pts = [...doc.getElementsByTagName('rtept')];
  const points = pts.map(readPoint).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (points.length < 2) throw new Error('Aucune trace dans ce GPX');
  const waypoints = [...doc.getElementsByTagName('wpt')].map(el => {
    const [lon, lat] = readPoint(el);
    const nameEl = el.getElementsByTagName('name')[0];
    return { lon, lat, name: nameEl ? nameEl.textContent.trim() : '' };
  });
  const nameEl = doc.querySelector('metadata > name') || doc.querySelector('trk > name') ||
    doc.querySelector('rte > name');
  return { name: nameEl ? nameEl.textContent.trim() : 'Parcours', points, waypoints };
}

// Remplit les altitudes manquantes avec la dernière connue (ou 0).
function fillElevations(points) {
  let last = points.find(p => Number.isFinite(p[2]))?.[2] ?? 0;
  return points.map(([lon, lat, ele]) => {
    if (Number.isFinite(ele)) last = ele;
    return [lon, lat, last];
  });
}

export function buildTrack(rawPoints) {
  const points = fillElevations(rawPoints);
  const n = points.length;
  const dist = new Float64Array(n);
  const up = new Float64Array(n);
  let down = 0;
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const [lon, lat, ele] = points[i];
    bbox[0] = Math.min(bbox[0], lon); bbox[1] = Math.min(bbox[1], lat);
    bbox[2] = Math.max(bbox[2], lon); bbox[3] = Math.max(bbox[3], lat);
    if (i === 0) continue;
    const [plon, plat, pele] = points[i - 1];
    dist[i] = dist[i - 1] + haversine(plon, plat, lon, lat);
    const de = ele - pele;
    up[i] = up[i - 1] + Math.max(de, 0);
    down += Math.max(-de, 0);
  }
  return { points, dist, up, bbox, totalDist: dist[n - 1], totalUp: up[n - 1], totalDown: down };
}

// Projette (lon, lat) sur le segment i → i+1, en mètres dans un repère local.
function projectOnSegment(track, i, lon, lat) {
  const [lon1, lat1] = track.points[i];
  const [lon2, lat2] = track.points[i + 1];
  const kx = Math.cos(lat * RAD) * RAD * R;
  const ky = RAD * R;
  const ax = (lon1 - lon) * kx, ay = (lat1 - lat) * ky;
  const bx = (lon2 - lon) * kx, by = (lat2 - lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
  const px = ax + t * dx, py = ay + t * dy;
  return { t, offset: Math.hypot(px, py) };
}

// Trouve la position sur la trace la plus probable. Quand la trace repasse au même endroit,
// on privilégie le passage le plus proche de la position précédente (prevDist).
export function snap(track, lon, lat, prevDist = null) {
  const segs = [];
  let best = Infinity;
  for (let i = 0; i < track.points.length - 1; i++) {
    const p = projectOnSegment(track, i, lon, lat);
    segs.push(p);
    if (p.offset < best) best = p.offset;
  }
  let pick = -1, pickScore = Infinity;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].offset > best + 30) continue;
    const d = track.dist[i] + segs[i].t * (track.dist[i + 1] - track.dist[i]);
    const score = prevDist === null ? d : Math.abs(d - prevDist);
    if (score < pickScore) { pickScore = score; pick = i; }
  }
  // offset = distance réelle à la trace (passage le plus proche), même si un autre passage est retenu.
  return { ...pointAtIndex(track, pick, segs[pick].t), offset: best };
}

function pointAtIndex(track, i, t) {
  const a = track.points[i], b = track.points[i + 1] || a;
  const lerp = (u, v) => u + t * (v - u);
  return {
    index: i,
    dist: lerp(track.dist[i], track.dist[i + 1] ?? track.dist[i]),
    up: lerp(track.up[i], track.up[i + 1] ?? track.up[i]),
    lon: lerp(a[0], b[0]), lat: lerp(a[1], b[1]), ele: lerp(a[2], b[2]),
  };
}

// Point situé à la distance d (m) depuis le départ.
export function pointAtDistance(track, d) {
  const { dist } = track;
  let lo = 0, hi = dist.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= d) lo = mid; else hi = mid;
  }
  const span = dist[hi] - dist[lo];
  return pointAtIndex(track, lo, span ? Math.min(1, Math.max(0, (d - dist[lo]) / span)) : 0);
}

// Pente moyenne (%) sur une fenêtre centrée de `window` mètres autour de d.
export function gradeAt(track, d, window = 100) {
  const a = pointAtDistance(track, Math.max(0, d - window / 2));
  const b = pointAtDistance(track, Math.min(track.totalDist, d + window / 2));
  const run = b.dist - a.dist;
  return run > 0 ? ((b.ele - a.ele) / run) * 100 : 0;
}

// Montées significatives (≥ 30 m de gain, ≥ 2,5 % de moyenne). Un replat ou une descente
// de moins de 15 m ne coupe pas une montée.
export function findClimbs(track, { hysteresis = 15, minGain = 30, minGrade = 2.5, step = 25 } = {}) {
  const samples = [];
  for (let d = 0; d <= track.totalDist; d += step) samples.push(pointAtDistance(track, d));
  const climbs = [];
  const push = (lo, hi) => {
    const gain = samples[hi].ele - samples[lo].ele;
    const length = samples[hi].dist - samples[lo].dist;
    if (gain >= minGain && (gain / length) * 100 >= minGrade) {
      climbs.push({ start: samples[lo].dist, end: samples[hi].dist, gain, grade: (gain / length) * 100 });
    }
  };
  let lo = 0, hi = 0, climbing = false;
  for (let i = 1; i < samples.length; i++) {
    const e = samples[i].ele;
    if (!climbing) {
      if (e < samples[lo].ele) lo = i;
      else if (e - samples[lo].ele >= hysteresis) { climbing = true; hi = i; }
    } else if (e > samples[hi].ele) {
      hi = i;
    } else if (samples[hi].ele - e >= hysteresis) {
      push(lo, hi);
      climbing = false;
      lo = i;
    }
  }
  if (climbing) push(lo, hi);
  return climbs;
}

export function isLoop(points, maxGap = 300) {
  const [a, b] = [points[0], points[points.length - 1]];
  return haversine(a[0], a[1], b[0], b[1]) <= maxGap;
}

// Boucle qui commence au point de la trace le plus proche de (lon, lat).
export function rotateLoop(points, lon, lat) {
  let index = 0, best = Infinity;
  points.forEach(([plon, plat], i) => {
    const d = haversine(lon, lat, plon, plat);
    if (d < best) { best = d; index = i; }
  });
  return points.slice(index).concat(points.slice(0, index));
}
