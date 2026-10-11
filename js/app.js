// Point d'entrée : parcours, GPS, carte, profil, montées, calage OSM et téléchargement hors ligne.
import { buildTrack, findClimbs, isLoop, parseGpx, pointAtDistance, rotateLoop, snap } from './gpx.js';
import { createMap, fitRoute, poiAt, setCursor, setMe, setRoute, showPopup } from './map.js';
import { createProfile } from './profile.js';
import { angleDelta, startCompass, stopCompass } from './heading.js';
import { downloadTiles, pruneTiles, refreshOmtTemplate, tileUrlsForTrack } from './offline.js';
import { DEVIATION_METERS, matchToOsm } from './match.js';
import { deleteRoute, getRoute, listRoutes, putRoute } from './store.js';

const OFF_ROUTE_METERS = 75;
const NEAR_ROUTE_METERS = 5000;
const PROGRESS_MAX_AGE_MS = 12 * 3600 * 1000;
const DEFAULT_FLAT_SPEED = 20; // km/h
const CLIMB_HOURS_PER_METER = 1 / 1000; // temps ajouté : 1 h par 1000 m de D+
const TAP_TOLERANCE_PX = 24;
const GPS_HEADING_MIN_SPEED = 2; // m/s (~7 km/h) : au-delà, le cap GPS est plus fiable que la boussole
const GPS_HEADING_FRESH_MS = 3000;
const ROTATE_INTERVAL_MS = 200;
const $ = id => document.getElementById(id);
const state = { route: null, track: null, climbs: [], mode: 'off', heading: null, lastRotate: 0, gpsHeadingAt: 0, prevDist: null, watchId: null, hadFix: false, lastCoords: null, downloading: new Set() };
let map, profile;

const kmNumber = m => (m / 1000).toFixed(1).replace('.', ',');
const fmtKm = m => `${kmNumber(m)} km`;
const fmtM = m => `${Math.round(m)} m`;
const sheetHeight = () => $('sheet').offsetHeight;
const flatSpeed = () => parseFloat(localStorage.getItem('flatSpeed')) || DEFAULT_FLAT_SPEED;

function fmtDuration(dist, up) {
  const min = Math.round(((dist / 1000) / flatSpeed() + up * CLIMB_HOURS_PER_METER) * 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

// ---------- Affichage ----------

function setStats(done, left, upLeft, time) {
  $('s-done').textContent = done;
  $('s-left').textContent = left;
  $('s-up').textContent = upLeft;
  $('s-time').textContent = time;
}

function setStatus(text, off = false) {
  $('status').textContent = text;
  $('status').classList.toggle('off', off);
}

function showTotals() {
  const t = state.track;
  if (!t) return setStats('–', '–', '–', '–');
  setStats('0 km', fmtKm(t.totalDist), fmtM(t.totalUp), fmtDuration(t.totalDist, t.totalUp));
}

function renderBadge() {
  const badge = $('offline-badge');
  badge.hidden = !state.route;
  if (!state.route) return;
  const ok = state.route.offline && !state.route.offline.failed;
  badge.textContent = ok ? '✓ Hors ligne' : 'Carte en ligne';
  badge.className = `badge ${ok ? 'ok' : 'warn'}`;
}

// Suivi de la position : 'off' (carte libre), 'north' (nord en haut) ou 'heading' (carte orientée).
function mapPadding(mode) {
  const top = 60 + (mode === 'heading' ? (window.innerHeight - sheetHeight() - 60) * 0.35 : 0);
  return { top, bottom: sheetHeight(), left: 0, right: 0 };
}

const meCenter = () => [state.lastCoords.longitude, state.lastCoords.latitude];

function setMode(mode) {
  state.mode = mode;
  $('locate-btn').classList.toggle('active', mode !== 'off');
  $('locate-btn').classList.toggle('heading', mode === 'heading');
  if (mode === 'heading' && !document.hidden) startCompass(onCompass);
  else stopCompass();
  if (mode === 'off') return;
  localStorage.setItem('followMode', mode);
  const camera = { padding: mapPadding(mode), duration: 300 };
  if (mode === 'north') camera.bearing = 0;
  if (mode === 'heading' && state.heading !== null) camera.bearing = state.heading;
  if (state.lastCoords) camera.center = meCenter();
  map.easeTo(camera);
}

// Tourne la carte vers le cap (au plus 5 fois par seconde, au-delà de 2° d'écart).
function applyHeading(h) {
  state.heading = h;
  if (state.lastCoords) setMe(map, state.lastCoords, h);
  const now = performance.now();
  if (now - state.lastRotate < ROTATE_INTERVAL_MS || Math.abs(angleDelta(map.getBearing(), h)) < 2) return;
  state.lastRotate = now;
  const camera = { bearing: h, duration: ROTATE_INTERVAL_MS, easing: t => t };
  if (state.lastCoords) camera.center = meCenter();
  map.easeTo(camera);
}

function onCompass(h) {
  if (state.mode !== 'heading' || performance.now() - state.gpsHeadingAt < GPS_HEADING_FRESH_MS) return;
  applyHeading(h);
}

function fitWholeRoute() {
  setMode('off');
  map.setPadding(mapPadding('off'));
  fitRoute(map, state.track);
}

// ---------- Parcours ----------

// Dernière position sur le parcours, gardée pour la retrouver si Android ferme l'appli pendant la sortie.
const progressKey = id => `progress:${id}`;

function saveProgress(dist) {
  localStorage.setItem(progressKey(state.route.id), JSON.stringify({ dist, at: Date.now() }));
}

function loadProgress(id) {
  const saved = JSON.parse(localStorage.getItem(progressKey(id)) || 'null');
  return saved && Date.now() - saved.at < PROGRESS_MAX_AGE_MS ? saved.dist : null;
}

async function selectRoute(route) {
  state.route = route;
  state.track = buildTrack(route.points);
  state.climbs = findClimbs(state.track);
  state.prevDist = loadProgress(route.id);
  localStorage.setItem('currentRoute', route.id);
  $('route-name').textContent = route.name;
  setRoute(map, state.track, route.waypoints || []);
  profile.setTrack(state.track);
  fitWholeRoute();
  showTotals();
  renderBadge();
  if (state.lastCoords) onPosition({ coords: state.lastCoords });
}

async function importFile(file) {
  try {
    const gpx = parseGpx(await file.text());
    const route = { id: crypto.randomUUID(), name: gpx.name || file.name.replace(/\.gpx$/i, ''),
      points: gpx.points, waypoints: gpx.waypoints, importedAt: Date.now(), offline: null };
    await putRoute(route);
    await selectRoute(route);
    await renderRouteList();
    closeDrawer();
  } catch (err) {
    alert(`Import impossible : ${err.message}`);
  }
}

async function removeRoute(route) {
  if (!confirm(`Supprimer « ${route.name} » ?`)) return;
  await deleteRoute(route.id);
  localStorage.removeItem(progressKey(route.id));
  const remaining = await listRoutes();
  await pruneTiles(remaining.flatMap(r => [r.points, r.originalPoints]).filter(Boolean).map(buildTrack));
  if (state.route?.id === route.id) {
    const [next] = remaining;
    if (next) await selectRoute(next);
    else location.reload();
  }
  await renderRouteList();
}

// ---------- Calage sur les chemins OSM ----------

async function saveRouteChanges(route, changes) {
  const fresh = { ...(await getRoute(route.id)), ...changes };
  await putRoute(fresh);
  if (state.route?.id === fresh.id) await selectRoute(fresh);
  await renderRouteList();
}

async function snapRoute(route, btn) {
  btn.disabled = true;
  btn.textContent = 'Calage en cours…';
  try {
    const { points, deviations } = await matchToOsm(route.points);
    const ask = `La trace calée s'écarte de plus de ${DEVIATION_METERS} m de l'originale à ${deviations} endroit(s). La garder quand même ?`;
    if (deviations && !confirm(ask)) return renderRouteList();
    await saveRouteChanges(route, { points, originalPoints: route.points });
  } catch (err) {
    alert(`Calage impossible : ${err.message}`);
    await renderRouteList();
  }
}

function matchBlock(route) {
  const btn = document.createElement('button');
  btn.className = 'btn small';
  if (route.originalPoints) {
    btn.textContent = 'Annuler le calage';
    btn.onclick = () => saveRouteChanges(route, { points: route.originalPoints, originalPoints: null });
  } else {
    btn.textContent = 'Caler sur OSM';
    btn.onclick = () => snapRoute(route, btn);
  }
  return btn;
}

// ---------- Sens et point de départ ----------

const reversed = points => [...points].reverse();

async function transformRoute(route, fn, changes = {}) {
  localStorage.removeItem(progressKey(route.id));
  await saveRouteChanges(route, { ...changes, points: fn(route.points),
    originalPoints: route.originalPoints && fn(route.originalPoints) });
}

function actionsBlock(route) {
  const row = document.createElement('div');
  row.className = 'btn-row';
  const reverse = document.createElement('button');
  reverse.className = 'btn small';
  reverse.textContent = 'Inverser le sens';
  reverse.onclick = () => transformRoute(route, reversed, { reversed: !route.reversed });
  row.append(matchBlock(route), reverse);
  return row;
}

// ---------- Hors ligne ----------

async function ensureServiceWorker() {
  if (navigator.serviceWorker.controller) return;
  await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
}

async function downloadRoute(route, bar) {
  state.downloading.add(route.id);
  await ensureServiceWorker();
  navigator.storage?.persist?.();
  await refreshOmtTemplate();
  const urls = tileUrlsForTrack(buildTrack(route.points));
  const result = await downloadTiles(urls, (done, total) => { bar.style.width = `${(done / total) * 100}%`; });
  const fresh = await getRoute(route.id);
  if (fresh) {
    fresh.offline = { at: Date.now(), tiles: result.total, failed: result.failed, bytes: result.bytes };
    await putRoute(fresh);
    if (state.route?.id === fresh.id) state.route = fresh;
  }
  state.downloading.delete(route.id);
  renderBadge();
  await renderRouteList();
}

function offlineBlock(route) {
  const box = document.createElement('div');
  const o = route.offline;
  if (o && !o.failed && !state.downloading.has(route.id)) {
    box.className = 'offline-ok';
    box.textContent = `✓ Carte hors ligne (${(o.bytes / 1e6).toFixed(1).replace('.', ',')} Mo)`;
    return box;
  }
  const btn = document.createElement('button');
  btn.className = 'btn small';
  btn.textContent = o?.failed ? `Incomplet (${o.failed} tuiles) – Réessayer` : 'Télécharger la carte';
  const progress = document.createElement('div');
  progress.className = 'progress';
  progress.hidden = !state.downloading.has(route.id);
  const bar = document.createElement('div');
  progress.append(bar);
  btn.disabled = state.downloading.has(route.id);
  btn.onclick = () => {
    btn.disabled = true; btn.textContent = 'Téléchargement…'; progress.hidden = false;
    downloadRoute(route, bar).catch(err => alert(`Téléchargement interrompu : ${err.message}`));
  };
  box.append(btn, progress);
  return box;
}

function routeItem(route) {
  const li = document.createElement('li');
  li.classList.toggle('current', state.route?.id === route.id);
  const t = buildTrack(route.points);
  const row = document.createElement('div');
  row.className = 'route-row';
  const pick = document.createElement('button');
  pick.className = 'route-pick';
  pick.innerHTML = '<strong></strong><span class="route-meta"></span>';
  pick.querySelector('strong').textContent = route.name;
  pick.querySelector('.route-meta').textContent =
    `${fmtKm(t.totalDist)} · D+ ${fmtM(t.totalUp)}${route.originalPoints ? ' · calée sur OSM' : ''}` +
    (route.reversed ? ' · sens inversé' : '');
  pick.onclick = async () => { await selectRoute(route); await renderRouteList(); closeDrawer(); };
  const del = document.createElement('button');
  del.className = 'route-del';
  del.setAttribute('aria-label', 'Supprimer');
  del.textContent = '🗑';
  del.onclick = () => removeRoute(route);
  row.append(pick, del);
  li.append(row, actionsBlock(route), offlineBlock(route));
  return li;
}

async function renderRouteList() {
  const routes = (await listRoutes()).sort((a, b) => b.importedAt - a.importedAt);
  $('route-list').replaceChildren(...routes.map(routeItem));
  const est = await navigator.storage?.estimate?.();
  if (est) $('storage').textContent = `Espace utilisé : ${(est.usage / 1e6).toFixed(1).replace('.', ',')} Mo`;
}

function openDrawer() { $('drawer').hidden = false; $('drawer-backdrop').hidden = false; renderRouteList(); }
function closeDrawer() { $('drawer').hidden = true; $('drawer-backdrop').hidden = true; }

// ---------- GPS ----------

function climbStatus(d) {
  const c = state.climbs.find(climb => climb.end > d);
  if (!c) return 'Plus de montée importante';
  if (c.start <= d) {
    const gainLeft = pointAtDistance(state.track, c.end).ele - pointAtDistance(state.track, d).ele;
    return `Montée en cours : encore ${fmtKm(c.end - d)}, +${fmtM(Math.max(0, gainLeft))}`;
  }
  return `Montée dans ${fmtKm(c.start - d)} : ${fmtKm(c.end - c.start)} à ${c.grade.toFixed(0)} % (+${fmtM(c.gain)})`;
}

function updateProgress(coords) {
  const t = state.track;
  const s = snap(t, coords.longitude, coords.latitude, state.prevDist);
  if (s.offset > NEAR_ROUTE_METERS) {
    showTotals();
    profile.setCurrent(null);
    return setStatus(`Vous êtes à ${fmtKm(s.offset)} du parcours`);
  }
  state.prevDist = s.dist;
  saveProgress(s.dist);
  profile.setCurrent(s.dist);
  const left = t.totalDist - s.dist, upLeft = t.totalUp - s.up;
  setStats(fmtKm(s.dist), fmtKm(left), fmtM(upLeft), fmtDuration(left, upLeft));
  if (s.offset > OFF_ROUTE_METERS) setStatus(`Hors trace · ${fmtM(s.offset)} de la trace`, true);
  else setStatus(climbStatus(s.dist));
}

function onPosition({ coords }) {
  state.lastCoords = coords;
  const gpsHeading = coords.speed > GPS_HEADING_MIN_SPEED && Number.isFinite(coords.heading) ? coords.heading : null;
  if (gpsHeading !== null) state.gpsHeadingAt = performance.now();
  setMe(map, coords, state.mode === 'heading' ? state.heading : null);
  if (state.track) updateProgress(coords);
  else setStatus('');
  const center = [coords.longitude, coords.latitude];
  if (!state.hadFix) {
    state.hadFix = true;
    const near = !state.track || snap(state.track, ...center).offset < NEAR_ROUTE_METERS;
    if (near) {
      map.jumpTo({ center, zoom: Math.max(map.getZoom(), 15) });
      setMode(localStorage.getItem('followMode') || 'north');
    }
    return;
  }
  if (state.mode === 'heading' && gpsHeading !== null) {
    state.lastRotate = 0;
    applyHeading(gpsHeading);
  } else if (state.mode !== 'off') {
    map.easeTo({ center, duration: 600 });
  }
}

function onGpsError(err) {
  if (!state.lastCoords) setStatus(err.code === 1 ? 'Localisation refusée' : 'Recherche du signal GPS…');
}

function startGps() {
  if (state.watchId !== null || !navigator.geolocation) return;
  state.hadFix = false;
  if (!state.lastCoords) setStatus('Recherche du signal GPS…');
  state.watchId = navigator.geolocation.watchPosition(onPosition, onGpsError,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}

function stopGps() {
  if (state.watchId === null) return;
  navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
}

// ---------- Carte : toucher un point utile ou la trace ----------

function popupContent(text, action) {
  const box = document.createElement('div');
  box.className = 'popup';
  box.textContent = text;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.textContent = action.label;
    btn.onclick = action.run;
    box.append(btn);
  }
  return box;
}

function onMapClick(e) {
  const poi = poiAt(map, e.point);
  if (poi) return showPopup(map, e.lngLat, popupContent(poi.name ? `${poi.label} · ${poi.name}` : poi.label));
  if (!state.track) return;
  const s = snap(state.track, e.lngLat.lng, e.lngLat.lat, state.prevDist);
  const px = map.project([s.lon, s.lat]);
  if (Math.hypot(px.x - e.point.x, px.y - e.point.y) > TAP_TOLERANCE_PX) return;
  const route = state.route;
  let popup = null;
  const action = isLoop(route.points) && {
    label: "Partir d'ici",
    run: () => { popup.remove(); transformRoute(route, points => rotateLoop(points, s.lon, s.lat)); },
  };
  popup = showPopup(map, [s.lon, s.lat], popupContent(`Km ${kmNumber(s.dist)} · altitude ${fmtM(s.ele)}`, action));
}

function refreshStats() {
  if (state.track && state.lastCoords) updateProgress(state.lastCoords);
  else showTotals();
}

// ---------- Initialisation ----------

function onScrub(d) {
  if (d === null) return setCursor(map, null);
  const p = pointAtDistance(state.track, d);
  setCursor(map, p);
  if (!map.getBounds().contains([p.lon, p.lat])) { setMode('off'); map.easeTo({ center: [p.lon, p.lat], duration: 300 }); }
}

function bindUi() {
  $('menu-btn').onclick = openDrawer;
  $('offline-badge').onclick = openDrawer;
  $('drawer-close').onclick = closeDrawer;
  $('drawer-backdrop').onclick = closeDrawer;
  $('file-input').onchange = e => { const [f] = e.target.files; e.target.value = ''; if (f) importFile(f); };
  $('fit-btn').onclick = () => { if (state.track) fitWholeRoute(); };
  // Appuis successifs : suivi (dernier mode utilisé) → nord en haut ↔ carte orientée.
  $('locate-btn').onclick = () => {
    if (!state.lastCoords) { startGps(); return setStatus('Recherche du signal GPS…'); }
    if (state.mode === 'off') map.jumpTo({ zoom: Math.max(map.getZoom(), 15) });
    const next = { off: localStorage.getItem('followMode') || 'north', north: 'heading', heading: 'north' }[state.mode];
    setMode(next);
  };
  $('north-btn').onclick = () => {
    if (state.mode === 'heading') setMode('north');
    else map.easeTo({ bearing: 0, duration: 300 });
  };
  map.on('rotate', () => {
    const bearing = map.getBearing();
    $('north-btn').hidden = Math.abs(bearing) < 1;
    $('north-needle').style.transform = `rotate(${-bearing}deg)`;
  });
  $('speed-input').value = flatSpeed();
  $('speed-input').onchange = e => {
    const v = parseFloat(e.target.value);
    if (v >= 5 && v <= 60) localStorage.setItem('flatSpeed', v);
    e.target.value = flatSpeed();
    refreshStats();
  };
  map.on('click', onMapClick);
  map.on('dragstart', () => setMode('off'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopGps(); stopCompass(); return; }
    startGps();
    if (state.mode === 'heading') startCompass(onCompass);
  });
}

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  await refreshOmtTemplate();
  map = await createMap('map');
  map.setPadding(mapPadding('off'));
  profile = createProfile($('profile'), onScrub);
  bindUi();
  const routes = await listRoutes();
  const current = routes.find(r => r.id === localStorage.getItem('currentRoute')) || routes[0];
  if (current) await selectRoute(current);
  else openDrawer();
  startGps();
}

init();
