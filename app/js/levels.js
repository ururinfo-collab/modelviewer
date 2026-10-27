// Levels (storeys): Underground, Ground floor, First floor, ..., Roof, found from the model itself.
// Floor levels are the tops of the big floor slabs (the fill and sand bed under a slab are not floors); the roof
// starts where the roof structure starts. Each part then belongs to one level, the way BIM viewers group objects by
// storey (xeokit, Autodesk):
//  - foundations, and anything that stays below the ground, are Underground
//  - floor plates count from their top (a slab and the beams under it lift with the floor they carry)
//  - everything else counts from its bottom (walls, columns, windows, furniture stand on their floor)
//  - site context (road, neighbours, paving) stays with the ground floor
import * as THREE from 'three';

const ORDINAL = ['Ground floor', 'First floor', 'Second floor', 'Third floor', 'Fourth floor', 'Fifth floor'];

export function detectLevels(v) {
  const parts = v.ents.filter(E => E.meshes.length && E !== v.rootEnt);
  const box = new THREE.Box3();
  const info = new Map();
  for (const E of parts) {
    box.makeEmpty();
    for (const m of E.meshes) box.expandByObject(m);
    if (box.isEmpty()) continue;
    const s = box.getSize(new THREE.Vector3());
    info.set(E, { bottom: box.min.y, top: box.max.y, area: s.x * s.z, x0: box.min.x, x1: box.max.x, z0: box.min.z, z1: box.max.z,
      cx: (box.min.x + box.max.x) / 2, cz: (box.min.z + box.max.z) / 2 });
  }
  const ground = v.groundY ?? 0;

  // floor levels: slab tops in clusters (1.5 m apart), each cluster's level = the top of its big slabs
  const slabs = [...info].filter(([E]) => E.stage === 'slab').map(([, i]) => i).sort((a, b) => a.top - b.top);
  const clusters = [];
  for (const s of slabs) {
    const c = clusters[clusters.length - 1];
    if (c && s.top - c.last < 1.5) { c.items.push(s); c.last = s.top; } else clusters.push({ items: [s], last: s.top });
  }
  const area = c => c.items.reduce((a, s) => a + s.area, 0);
  const maxArea = Math.max(0, ...clusters.map(area));
  let floors = clusters.filter(c => area(c) > maxArea * 0.15 && c.last > ground - 1).map(c => {
    const big = Math.max(...c.items.map(s => s.area));
    return Math.max(...c.items.filter(s => s.area >= big * 0.2).map(s => s.top));
  });
  if (!floors.length) floors = [ground];        // no slabs found: one level from the ground up
  // the house's footprint: the big slabs of the ground floor (what lies under them is underground)
  const gfCluster = clusters.find(c => area(c) > maxArea * 0.15 && c.last > ground - 1);
  const big0 = gfCluster ? Math.max(...gfCluster.items.map(s => s.area)) : 0;
  const foot = gfCluster ? gfCluster.items.filter(s => s.area >= big0 * 0.05) : [];
  const fp = foot.reduce((b, s) => ({ x0: Math.min(b.x0, s.x0), x1: Math.max(b.x1, s.x1), z0: Math.min(b.z0, s.z0), z1: Math.max(b.z1, s.z1) }),
    { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity });
  // wholly inside the house outline (yard paving across the whole plot is not "under the house")
  const inFoot = i => i.x0 >= fp.x0 - 0.1 && i.x1 <= fp.x1 + 0.1 && i.z0 >= fp.z0 - 0.1 && i.z1 <= fp.z1 + 0.1;

  // the roof: where the roof structure starts, if well above the top floor
  const roofBottoms = [...info].filter(([E]) => ['roof', 'steel', 'solar'].includes(E.stage)).map(([, i]) => i.bottom).sort((a, b) => a - b);
  const top = floors[floors.length - 1];
  let roof = roofBottoms.length ? roofBottoms[Math.floor(roofBottoms.length * 0.1)] : null;
  if (roof != null && roof < top + 1.8) roof = null;

  const names = ['Underground', ...floors.map((_, i) => ORDINAL[i] || `Floor ${i}`), ...(roof != null ? ['Roof'] : [])];
  const elev = [null, ...floors, ...(roof != null ? [roof] : [])];
  const roofIdx = roof != null ? names.length - 1 : -1;
  const of = new Map();
  for (const [E, i] of info) {
    let lv;
    const outside = !inFoot(i) || E.stage === 'bound';
    if (E.stage === 'ctx') lv = 1;                                         // road, neighbours: on the ground
    else if (E.stage === 'fdn' || E.stage === 'ug') lv = 0;
    else if (roofIdx > 0 && i.bottom >= roof - 0.05) lv = roofIdx;
    else if (i.top <= ground + 0.05) lv = i.bottom < ground - 0.3 || !outside ? 0 : 1;   // buried, or paving on the ground
    else {
      const plate = E.stage === 'slab' || E.stage === 'beam';
      // slabs sit at the floor level (fill and sand bed under them do not); beams carry it from just below
      const ref = plate ? i.top : i.bottom, tol = E.stage === 'slab' ? 0.07 : plate ? 0.15 : 0.25;
      lv = 0;
      floors.forEach((f, k) => { if (ref >= f - tol) lv = k + 1; });
      if (lv === 0 && outside) lv = 1;                                     // on the site beside the house
    }
    of.set(E, lv);
  }
  const count = names.map((_, k) => [...of.values()].filter(l => l === k).length);
  return { names, elev, of, count, gf: 1, roof: roofIdx };
}
