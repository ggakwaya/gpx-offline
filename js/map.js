// Carte MapLibre : fond topo (OpenFreeMap + relief), trace, position.
/* global maplibregl, mlcontour */
import { DEM_MAXZOOM, DEM_URL, omtUrl } from './offline.js';
import { pointAtDistance } from './gpx.js';

const ROUTE_COLOR = '#e6007e';
const NAME = ['coalesce', ['get', 'name:fr'], ['get', 'name']];
const EMPTY = { type: 'FeatureCollection', features: [] };

// Points utiles, tirés de la couche poi d'OpenMapTiles (déjà présente dans les tuiles hors ligne).
const POI_LABELS = { water: 'Eau potable', toilets: 'Toilettes', shelter: 'Abri', hut: 'Refuge / chalet', parking: 'Stationnement' };
const HUTS = ['alpine_hut', 'wilderness_hut', 'chalet'];
const POI_KIND = ['case',
  ['==', ['get', 'class'], 'drinking_water'], 'water',
  ['in', ['get', 'class'], ['literal', ['toilets', 'shelter', 'parking']]], ['get', 'class'],
  ['in', ['get', 'subclass'], ['literal', HUTS]], 'hut',
  ''];

// Même règle que POI_KIND, pour un objet déjà affiché sur la carte.
function poiKind({ class: cls, subclass }) {
  if (cls === 'drinking_water') return 'water';
  if (['toilets', 'shelter', 'parking'].includes(cls)) return cls;
  return HUTS.includes(subclass) ? 'hut' : null;
}

// Les requêtes passent par le thread principal pour être servies par le service worker.
function registerProtocols() {
  maplibregl.addProtocol('omt', async (params, abort) => {
    const [z, x, y] = params.url.slice('omt://'.length).split('/');
    const res = await fetch(omtUrl(z, x, y), { signal: abort.signal });
    if (res.status === 404) return { data: new ArrayBuffer(0) };
    if (!res.ok) throw new Error(`Tuile ${z}/${x}/${y}: ${res.status}`);
    return { data: await res.arrayBuffer() };
  });
  maplibregl.addProtocol('font', async params => {
    const res = await fetch(`fonts/${params.url.slice('font://'.length)}.pbf`);
    return { data: res.ok ? await res.arrayBuffer() : new ArrayBuffer(0) };
  });
}

function roadLayers() {
  const unpaved = ['any', ['==', ['get', 'class'], 'track'], ['==', ['get', 'surface'], 'unpaved']];
  const roads = ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'track'], true, false];
  const width = (base, mul = 1) =>
    ['interpolate', ['exponential', 1.5], ['zoom'], 10, ['*', mul, base * 0.4], 14, ['*', mul, base * 1.4], 17, ['*', mul, base * 4]];
  const classWidth = ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], 3, ['secondary', 'tertiary'], 2.4, 1.6];
  const src = { source: 'omt', 'source-layer': 'transportation' };
  return [
    { id: 'path', type: 'line', ...src, minzoom: 12, filter: ['==', ['get', 'class'], 'path'],
      paint: { 'line-color': '#7a5c45', 'line-width': width(0.8), 'line-dasharray': [2, 1.5] } },
    { id: 'road-casing', type: 'line', ...src, filter: ['all', roads, ['!', unpaved]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#9a8f80', 'line-width': width(1.3, classWidth) } },
    { id: 'road', type: 'line', ...src, filter: ['all', roads, ['!', unpaved]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], '#ffd38a', '#ffffff'],
        'line-width': width(1, classWidth) } },
    { id: 'gravel-bg', type: 'line', ...src, filter: ['all', roads, unpaved],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': '#f3e3c3', 'line-width': width(1.2, classWidth) } },
    { id: 'gravel', type: 'line', ...src, filter: ['all', roads, unpaved],
      paint: { 'line-color': '#9c5a1f', 'line-width': width(0.9), 'line-dasharray': [3, 1.5] } },
  ];
}

function baseLayers() {
  return [
    { id: 'bg', type: 'background', paint: { 'background-color': '#f4f1e8' } },
    { id: 'landcover', type: 'fill', source: 'omt', 'source-layer': 'landcover',
      paint: { 'fill-color': ['match', ['get', 'class'], 'wood', '#cfe3bf', 'wetland', '#d5e6e0',
        ['grass', 'farmland'], '#e6eccf', 'rock', '#e2ddd5', 'ice', '#ffffff', '#e8ead9'] } },
    { id: 'park', type: 'line', source: 'omt', 'source-layer': 'park',
      paint: { 'line-color': '#5d8a4a', 'line-width': 1, 'line-opacity': 0.5, 'line-dasharray': [4, 2] } },
    { id: 'hillshade', type: 'hillshade', source: 'dem',
      paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#5b4a3a', 'hillshade-highlight-color': '#ffffff' } },
    { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': '#a9cbe6' } },
    { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway',
      paint: { 'line-color': '#7fb0d8', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 15, 2] } },
    { id: 'contour', type: 'line', source: 'contours', 'source-layer': 'contours',
      paint: { 'line-color': '#b07a4a', 'line-opacity': 0.55,
        'line-width': ['match', ['get', 'level'], 1, 1.1, 0.5] } },
    ...roadLayers(),
  ];
}

function labelLayers() {
  const halo = { 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.4 };
  return [
    { id: 'contour-label', type: 'symbol', source: 'contours', 'source-layer': 'contours',
      filter: ['>', ['get', 'level'], 0],
      layout: { 'symbol-placement': 'line', 'text-field': ['concat', ['to-string', ['get', 'ele']], ' m'],
        'text-font': ['noto-regular'], 'text-size': 10 },
      paint: { 'text-color': '#8a5a30', ...halo } },
    { id: 'water-name', type: 'symbol', source: 'omt', 'source-layer': 'water_name',
      layout: { 'text-field': NAME, 'text-font': ['noto-italic'], 'text-size': 12 },
      paint: { 'text-color': '#2f6a9a', ...halo } },
    { id: 'road-name', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 13,
      layout: { 'symbol-placement': 'line', 'text-field': NAME, 'text-font': ['noto-regular'], 'text-size': 11 },
      paint: { 'text-color': '#4a4036', ...halo } },
    { id: 'peak', type: 'symbol', source: 'omt', 'source-layer': 'mountain_peak',
      layout: { 'text-field': ['concat', '▲ ', NAME, '\n', ['to-string', ['get', 'ele']], ' m'],
        'text-font': ['noto-regular'], 'text-size': 11 },
      paint: { 'text-color': '#5b4a3a', ...halo } },
    { id: 'place', type: 'symbol', source: 'omt', 'source-layer': 'place',
      layout: { 'text-field': NAME, 'text-font': ['noto-bold'],
        'text-size': ['match', ['get', 'class'], ['city', 'town'], 15, 12] },
      paint: { 'text-color': '#2b2b2b', ...halo } },
  ];
}

function overlayLayers() {
  return [
    { id: 'route-casing', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 10] } },
    { id: 'route', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ROUTE_COLOR, 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 16, 6] } },
    { id: 'route-arrows', type: 'symbol', source: 'route', minzoom: 12,
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 90, 'icon-image': 'arrow',
        'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 0.8] } },
    { id: 'poi', type: 'symbol', source: 'omt', 'source-layer': 'poi', minzoom: 13, filter: ['!=', POI_KIND, ''],
      layout: { 'icon-image': ['concat', 'poi-', POI_KIND], 'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.75, 16, 1],
        'text-field': ['step', ['zoom'], '', 15, NAME], 'text-font': ['noto-regular'], 'text-size': 11,
        'text-anchor': 'top', 'text-offset': [0, 1.2], 'text-optional': true },
      paint: { 'text-color': '#3b3026', 'text-halo-color': '#fff', 'text-halo-width': 1.4 } },
    { id: 'km', type: 'symbol', source: 'km',
      filter: ['any', ['==', ['%', ['get', 'km'], 5], 0], ['>=', ['zoom'], 14]],
      layout: { 'text-field': ['to-string', ['get', 'km']], 'text-font': ['noto-bold'], 'text-size': 11 },
      paint: { 'text-color': ROUTE_COLOR, 'text-halo-color': '#fff', 'text-halo-width': 2 } },
    { id: 'ends', type: 'circle', source: 'ends',
      paint: { 'circle-radius': 7, 'circle-color': ['match', ['get', 'kind'], 'start', '#1e9e4a', '#d32f2f'],
        'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } },
    { id: 'wpt', type: 'symbol', source: 'wpt',
      layout: { 'text-field': ['concat', '● ', ['get', 'name']], 'text-font': ['noto-bold'], 'text-size': 11,
        'text-anchor': 'left', 'text-offset': [-0.4, 0] },
      paint: { 'text-color': '#1d3f8a', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } },
    { id: 'cursor', type: 'circle', source: 'cursor',
      paint: { 'circle-radius': 7, 'circle-color': '#ff9800', 'circle-stroke-color': '#222', 'circle-stroke-width': 2 } },
    { id: 'me-accuracy', type: 'fill', source: 'me', filter: ['==', ['get', 'kind'], 'accuracy'],
      paint: { 'fill-color': '#1a73e8', 'fill-opacity': 0.12 } },
    { id: 'me-heading', type: 'symbol', source: 'me', filter: ['==', ['get', 'kind'], 'heading'],
      layout: { 'icon-image': 'heading', 'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-ignore-placement': true } },
    { id: 'me', type: 'circle', source: 'me', filter: ['==', ['get', 'kind'], 'dot'],
      paint: { 'circle-radius': 8, 'circle-color': '#1a73e8', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } },
  ];
}

function buildStyle(demSource) {
  const geo = { type: 'geojson', data: EMPTY };
  return {
    version: 8,
    glyphs: 'font://{fontstack}/{range}',
    sources: {
      omt: { type: 'vector', tiles: ['omt://{z}/{x}/{y}'], maxzoom: 14,
        attribution: '© <a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
      dem: { type: 'raster-dem', encoding: 'terrarium', tiles: [demSource.sharedDemProtocolUrl], tileSize: 256, maxzoom: DEM_MAXZOOM,
        attribution: '<a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a>' },
      contours: { type: 'vector', maxzoom: 15, tiles: [demSource.contourProtocolUrl({
        thresholds: { 11: [50, 250], 12: [20, 100], 13: [20, 100], 14: [10, 50], 15: [10, 50] },
        contourLayer: 'contours', elevationKey: 'ele', levelKey: 'level' })] },
      route: geo, km: geo, ends: geo, wpt: geo, cursor: geo, me: geo,
    },
    layers: [...baseLayers(), ...labelLayers(), ...overlayLayers()],
  };
}

function drawIcon(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  return c.getContext('2d').getImageData(0, 0, size, size);
}

function poiIcon(color, glyph) {
  return drawIcon(48, (ctx, s) => {
    ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2 - 3, 0, 2 * Math.PI);
    ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.lineJoin = 'round';
    glyph(ctx, s);
  });
}

const textGlyph = (text, size) => (ctx, s) => {
  ctx.font = `bold ${size}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, s / 2, s / 2 + 1);
};

function polygonGlyph(points) {
  return (ctx, s) => {
    ctx.beginPath();
    points.forEach(([x, y]) => ctx.lineTo(x * s, y * s));
    ctx.closePath(); ctx.fill();
  };
}

const POI_ICONS = {
  water: ['#1976d2', (ctx, s) => {
    ctx.beginPath(); ctx.moveTo(s / 2, s * 0.2);
    ctx.bezierCurveTo(s * 0.74, s * 0.48, s * 0.72, s * 0.76, s / 2, s * 0.77);
    ctx.bezierCurveTo(s * 0.28, s * 0.76, s * 0.26, s * 0.48, s / 2, s * 0.2); ctx.fill();
  }],
  toilets: ['#5c6bc0', textGlyph('WC', 17)],
  parking: ['#1565c0', textGlyph('P', 26)],
  shelter: ['#8d6e63', (ctx, s) => {
    ctx.beginPath(); ctx.moveTo(s * 0.2, s * 0.56); ctx.lineTo(s / 2, s * 0.26); ctx.lineTo(s * 0.8, s * 0.56); ctx.stroke();
    ctx.fillRect(s * 0.3, s * 0.52, 4, s * 0.24); ctx.fillRect(s * 0.7 - 4, s * 0.52, 4, s * 0.24);
  }],
  hut: ['#6d4c41', polygonGlyph([[0.5, 0.22], [0.8, 0.5], [0.7, 0.5], [0.7, 0.77], [0.3, 0.77], [0.3, 0.5], [0.2, 0.5]])],
};

function addIcons(map) {
  Object.entries(POI_ICONS).forEach(([kind, [color, glyph]]) =>
    map.addImage(`poi-${kind}`, poiIcon(color, glyph), { pixelRatio: 2 }));
  map.addImage('arrow', drawIcon(32, (ctx, s) => {
    ctx.beginPath(); ctx.moveTo(s * 0.3, s * 0.2); ctx.lineTo(s * 0.75, s * 0.5); ctx.lineTo(s * 0.3, s * 0.8);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
  }), { pixelRatio: 2 });
  map.addImage('heading', drawIcon(64, (ctx, s) => {
    ctx.beginPath(); ctx.moveTo(s / 2, 2); ctx.lineTo(s * 0.72, s * 0.42); ctx.lineTo(s * 0.28, s * 0.42); ctx.closePath();
    ctx.fillStyle = '#1a73e8'; ctx.fill();
  }), { pixelRatio: 2 });
}

export function createMap(container) {
  registerProtocols();
  const demSource = new mlcontour.DemSource({ url: DEM_URL, encoding: 'terrarium', maxzoom: DEM_MAXZOOM, worker: false });
  demSource.setupMaplibre(maplibregl);
  const map = new maplibregl.Map({
    container, style: buildStyle(demSource), center: [-71.2, 47.27], zoom: 11,
    attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, maxZoom: 17,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  return new Promise(resolve => map.on('load', () => { addIcons(map); resolve(map); }));
}

const point = (lon, lat, props = {}) =>
  ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
const collection = features => ({ type: 'FeatureCollection', features });

function kmMarkers(track) {
  const features = [];
  for (let km = 1; km * 1000 < track.totalDist; km++) {
    const p = pointAtDistance(track, km * 1000);
    features.push(point(p.lon, p.lat, { km }));
  }
  return collection(features);
}

export function setRoute(map, track, waypoints) {
  const coords = track.points.map(([lon, lat]) => [lon, lat]);
  const [first, last] = [coords[0], coords[coords.length - 1]];
  map.getSource('route').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  map.getSource('km').setData(kmMarkers(track));
  map.getSource('ends').setData(collection([point(...last, { kind: 'end' }), point(...first, { kind: 'start' })]));
  map.getSource('wpt').setData(collection(waypoints.map(w => point(w.lon, w.lat, { name: w.name }))));
}

// La marge s'ajoute à celle de la carte (barre du haut et panneau du bas).
export function fitRoute(map, track) {
  const [w, s, e, n] = track.bbox;
  map.fitBounds([[w, s], [e, n]], { padding: 30, duration: 0 });
}

function accuracyCircle(lon, lat, meters) {
  const ring = [];
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * 2 * Math.PI;
    ring.push([lon + (meters * Math.cos(a)) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (meters * Math.sin(a)) / 111320]);
  }
  return { type: 'Feature', properties: { kind: 'accuracy' }, geometry: { type: 'Polygon', coordinates: [ring] } };
}

export function setMe(map, coords) {
  if (!coords) return map.getSource('me').setData(EMPTY);
  const { longitude: lon, latitude: lat, accuracy, heading, speed } = coords;
  const features = [accuracyCircle(lon, lat, accuracy), point(lon, lat, { kind: 'dot' })];
  if (Number.isFinite(heading) && speed > 1) features.push(point(lon, lat, { kind: 'heading', heading }));
  map.getSource('me').setData(collection(features));
}

export function setCursor(map, p) {
  map.getSource('cursor').setData(p ? point(p.lon, p.lat) : EMPTY);
}

// Point utile sous le doigt (tolérance de 14 px), ou null.
export function poiAt(map, point) {
  const box = [[point.x - 14, point.y - 14], [point.x + 14, point.y + 14]];
  const [f] = map.queryRenderedFeatures(box, { layers: ['poi'] });
  const kind = f && poiKind(f.properties);
  return kind ? { label: POI_LABELS[kind], name: f.properties['name:fr'] || f.properties.name || '' } : null;
}

export function showPopup(map, lngLat, content) {
  return new maplibregl.Popup({ closeButton: false, offset: 14, maxWidth: '240px' })
    .setLngLat(lngLat).setDOMContent(content).addTo(map);
}
