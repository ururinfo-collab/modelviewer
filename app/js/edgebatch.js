// Edge lines in two draw calls instead of one per part. Every part keeps its own LineSegments (the source of
// truth: tools set its material and visibility as before); for the normal render this batch reads them all,
// draws the ones in the normal or see-through look itself and hides those for that one render. A line in any
// other state (AI render passes, anything new) is left to draw on its own. Parts that move (Move, Floors
// explode) have their slice rewritten, and report it so the shadow map can follow.
import * as THREE from 'three';

function batchMaterial(keep) {
  const m = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false });
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aMode;')
      .replace('#include <project_vertex>', `#include <project_vertex>\nif (abs(aMode - ${keep.toFixed(1)}) > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);`);
  };
  m.customProgramCacheKey = () => `edgebatch${keep}`;
  return m;
}

export class EdgeBatch {
  constructor(viewer) {
    this.v = viewer;
    this.lines = null;
    this.hidden = [];
    this.matN = batchMaterial(1);
    this.matG = batchMaterial(2);
  }

  dispose() {
    if (this.normal) {
      this.v.scene.remove(this.normal, this.ghost);
      this.normal.geometry.dispose();
    }
    this.normal = this.ghost = this.lines = null;
  }

  build() {
    this.dispose();
    const v = this.v;
    const lines = v.meshes.map(m => m.userData.line).filter(Boolean);
    if (!lines.length) return;
    let n = 0;
    const ranges = lines.map(l => { const c = l.geometry.attributes.position.count; const r = [n, c]; n += c; return r; });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aMode', new THREE.BufferAttribute(new Float32Array(n), 1));
    this.lines = lines;
    this.ranges = ranges;
    this.geos = lines.map(l => l.geometry);
    this.cache = lines.map(() => new Float64Array(16).fill(NaN));   // 64-bit, as the matrices: exact compare
    this.modes = new Int8Array(lines.length).fill(-1);
    this.fresh = true;
    this.normal = new THREE.LineSegments(g, this.matN);
    this.ghost = new THREE.LineSegments(g, this.matG);
    for (const o of [this.normal, this.ghost]) {
      o.frustumCulled = false;
      o.renderOrder = o === this.normal ? 2 : 1;   // solid parts' lines over see-through ones
      o.raycast = () => {};
      o.visible = false;
      o.userData.edgeBatch = true;
      v.scene.add(o);
    }
  }

  // world positions of one part's lines into its slice
  write(i) {
    const l = this.lines[i], [o, c] = this.ranges[i];
    const src = l.geometry.attributes.position.array, dst = this.normal.geometry.attributes.position.array;
    const e = l.matrixWorld.elements;
    for (let k = 0; k < c; k++) {
      const x = src[k * 3], y = src[k * 3 + 1], z = src[k * 3 + 2], j = (o + k) * 3;
      dst[j] = e[0] * x + e[4] * y + e[8] * z + e[12];
      dst[j + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      dst[j + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    this.cache[i].set(e);
  }

  // before a normal render (world matrices up to date); returns true when a part has moved
  begin() {
    const v = this.v;
    if (this.off || !v.ready || !v.meshes.length) return false;    // off: every part draws its own lines (A/B checks)
    if (!this.lines || this.lines.length !== v.meshes.length || this.lines.some((l, i) => l.geometry !== this.geos[i] || !l.parent)) this.build();
    if (!this.lines) return false;
    const em = v.edgeMat, gm = v.edgeGhostMat;
    for (const [b, s] of [[this.matN, em], [this.matG, gm]]) {
      b.color.copy(s.color);
      b.opacity = s.opacity;
      b.toneMapped = s.toneMapped;
    }
    const pos = this.normal.geometry.attributes.position, mode = this.normal.geometry.attributes.aMode;
    let moved = false, modeDirty = false;
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i], e = l.matrixWorld.elements, c = this.cache[i];
      for (let k = 0; k < 16; k++) if (e[k] !== c[k]) { this.write(i); moved = true; break; }
      let m = 0;
      if (l.visible && this.chainVisible(l.parent)) m = l.material === em ? 1 : l.material === gm ? 2 : 3;
      if (m === 1 || m === 2) { l.visible = false; this.hidden.push(l); }
      const bm = m === 3 ? 0 : m;
      if (bm !== this.modes[i]) {
        const [o, n] = this.ranges[i];
        mode.array.fill(bm, o, o + n);
        this.modes[i] = bm;
        modeDirty = true;
      }
    }
    if (moved) pos.needsUpdate = true;
    if (modeDirty) mode.needsUpdate = true;
    this.normal.visible = this.ghost.visible = true;
    const report = moved && !this.fresh;      // the first fill after a build is not a move
    this.fresh = false;
    return report;
  }

  // after the render: the parts' own lines back as they were, the batch out of other renders (AI, AR)
  end() {
    for (const l of this.hidden) l.visible = true;
    this.hidden.length = 0;
    if (this.normal) this.normal.visible = this.ghost.visible = false;
  }

  chainVisible(o) {
    for (let p = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  }
}
