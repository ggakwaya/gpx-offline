// Profil d'altitude (canvas), coloré selon la pente, avec curseur à la position actuelle.
import { gradeAt, pointAtDistance } from './gpx.js';

const PAD = { left: 36, right: 8, top: 8, bottom: 16 };

function gradeColor(g) {
  if (g < 0) return '#b9c9a8';
  if (g < 3) return '#8bc34a';
  if (g < 6) return '#ffc107';
  if (g < 9) return '#ff7a00';
  return '#e53935';
}

export function createProfile(canvas, onScrub) {
  const ctx = canvas.getContext('2d');
  let track = null, columns = [], minEle = 0, maxEle = 1, current = null, scrub = null;

  const plotW = () => canvas.clientWidth - PAD.left - PAD.right;
  const plotH = () => canvas.clientHeight - PAD.top - PAD.bottom;
  const xOf = d => PAD.left + (d / track.totalDist) * plotW();
  const yOf = e => PAD.top + plotH() * (1 - (e - minEle) / (maxEle - minEle));

  function sample() {
    const w = Math.max(1, Math.floor(plotW()));
    const window = Math.max(250, (track.totalDist / w) * 3);
    columns = Array.from({ length: w + 1 }, (_, i) => {
      const d = (i / w) * track.totalDist;
      return { d, ele: pointAtDistance(track, d).ele, grade: gradeAt(track, d, window) };
    });
    const eles = track.points.map(p => p[2]);
    minEle = Math.min(...eles); maxEle = Math.max(...eles);
    const pad = Math.max(10, (maxEle - minEle) * 0.1);
    minEle -= pad; maxEle += pad;
  }

  function drawAxes() {
    ctx.fillStyle = '#6b6258'; ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const lo = Math.ceil(minEle / 50) * 50, hi = Math.floor(maxEle / 50) * 50;
    const step = (hi - lo) > 300 ? 100 : 50;
    for (let e = lo; e <= hi; e += step) {
      ctx.fillText(`${e}`, PAD.left - 4, yOf(e));
      ctx.fillStyle = 'rgba(0,0,0,0.06)'; ctx.fillRect(PAD.left, Math.round(yOf(e)), plotW(), 1); ctx.fillStyle = '#6b6258';
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const kmStep = track.totalDist > 60000 ? 10 : 5;
    for (let km = kmStep; km * 1000 < track.totalDist; km += kmStep) ctx.fillText(`${km}`, xOf(km * 1000), canvas.clientHeight - 3);
  }

  function drawMarker(d, color, label) {
    const p = pointAtDistance(track, d);
    const x = xOf(d);
    ctx.fillStyle = color; ctx.fillRect(x - 1, PAD.top, 2, plotH());
    ctx.beginPath(); ctx.arc(x, yOf(p.ele), 4.5, 0, 2 * Math.PI); ctx.fill();
    if (!label) return;
    ctx.font = 'bold 11px system-ui, sans-serif';
    const w = ctx.measureText(label).width + 10;
    const bx = Math.min(Math.max(PAD.left, x - w / 2), canvas.clientWidth - PAD.right - w);
    ctx.fillStyle = 'rgba(20,20,20,0.85)'; ctx.fillRect(bx, PAD.top, w, 17);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(label, bx + 5, PAD.top + 9);
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    if (!track) return;
    const base = PAD.top + plotH();
    for (let i = 0; i < columns.length - 1; i++) {
      const c = columns[i];
      ctx.fillStyle = gradeColor(c.grade);
      ctx.fillRect(PAD.left + i, yOf(c.ele), 1.5, base - yOf(c.ele));
    }
    ctx.beginPath();
    columns.forEach((c, i) => ctx.lineTo(PAD.left + i, yOf(c.ele)));
    ctx.strokeStyle = '#4a3f35'; ctx.lineWidth = 1.2; ctx.stroke();
    drawAxes();
    if (current !== null) drawMarker(current, '#1a73e8');
    if (scrub !== null) {
      const p = pointAtDistance(track, scrub);
      const g = gradeAt(track, scrub);
      drawMarker(scrub, '#222', `km ${(scrub / 1000).toFixed(1).replace('.', ',')} · ${Math.round(p.ele)} m · ${g.toFixed(0)} %`);
    }
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    if (track) sample();
    draw();
  }

  function scrubFromEvent(e) {
    if (!track) return;
    const x = e.clientX - canvas.getBoundingClientRect().left;
    scrub = Math.min(track.totalDist, Math.max(0, ((x - PAD.left) / plotW()) * track.totalDist));
    onScrub(scrub);
    draw();
  }

  function endScrub() {
    if (scrub === null) return;
    scrub = null;
    onScrub(null);
    draw();
  }

  canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); scrubFromEvent(e); });
  canvas.addEventListener('pointermove', e => { if (canvas.hasPointerCapture(e.pointerId)) scrubFromEvent(e); });
  canvas.addEventListener('pointerup', endScrub);
  canvas.addEventListener('pointercancel', endScrub);
  new ResizeObserver(resize).observe(canvas);

  return {
    setTrack(t) { track = t; current = null; resize(); },
    setCurrent(d) { current = d; draw(); },
  };
}
