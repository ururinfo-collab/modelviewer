// Length display: metres, millimetres, or feet-inches.
let unit = 'm';
try { unit = localStorage.getItem('mv:unit') || 'm'; } catch { /* private mode */ }

export const UNITS = { m: 'Metres', mm: 'Millimetres', ft: 'Feet + inches' };
export const getUnit = () => unit;
export function setUnit(u) {
  unit = u;
  try { localStorage.setItem('mv:unit', u); } catch { /* private mode */ }
}

export function fmt(m) {
  if (unit === 'mm') return `${Math.round(m * 1000).toLocaleString()} mm`;
  if (unit === 'ft') {
    const sign = m < 0 ? '-' : '';
    let inches = Math.round(Math.abs(m) / 0.0254 * 4) / 4;
    const ft = Math.floor(inches / 12);
    inches -= ft * 12;
    return `${sign}${ft}' ${inches.toFixed(inches % 1 ? 2 : 0).replace(/\.?0+$/, '')}"`;
  }
  return `${m.toFixed(m < 10 ? 3 : 2)} m`;
}

export function fmtArea(m2) {
  return unit === 'ft' ? `${(m2 / 0.092903).toFixed(1)} sq ft` : `${m2.toFixed(2)} m²`;
}

export function fmtVol(m3) {
  return unit === 'ft' ? `${(m3 / 0.0283168).toFixed(2)} cu ft` : `${m3.toFixed(3)} m³`;
}
