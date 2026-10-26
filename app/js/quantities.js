// Quantities: count, volume, surface area and length per tag, category or object name, from the
// geometry itself (SketchUp's own solid volume when the export carries it). CSV for spreadsheets.
import * as THREE from 'three';

const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();

// per object: volume (closed solids only), area, size
function measure(v, E, cache) {
  if (cache.has(E)) return cache.get(E);
  let vol = 0, area = 0;
  const box = new THREE.Box3();
  for (const m of E.meshes) {
    const pos = m.geometry.attributes.position, idx = m.geometry.index, mw = m.matrixWorld;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mw);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mw);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mw);
      vol += a.dot(ab.copy(b).cross(c)) / 6;
      area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
    }
    box.expandByObject(m);
  }
  const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
  vol = Math.abs(vol);
  // an open shell gives a meaningless volume: keep it only when it fits in the object's box
  const boxVol = size.x * size.y * size.z;
  let volume = E.volume > 0 ? E.volume : (vol > 1e-6 && vol <= boxVol * 1.02 ? vol : null);
  const r = { volume, area, size, length: Math.max(size.x, size.y, size.z) };
  cache.set(E, r);
  return r;
}

// groupBy: tag | cat | name | stage. Objects = the pickable object level (a chair, a wall piece)
export function quantities(v, groupBy = 'tag', onlyVisible = true) {
  const cache = new Map(), groups = new Map();
  const objects = new Set();
  for (const E of v.ents) {
    if (!E.meshes.length || E === v.rootEnt) continue;
    if (onlyVisible && !E.shown) continue;
    objects.add(v.chain(E)[0]);
  }
  for (const O of objects) {
    const parts = v.descendants(O).filter(X => X.meshes.length && (!onlyVisible || X.shown));
    let volume = 0, volKnown = true, area = 0;
    for (const X of parts) {
      const q = measure(v, X, cache);
      if (q.volume == null) volKnown = false; else volume += q.volume;
      area += q.area;
    }
    const box = v.entityBox(O), size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
    const key = groupBy === 'name' ? O.name.replace(/\s*(\[\d+\]|#\d+)$/, '').replace(/\s+\d+$/, '')
      : groupBy === 'cat' ? (O.cat || parts[0]?.cat || 'Other') : (O.tag || 'Untagged');
    if (!groups.has(key)) groups.set(key, { name: key, count: 0, volume: 0, volParts: 0, area: 0, length: 0, objects: [] });
    const g = groups.get(key);
    g.count++;
    if (volKnown && volume > 0) { g.volume += volume; g.volParts++; }
    g.area += area;
    g.length += Math.max(size.x, size.y, size.z);
    g.objects.push({ E: O, cat: O.cat || parts[0]?.cat || '', volume: volKnown ? volume : null, area, size });
  }
  return [...groups.values()].sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
}

const csvCell = s => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

// one line per object, metres
export function toCSV(groups, groupLabel) {
  const head = [groupLabel, 'Object', 'Tag', 'Category', 'Width m (red)', 'Depth m (green)', 'Height m', 'Volume m3', 'Surface area m2', 'Longest side m'];
  const rows = [head];
  for (const g of groups) {
    for (const o of g.objects) {
      rows.push([g.name, o.E.name, o.E.tag, o.cat, o.size.x.toFixed(3), o.size.z.toFixed(3), o.size.y.toFixed(3),
        o.volume != null ? o.volume.toFixed(4) : '', o.area.toFixed(3), Math.max(o.size.x, o.size.y, o.size.z).toFixed(3)]);
    }
  }
  rows.push([]);
  rows.push(['Totals', 'Count', '', '', '', '', '', 'Volume m3', 'Surface area m2', 'Total length m']);
  for (const g of groups) rows.push([g.name, g.count, '', '', '', '', '', g.volume.toFixed(3), g.area.toFixed(2), g.length.toFixed(2)]);
  return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}
