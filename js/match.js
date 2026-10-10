// Calage d'une trace sur les chemins OpenStreetMap avec le service Valhalla public de FOSSGIS.
import { buildTrack, haversine, pointAtDistance, snap } from './gpx.js';

const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/trace_attributes';
const MAX_SHAPE_POINTS = 4000;
const DENSIFY_METERS = 15;
// Au-delà de la dérive GPS habituelle en forêt (20-50 m) : signale un vrai détour.
export const DEVIATION_METERS = 100;

// Points espacés d'au moins `spacing` mètres, en gardant toujours le dernier.
function thin(points, spacing) {
  const out = [points[0]];
  for (const p of points.slice(1, -1)) {
    const last = out[out.length - 1];
    if (haversine(last[0], last[1], p[0], p[1]) >= spacing) out.push(p);
  }
  out.push(points[points.length - 1]);
  return out;
}

function decodePolyline6(str) {
  const coords = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let shift = 0, result = 0, b;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next(); lon += next();
    coords.push([lon / 1e6, lat / 1e6]);
  }
  return coords;
}

async function requestMatch(track) {
  const spacing = Math.max(10, track.totalDist / MAX_SHAPE_POINTS);
  const shape = thin(track.points, spacing).map(([lon, lat]) => ({ lat, lon }));
  const res = await fetch(VALHALLA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(90000),
    body: JSON.stringify({
      shape, costing: 'bicycle', shape_match: 'map_snap',
      costing_options: { bicycle: { bicycle_type: 'Mountain' } },
      filters: { attributes: ['shape'], action: 'include' },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.shape) throw new Error(json.error || `serveur Valhalla (${res.status})`);
  return decodePolyline6(json.shape);
}

// Ajoute des points tous les ~15 m pour que l'altitude suive le relief sur les longues lignes droites.
function densify(coords) {
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1], [lon2, lat2] = coords[i];
    const n = Math.ceil(haversine(lon1, lat1, lon2, lat2) / DENSIFY_METERS);
    for (let k = 1; k <= n; k++) out.push([lon1 + ((lon2 - lon1) * k) / n, lat1 + ((lat2 - lat1) * k) / n]);
  }
  return out;
}

// Nombre d'endroits où la trace `from` (échantillonnée tous les 50 m) s'éloigne de `to` de plus de DEVIATION_METERS.
function countDeviations(from, to) {
  let count = 0, away = false, prev = null;
  for (let d = 0; d <= from.totalDist; d += 50) {
    const p = pointAtDistance(from, d);
    const s = snap(to, p.lon, p.lat, prev);
    prev = s.dist;
    if (s.offset > DEVIATION_METERS && !away) count++;
    away = s.offset > DEVIATION_METERS;
  }
  return count;
}

// Renvoie la trace calée (altitudes reprises du GPX d'origine) et le nombre d'écarts importants.
export async function matchToOsm(points) {
  const original = buildTrack(points);
  const coords = densify(await requestMatch(original));
  let prev = null;
  const matched = coords.map(([lon, lat]) => {
    const s = snap(original, lon, lat, prev);
    prev = s.dist;
    return [lon, lat, Math.round(s.ele * 10) / 10];
  });
  const track = buildTrack(matched);
  const deviations = countDeviations(original, track) + countDeviations(track, original);
  return { points: matched, deviations };
}
