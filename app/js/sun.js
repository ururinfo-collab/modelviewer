// Sun position (NOAA approximation) for a place, date and local clock time.
import * as THREE from 'three';

const D2R = Math.PI / 180;

// returns { el, az } in degrees, az clockwise from north
export function sunPosition(utcMs, lat, lon) {
  const d = new Date(utcMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const doy = (utcMs - start) / 86400000;
  const g = 2 * Math.PI / 365 * (doy - 0.5);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const tst = utcMin + eqt + 4 * lon;
  const ha = (tst / 4 - 180) * D2R;
  const la = lat * D2R;
  const cosZ = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZ)));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(la) - Math.tan(decl) * Math.cos(la)) / D2R + 180;
  return { el: 90 - zen / D2R, az: (az + 360) % 360 };
}

// Direction to the sun in the model's source axes (SketchUp: Z up, north = +Y turned by northAngle).
export function sunVectorSrc(el, az, northAngle = 0) {
  const n = northAngle * D2R, a = az * D2R, e = el * D2R;
  const north = new THREE.Vector3(Math.sin(n), Math.cos(n), 0);
  const east = new THREE.Vector3(Math.cos(n), -Math.sin(n), 0);
  return new THREE.Vector3()
    .addScaledVector(east, Math.sin(a) * Math.cos(e))
    .addScaledVector(north, Math.cos(a) * Math.cos(e))
    .add(new THREE.Vector3(0, 0, Math.sin(e)));
}

// local clock time at the site -> UTC ms
export function localToUtc(year, month, day, minutes, tz) {
  return Date.UTC(year, month - 1, day, 0, 0) + (minutes - tz * 60) * 60000;
}

export const SKETCHUP_DEFAULT = { lat: 40.01700, lon: -105.28300 };   // Boulder, CO
export const FALLBACK = { lat: 16.8409, lon: 96.1735, tz: 6.5, north: 0, city: 'Yangon' };
