// Cap de l'appareil : boussole (deviceorientationabsolute) lissée, en degrés depuis le nord.

const SMOOTHING = 0.25;
const RAD = Math.PI / 180;
const UPRIGHT_COS = 0.4; // au-delà d'environ 66° d'inclinaison, le téléphone est considéré debout
let listener = null;

// Direction du téléphone depuis le nord (repère : x = est, y = nord). Plutôt à plat ou incliné :
// direction du haut de l'écran, insensible au roulis. Presque debout (sur un guidon) : direction
// de l'arrière de l'appareil, car le haut de l'écran pointe alors vers le ciel.
function compassHeading(alpha, beta, gamma) {
  const [sA, cA] = [Math.sin(alpha * RAD), Math.cos(alpha * RAD)];
  const [sB, cB] = [Math.sin(beta * RAD), Math.cos(beta * RAD)];
  const [sG, cG] = [Math.sin(gamma * RAD), Math.cos(gamma * RAD)];
  const [east, north] = Math.abs(cB) > UPRIGHT_COS
    ? [-sA * cB, cA * cB]
    : [-(cA * sG + sA * sB * cG), -(sA * sG - cA * sB * cG)];
  return (Math.atan2(east, north) / RAD + 360) % 360;
}

// Écart signé le plus court entre deux angles (-180..180).
export const angleDelta = (from, to) => ((to - from + 540) % 360) - 180;

export function startCompass(onHeading) {
  stopCompass();
  let smoothed = null;
  listener = e => {
    if (e.alpha === null) return;
    const screenAngle = screen.orientation?.angle || 0;
    const raw = (compassHeading(e.alpha, e.beta, e.gamma) + screenAngle) % 360;
    smoothed = smoothed === null ? raw : (smoothed + SMOOTHING * angleDelta(smoothed, raw) + 360) % 360;
    onHeading(smoothed);
  };
  window.addEventListener('deviceorientationabsolute', listener);
}

export function stopCompass() {
  if (!listener) return;
  window.removeEventListener('deviceorientationabsolute', listener);
  listener = null;
}
