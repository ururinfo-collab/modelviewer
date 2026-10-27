// Explode, the way architects draw exploded axonometrics and BIM viewers explode storeys: whole pieces move straight
// up or down, with the same gap between each.
//  - levels (all levels on screen): each level (Underground, Ground floor, ..., Roof) moves as one piece. The ground
//    floor stays (the building stays on its site), floors above and the roof lift, the underground drops.
//  - layers (one level on screen): that level comes apart into its systems, bottom to top: floor, structure, walls,
//    doors and windows, services, interior; on the roof level also roof covering and solar.
// Amount 0 puts every part back exactly. The model file is not changed.
import * as THREE from 'three';

export const LAYERS = ['Floor', 'Structure', 'Walls', 'Doors and windows', 'Services', 'Interior and equipment', 'Roof covering', 'Solar'];

// which layer of its level a part belongs to (from its construction stage; floor tiles vs wall tiles by shape)
function layerOf(E, h) {
  switch (E.stage) {
    case 'slab': case 'site': case 'ctx': return 0;
    case 'fin': return h < 0.2 ? 0 : 2;
    case 'col': case 'beam': case 'steel': case 'fdn': return 1;
    case 'wall': case 'stair': case 'rail': case 'bound': return 2;
    case 'open': return 3;
    case 'plumb': case 'elec': case 'mech': case 'ug': return 4;
    case 'roof': return 6;
    case 'solar': return 7;
    default: return 5;   // interior, furniture, equipment
  }
}

export class Explode {
  constructor(app) {
    this.app = app;
    this.v = app.viewer;
    this.amount = 0;
    this.mode = 'levels';
    this.items = null;
    app.viewer.addEventListener('model', () => { this.items = null; this.amount = 0; });
  }

  get active() { return this.amount > 0; }

  prepare() {
    const v = this.v, L = this.app.levels;
    const boxes = new Map();
    this.items = v.meshes.map(m => {
      const E = m.userData.owner;
      let b = boxes.get(E);
      if (!b) boxes.set(E, b = v.entityBox(E));
      m.parent.updateWorldMatrix(true, false);
      const inv = new THREE.Matrix3().setFromMatrix4(m.parent.matrixWorld).invert();
      return { m, rest: m.position.clone(), lv: L?.of.get(E) ?? L?.gf ?? 1, layer: layerOf(E, b.max.y - b.min.y),
        bottom: b.min.y, top: b.max.y, inv };
    });
    // gaps: most of a storey between levels, about a third of one between layers
    const e = (L?.elev || []).filter(x => x != null);
    const storey = e.length > 1 ? (e[e.length - 1] - e[0]) / (e.length - 1) : 3;
    this.gap = THREE.MathUtils.clamp(storey * 0.9, 1.5, 6);
    this.layerGap = THREE.MathUtils.clamp(storey * 0.25, 0.5, 1.5);   // the clear space between layers
    this.gf = L?.gf ?? 1;
  }

  // the layers present among the parts on screen, bottom to top (for the panel's legend)
  layersShown() {
    if (!this.items) this.prepare();
    const used = new Set(this.items.filter(it => it.m.visible).map(it => it.layer));
    return LAYERS.filter((_, k) => used.has(k));
  }

  set(amount, mode = this.mode) {
    const v = this.v;
    if (!v.root) return;
    if (!this.items) this.prepare();
    this.amount = amount;
    this.mode = mode;
    // layers: each one lifted until its bottom clears the top of the (lifted) layer below by the same margin, so
    // full-height layers (columns, walls) never overlap; layers this level does not have leave no gap
    const lift = new Map();
    if (mode === 'layers') {
      const ext = new Map();
      for (const it of this.items) {
        if (!it.m.visible) continue;
        const e = ext.get(it.layer) || { bottom: Infinity, top: -Infinity };
        e.bottom = Math.min(e.bottom, it.bottom);
        e.top = Math.max(e.top, it.top);
        ext.set(it.layer, e);
      }
      let roof = -Infinity;
      for (const l of [...ext.keys()].sort((a, b) => a - b)) {
        const e = ext.get(l);
        const d = roof === -Infinity ? 0 : Math.max(0, roof + this.layerGap - e.bottom);
        lift.set(l, d);
        roof = e.top + d;
      }
    }
    const off = new THREE.Vector3();
    for (const it of this.items) {
      const dy = mode === 'layers' ? (lift.get(it.layer) ?? 0) : (it.lv - this.gf) * this.gap;
      off.set(0, dy * amount, 0);
      it.m.position.copy(it.rest).add(off.applyMatrix3(it.inv));
    }
    v.root.updateMatrixWorld(true);
    v._boxesDirty = true;
    v.shadowDirty = true;
    if (v.contact.enabled) { clearTimeout(this._bake); this._bake = setTimeout(() => v.contact.bake(), 200); }
    v.requestRender();
    if (amount === 0) this.items = null;   // the next explode starts from where parts are then (after any Move)
  }
}
