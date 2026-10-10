// Sources de tuiles et téléchargement de la zone d'un parcours pour l'usage hors ligne.
// Les tuiles sont mises en cache par le service worker (sw.js) à chaque requête réussie.

const OMT_TILEJSON = 'https://tiles.openfreemap.org/planet';
const OMT_FALLBACK = 'https://tiles.openfreemap.org/planet/20261004_113936_pt/{z}/{x}/{y}.pbf';
export const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const DEM_MAXZOOM = 12;
const OMT_MAXZOOM = 14;
const CORRIDOR_FROM_ZOOM = 11;
const CORRIDOR_METERS = 1500;
const BBOX_MARGIN_METERS = 3000;

let omtTemplate = localStorage.getItem('omtTemplate') || OMT_FALLBACK;

// Le chemin des tuiles OpenFreeMap change à chaque mise à jour hebdomadaire : on le relit en ligne.
export async function refreshOmtTemplate() {
  try {
    const res = await fetch(OMT_TILEJSON, { signal: AbortSignal.timeout(8000) });
    const tj = await res.json();
    if (tj.tiles?.[0]) {
      omtTemplate = tj.tiles[0];
      localStorage.setItem('omtTemplate', omtTemplate);
    }
  } catch { /* hors ligne : on garde le dernier chemin connu */ }
}

export function omtUrl(z, x, y) {
  return omtTemplate.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

const demUrl = (z, x, y) => DEM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);

function tileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function tileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

function addRange(set, z, [w, s, e, n], margin) {
  const max = 2 ** z - 1;
  const clamp = v => Math.min(max, Math.max(0, v));
  for (let x = clamp(tileX(w, z) - margin); x <= clamp(tileX(e, z) + margin); x++) {
    for (let y = clamp(tileY(n, z) - margin); y <= clamp(tileY(s, z) + margin); y++) {
      set.add(`${z}/${x}/${y}`);
    }
  }
}

function expand([lon, lat], meters) {
  const dLat = meters / 111320;
  const dLon = meters / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

// Tuiles couvrant la trace : toute la zone aux petits zooms, un couloir autour de la trace ensuite.
function coverTrack(track, maxZoom, margin) {
  const set = new Set();
  const [w, s, e, n] = track.bbox;
  const sw = expand([w, s], BBOX_MARGIN_METERS), ne = expand([e, n], BBOX_MARGIN_METERS);
  for (let z = 0; z < CORRIDOR_FROM_ZOOM && z <= maxZoom; z++) {
    addRange(set, z, [sw[0], sw[1], ne[2], ne[3]], margin);
  }
  for (let z = CORRIDOR_FROM_ZOOM; z <= maxZoom; z++) {
    let lastDist = -Infinity;
    track.points.forEach((p, i) => {
      if (track.dist[i] - lastDist < 200 && i !== track.points.length - 1) return;
      lastDist = track.dist[i];
      addRange(set, z, expand(p, CORRIDOR_METERS), margin);
    });
  }
  return [...set].map(k => k.split('/').map(Number));
}

export function tileUrlsForTrack(track) {
  // Les courbes de niveau ont besoin des tuiles d'altitude voisines (marge de 1).
  const dem = coverTrack(track, DEM_MAXZOOM, 1).map(([z, x, y]) => demUrl(z, x, y));
  const omt = coverTrack(track, OMT_MAXZOOM, 0).map(([z, x, y]) => omtUrl(z, x, y));
  return [...omt, ...dem];
}

export async function downloadTiles(urls, onProgress, concurrency = 6) {
  let done = 0, failed = 0, bytes = 0, next = 0;
  async function worker() {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!res.ok && res.status !== 404) throw new Error(res.status);
        bytes += (await res.arrayBuffer()).byteLength;
      } catch {
        failed++;
      }
      onProgress(++done, urls.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { total: urls.length, failed, bytes };
}
