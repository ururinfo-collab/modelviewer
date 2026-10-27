// Joint lines: where two parts meet flush (wall panels, a wall and a column, a slab edge in the wall face), each
// part draws its own outline, so the wall shows lines a plastered, painted wall would not have.
// A joint has a clear signature: two parts share an edge line, the visible faces on either side lie in the same
// plane and face the same way, and the hidden end faces touch back to back (opposite normals).
// Real corners (the faces turn) and frames, sills and bands that stand proud (the faces step) do not match and keep
// their lines. Works on the edge lines only; the model is not changed.
import * as THREE from 'three';

const COS_CREASE = Math.cos(THREE.MathUtils.degToRad(40));   // same 40 degrees as the edge lines
const TOL = 0.015;            // 15 mm (metres): small gaps between parts are plastered over in a real wall
const SAME = 0.999;

// crease and border edges of one geometry; for each, the third corner of the triangle on either side, which
// tells which way each face runs away from the edge (local space). Face direction (winding) is not used for
// matching: SketchUp models often have faces turned inside out.
function creaseEdges(g) {
  const pos = g.attributes.position, idx = g.index;
  const n = idx ? idx.count : pos.count;
  const key = i => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nrm = new THREE.Vector3();
  const open = new Map(), out = [];
  for (let t = 0; t < n; t += 3) {
    const ids = [0, 1, 2].map(k => (idx ? idx.getX(t + k) : t + k));
    a.fromBufferAttribute(pos, ids[0]); b.fromBufferAttribute(pos, ids[1]); c.fromBufferAttribute(pos, ids[2]);
    nrm.subVectors(c, b).cross(a.clone().sub(b));
    if (nrm.lengthSq() < 1e-20) continue;
    nrm.normalize();
    const keys = ids.map(key);
    for (let k = 0; k < 3; k++) {
      const i0 = ids[k], i1 = ids[(k + 1) % 3], i2 = ids[(k + 2) % 3], k0 = keys[k], k1 = keys[(k + 1) % 3];
      if (k0 === k1) continue;
      const rev = `${k1}_${k0}`;
      const other = open.get(rev);
      if (other) {
        open.delete(rev);
        if (other.n.dot(nrm) <= COS_CREASE) out.push({ i0: other.i0, i1: other.i1, c1: other.i2, c2: i2 });
      } else open.set(`${k0}_${k1}`, { i0, i1, i2, n: nrm.clone() });
    }
  }
  for (const e of open.values()) out.push({ i0: e.i0, i1: e.i1, c1: e.i2, c2: null });   // border edges
  const v = i => new THREE.Vector3().fromBufferAttribute(pos, i);
  return out.map(e => ({ p0: v(e.i0), p1: v(e.i1), c1: v(e.c1), c2: e.c2 == null ? null : v(e.c2) }));
}

// the direction a face runs away from the edge line (unit, perpendicular to d)
const awayFrom = (p0, d, corner) => {
  const t = corner.clone().sub(p0);
  return t.addScaledVector(d, -t.dot(d)).normalize();
};

const yieldNow = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });

// meshes: the model's meshes. Returns { clean: Map(mesh -> local-space Float32Array of the line segments to keep),
// only for meshes that lose at least one joint; partners: Map(mesh -> Map(other mesh -> joint length in m)) }.
export async function findJoints(meshes, onProgress = () => {}) {
  const partners = new Map();
  const flushPlanes = new Map();   // slab -> plane -> wall-side partners
  const perGeo = new Map(), all = [];
  const buckets = new Map();
  let t0 = performance.now();
  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi];
    let local = perGeo.get(m.geometry);
    if (!local) perGeo.set(m.geometry, local = creaseEdges(m.geometry));
    m.updateWorldMatrix(true, false);
    const W = m.matrixWorld;
    const list = [];
    for (const e of local) {
      const p0 = e.p0.clone().applyMatrix4(W), p1 = e.p1.clone().applyMatrix4(W);
      const len = p0.distanceTo(p1);
      if (len < 1e-5) continue;
      const d = p1.clone().sub(p0).divideScalar(len);
      const E = { uid: all.length * 1e6 + list.length, m, e, p0, d, len, t1: awayFrom(p0, d, e.c1.clone().applyMatrix4(W)),
        t2: e.c2 ? awayFrom(p0, d, e.c2.clone().applyMatrix4(W)) : null, cut: [] };
      list.push(E);
      // bucket by the infinite line: direction (sign-free) and the point on it nearest the origin, 1 cm cells
      const s = Math.sign(d.x || d.y || d.z) || 1;
      const dq = `${Math.round(d.x * s * 200)},${Math.round(d.y * s * 200)},${Math.round(d.z * s * 200)}`;
      const f = p0.clone().addScaledVector(d, -p0.dot(d));
      E.dq = dq;
      E.cell = [Math.round(f.x * 100), Math.round(f.y * 100), Math.round(f.z * 100)];
      const k = `${dq}|${E.cell.join(',')}`;
      let arr = buckets.get(k);
      if (!arr) buckets.set(k, arr = []);
      arr.push(E);
    }
    all.push(list);
    if (performance.now() - t0 > 30) { onProgress(mi / meshes.length * 0.6); await yieldNow(); t0 = performance.now(); }
  }

  // For each edge, every face touching its line along each stretch, from any part or piece (faces are often split
  // into fans, so their edges do not pair up). A stretch is a joint when the faces there form at least one pair
  // running on across the line in one plane (opposite directions) and every face is in such a pair or lies back to
  // back with another (same direction). A real corner leaves a face alone, so its line stays.
  const q = new THREE.Vector3();
  let done = 0;
  for (const list of all) {
    for (const E of list) {
      const spans = [[0, E.len, E.t1, E, 1], ...(E.t2 ? [[0, E.len, E.t2, E, 2]] : [])];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const arr = buckets.get(`${E.dq}|${E.cell[0] + dx},${E.cell[1] + dy},${E.cell[2] + dz}`);
        if (!arr) continue;
        for (const F of arr) {
          if (F === E || Math.abs(F.d.dot(E.d)) < 1 - 1e-6) continue;
          q.subVectors(F.p0, E.p0);
          if (q.clone().addScaledVector(E.d, -q.dot(E.d)).length() > TOL) continue;   // not on E's line
          const a = q.dot(E.d), b = a + F.len * F.d.dot(E.d);
          const lo = Math.max(0, Math.min(a, b)), hi = Math.min(E.len, Math.max(a, b));
          if (hi - lo <= 1e-4) continue;
          spans.push([lo, hi, F.t1, F, 1]);
          if (F.t2) spans.push([lo, hi, F.t2, F, 2]);
        }
      }
      if (spans.length < 3) continue;
      const cuts = [...new Set(spans.flatMap(s => [s[0], s[1]]))].sort((x, y) => x - y);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const lo = cuts[i], hi = cuts[i + 1];
        if (hi - lo < 1e-4) continue;
        const mid = (lo + hi) / 2;
        const here = spans.filter(s => s[0] <= mid && s[1] >= mid);
        let across = false, ok = true;
        for (const s of here) {
          let paired = false;
          for (const o of here) {
            if (o === s || (o[3] === s[3] && o[4] === s[4])) continue;
            const dot = s[2].dot(o[2]);
            if (dot < -SAME) { paired = true; across = true; } else if (dot > SAME && o[3] !== s[3]) paired = true;
          }
          if (!paired) { ok = false; break; }
        }
        if (!ok || !across) continue;
        E.cut.push([lo, hi]);
        // a slab edge running on into a wall face: that face of the slab gets the wall's paint (skin, below)
        if (E.m.userData.owner?.stage === 'slab') {
          for (const s of here) {
            if (s[3] !== E) continue;
            const o = here.find(o => o[3].m !== E.m && s[2].dot(o[2]) < -SAME);
            if (!o) continue;
            const n = s[2].clone().cross(E.d).normalize();
            const sg = Math.sign(n.x || n.y || n.z) || 1;
            n.multiplyScalar(sg);
            const key = `${Math.round(n.x * 100)},${Math.round(n.y * 100)},${Math.round(n.z * 100)}|${Math.round(n.dot(E.p0) / 0.005)}`;
            let fp = flushPlanes.get(E.m);
            if (!fp) flushPlanes.set(E.m, fp = new Map());
            const rec = fp.get(key) || { n, off: n.dot(E.p0), partners: new Map() };
            rec.partners.set(o[3].m, (rec.partners.get(o[3].m) || 0) + hi - lo);
            fp.set(key, rec);
          }
        }
        // seal the seam: a thin strip in the wall plane from this edge to the one it continues into (gap + 1 mm
        // each side), so nothing behind (edges of beams, trusses) shows through a hairline gap
        for (const s of here) {
          if (s[3] !== E) continue;
          for (const o of here) {
            if (o[3] === E || o[3].uid < E.uid || s[2].dot(o[2]) > -SAME) continue;
            const off = q.subVectors(o[3].p0, E.p0).dot(s[2]);
            const w0 = Math.min(0, off) - 0.001, w1 = Math.max(0, off) + 0.001;
            (E.seal ||= []).push([lo, hi, s[2], w0, w1]);
          }
        }
        for (const s of here) {
          const o = s[3].m;
          if (o === E.m) continue;
          let p = partners.get(E.m);
          if (!p) partners.set(E.m, p = new Map());
          p.set(o, (p.get(o) || 0) + (hi - lo) / 2);
        }
      }
    }
    if (++done % 50 === 0 && performance.now() - t0 > 30) { onProgress(0.6 + done / all.length * 0.4); await yieldNow(); t0 = performance.now(); }
  }

  // Edges lying inside another part's face: a column running up beside a beam end, a panel piece without an end
  // face. Just across the edge, the same plane carries another face (any part), and the edge's other face runs into
  // the solid side (where that part's body is): one surface, the line goes. A pilaster standing proud of a wall
  // runs outward and keeps its lines.
  const planes = new Map();
  const tri = [];
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3();
  const pkey = (n, off) => {
    const s = Math.sign(n.x || n.y || n.z) || 1;
    return `${Math.round(n.x * s * 100)},${Math.round(n.y * s * 100)},${Math.round(n.z * s * 100)}|${Math.round(off * s / 0.005)}`;
  };
  const centres = new Map();
  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi], g = m.geometry, pos = g.attributes.position, idx = g.index, W = m.matrixWorld;
    centres.set(m, new THREE.Box3().setFromBufferAttribute(pos).applyMatrix4(W).getCenter(new THREE.Vector3()));
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t < n; t += 3) {
      A.fromBufferAttribute(pos, idx ? idx.getX(t) : t).applyMatrix4(W);
      B.fromBufferAttribute(pos, idx ? idx.getX(t + 1) : t + 1).applyMatrix4(W);
      C.fromBufferAttribute(pos, idx ? idx.getX(t + 2) : t + 2).applyMatrix4(W);
      N.subVectors(C, B).cross(q.subVectors(A, B));
      if (N.lengthSq() < 1e-12) continue;
      N.normalize();
      const k = pkey(N, N.dot(A));
      let arr = planes.get(k);
      if (!arr) planes.set(k, arr = []);
      arr.push(tri.length);
      tri.push({ m, a: A.clone(), b: B.clone(), c: C.clone(), n: N.clone() });
    }
    if (performance.now() - t0 > 30) { await yieldNow(); t0 = performance.now(); }
  }
  const inside = (T, p) => {
    if (Math.abs(T.n.dot(q.subVectors(p, T.a))) > TOL) return false;
    const v0 = C.subVectors(T.c, T.a), v1 = B.subVectors(T.b, T.a), v2 = q.subVectors(p, T.a);
    const d00 = v0.dot(v0), d01 = v0.dot(v1), d02 = v0.dot(v2), d11 = v1.dot(v1), d12 = v1.dot(v2);
    const den = d00 * d11 - d01 * d01;
    if (Math.abs(den) < 1e-14) return false;
    const u = (d11 * d02 - d01 * d12) / den, w = (d00 * d12 - d01 * d02) / den;
    return u >= -1e-4 && w >= -1e-4 && u + w <= 1 + 1e-4;
  };
  const covered = (p, n, off) => {
    const s = Math.sign(n.x || n.y || n.z) || 1;
    const base = `${Math.round(n.x * s * 100)},${Math.round(n.y * s * 100)},${Math.round(n.z * s * 100)}|`;
    const o = Math.round(off * s / 0.005);
    for (let k = o - 3; k <= o + 3; k++) {
      for (const i of planes.get(base + k) || []) if (inside(tri[i], p)) return tri[i].m;
    }
    return null;
  };
  // skins: the slab's own triangles in a plane that runs on into a wall face, in the slab's local space
  const skins = new Map();
  const toLocal = new THREE.Matrix4();
  for (const [m, fp] of flushPlanes) {
    toLocal.copy(m.matrixWorld).invert();
    for (const rec of fp.values()) {
      let partner = null, best = 0;
      for (const [o, l] of rec.partners) if (l > best) { best = l; partner = o; }
      const tris = [];
      for (const T of tri) {
        if (T.m !== m || Math.abs(T.n.dot(rec.n)) < SAME || Math.abs(rec.n.dot(T.a) - rec.off) > TOL) continue;
        for (const p of [T.a, T.b, T.c]) tris.push(...p.clone().applyMatrix4(toLocal).toArray());
      }
      if (!tris.length) continue;
      let list = skins.get(m);
      if (!list) skins.set(m, list = []);
      list.push({ partner, tris: new Float32Array(tris) });
    }
  }

  const P = new THREE.Vector3();
  for (const list of all) {
    for (const E of list) {
      const keep = remaining(E.len, E.cut);
      if (!keep.length) continue;
      // an edge with one face on record (a face split into a fan): only "does the surface carry on" counts
      for (const [f, s] of E.t2 ? [[E.t1, E.t2], [E.t2, E.t1]] : [[E.t1, null]]) {
        const n = f.clone().cross(E.d).normalize(), off = n.dot(E.p0);
        for (const [lo, hi] of keep) {
          const steps = Math.max(2, Math.min(24, Math.ceil((hi - lo) / 0.05)));
          const h = (hi - lo) / steps;
          for (let i = 0; i < steps; i++) {
            const l = lo + (i + 0.5) * h;
            P.copy(E.p0).addScaledVector(E.d, l).addScaledVector(f, -0.004);   // just past the edge, where f does not run
            const other = covered(P, n, off);
            if (!other) continue;
            const c = centres.get(other);
            if (s && Math.sign(n.dot(q.subVectors(c, P))) !== Math.sign(n.dot(s))) continue;   // its side runs outward
            E.cut.push([l - h / 2, l + h / 2]);
          }
        }
      }
    }
  }

  // what is left of each edge, back in the mesh's own space; seam strips too
  const result = new Map(), seals = new Map();
  const inv = new THREE.Matrix4();
  for (const list of all) {
    if (!list.length || !list.some(E => E.cut.length)) continue;
    const segs = [], tris = [];
    inv.copy(list[0].m.matrixWorld).invert();
    for (const E of list) {
      const { p0, p1 } = E.e;
      const keep = remaining(E.len, E.cut);
      for (const [lo, hi] of keep) {
        const a = p0.clone().lerp(p1, lo / E.len), b = p0.clone().lerp(p1, hi / E.len);
        segs.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
      for (const [lo, hi, t, w0, w1] of E.seal || []) {
        const P = (l, w) => E.p0.clone().addScaledVector(E.d, l).addScaledVector(t, w).applyMatrix4(inv);
        const a = P(lo, w0), b = P(hi, w0), c = P(hi, w1), d = P(lo, w1);
        tris.push(...a.toArray(), ...b.toArray(), ...c.toArray(), ...a.toArray(), ...c.toArray(), ...d.toArray());
      }
    }
    result.set(list[0].m, new Float32Array(segs));
    if (tris.length) seals.set(list[0].m, new Float32Array(tris));
  }
  return { clean: result, partners, seals, skins };
}

// One painted surface: a column, beam or gable panel flush with a wall takes that wall's paint (the partner it
// shares the longest joints with); a part flush only with such a part takes its new paint. Walls keep their own
// colours, so interior and bathroom walls do not change. Returns Map(mesh -> source material to paint with).
const FRAME = new Set(['col', 'beam', 'roof', 'steel']);
export function flushPaint(partners) {
  const paint = new Map();
  const own = m => [].concat(m.userData.src)[0];
  const stage = m => m.userData.owner?.stage;
  const best = (m, ok) => {
    let top = null, len = 0;
    for (const [o, l] of partners.get(m) || []) if (l > len && ok(o)) { top = o; len = l; }
    return top;
  };
  for (const pass of [o => stage(o) === 'wall', o => paint.has(o)]) {
    for (const m of partners.keys()) {
      if (paint.has(m) || !FRAME.has(stage(m)) || Array.isArray(m.userData.src) || own(m).map) continue;
      const o = best(m, o => pass(o) && !Array.isArray(o.userData.src) && !own(o).map);
      if (o) paint.set(m, paint.get(o) || own(o));
    }
  }
  return paint;
}

// [0, len] minus the cut intervals; tiny leftovers (under 1 cm) go too
function remaining(len, cuts) {
  if (!cuts.length) return [[0, len]];
  cuts.sort((x, y) => x[0] - y[0]);
  const out = [];
  let at = 0;
  for (const [lo, hi] of cuts) {
    if (lo - at > 0.01) out.push([at, lo]);
    at = Math.max(at, hi);
  }
  if (len - at > 0.01) out.push([at, len]);
  return out;
}
