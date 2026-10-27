// Colours: repaint a wall, a column, any object, either just that object or everything in the same paint
// (material). Changes are remembered on this device for this model, travel with a client link, and never touch
// the model file. Columns and beams wearing the wall's paint (flush parts) follow the wall's new colour.
import * as THREE from 'three';

export const SWATCHES = [
  ['#ffffff', 'White'], ['#f3efe4', 'Cream'], ['#ece4d4', 'Ivory'], ['#e6dccb', 'Sand'], ['#d9cdb8', 'Beige'],
  ['#c9c4bb', 'Warm grey'], ['#b7bcbf', 'Light grey'], ['#8d9296', 'Mid grey'], ['#5c6166', 'Charcoal'], ['#2f3337', 'Graphite'],
  ['#c98a64', 'Terracotta'], ['#a85f45', 'Brick'], ['#d8b26e', 'Ochre'], ['#9fb39a', 'Sage'], ['#6f8f72', 'Olive'],
  ['#a9c3d6', 'Sky'], ['#5f86a8', 'Steel blue'], ['#8a6a4f', 'Timber'], ['#5a4334', 'Walnut'], ['#1f2a33', 'Navy'],
];

// a material copy without the viewer's bookkeeping (cloning that would copy every variant)
function copyMaterial(src) {
  const keep = src.userData._pri;
  delete src.userData._pri;
  const c = src.clone();
  if (keep) src.userData._pri = keep;
  return c;
}

export class Colours {
  constructor(app) {
    this.app = app;
    this.v = app.viewer;
    this.data = { mats: {}, objs: {} };
  }

  get key() { return 'mv:colours:' + (this.v.meta?.title || this.v.modelName || 'model'); }

  // a paint is known by its name and original colour (names can be empty in .skp files)
  matKey(src) { return `${src.name || ''}|${(src.userData.origColor || src.color).getHexString()}`; }

  entKey(E) {
    const p = [];
    for (let e = E; e && e !== this.v.rootEnt; e = e.parent) p.unshift(e.name);
    return p.join('/');
  }

  meshesOf(E) {
    const out = [];
    const walk = e => { out.push(...e.meshes); e.children.forEach(walk); };
    walk(E);
    return out;
  }

  // the paint a mesh shows now (its own, or the wall's when it is a flush column or beam)
  shownSrc(m) { return (!this.v.showJoints && m.userData.paintSrc) || [].concat(m.userData.src)[0]; }

  paintOf(E) {
    const m = this.meshesOf(E)[0];
    return m ? (m.userData.colourSrc ? [].concat(m.userData.colourSrc)[0] : this.shownSrc(m)) : null;
  }

  usersOf(src) { return this.v.meshes.filter(m => !m.userData.colourSrc && this.shownSrc(m) === src).length; }

  save() {
    try {
      if (Object.keys(this.data.mats).length || Object.keys(this.data.objs).length) localStorage.setItem(this.key, JSON.stringify(this.data));
      else localStorage.removeItem(this.key);
    } catch { /* storage full or private mode: the colours still show now */ }
  }

  // everything in this paint
  setMaterial(src, hex, save = true) {
    if (!src.userData.origColor) src.userData.origColor = src.color.clone();
    src.color.set(hex);
    src.userData.userColour = true;
    this.v.rebuildMaterial(src);
    if (save) { this.data.mats[this.matKey(src)] = hex; this.save(); }
  }

  resetMaterial(src) {
    if (!src.userData.origColor) return;
    delete this.data.mats[this.matKey(src)];
    src.color.copy(src.userData.origColor);
    delete src.userData.userColour;
    this.v.rebuildMaterial(src);
    this.save();
  }

  // just this object (and the parts inside it)
  setObject(E, hex, save = true) {
    for (const m of this.meshesOf(E)) {
      const base = [].concat(m.userData.src);
      const own = [].concat(m.userData.colourSrc || base.map(copyMaterial));
      own.forEach(c => { c.color.set(hex); c.userData.userColour = true; });
      m.userData.colourSrc = Array.isArray(m.userData.src) ? own : own[0];
      this.v.forgetMaterial(m.userData.colourSrc);
    }
    this.v.refreshMaterials();
    if (save) { this.data.objs[this.entKey(E)] = hex; this.save(); }
  }

  resetObject(E) {
    for (const m of this.meshesOf(E)) {
      if (m.userData.colourSrc) this.v.forgetMaterial(m.userData.colourSrc);
      delete m.userData.colourSrc;
    }
    delete this.data.objs[this.entKey(E)];
    this.v.refreshMaterials();
    this.save();
  }

  resetAll() {
    for (const m of this.v.meshes) {
      for (const s of [].concat(m.userData.src)) {
        if (!s.userData.origColor) continue;
        s.color.copy(s.userData.origColor);
        delete s.userData.userColour;
        this.v.rebuildMaterial(s, false);
      }
      if (m.userData.colourSrc) { this.v.forgetMaterial(m.userData.colourSrc); delete m.userData.colourSrc; }
    }
    this.data = { mats: {}, objs: {} };
    this.v.refreshMaterials();
    this.save();
  }

  get count() { return Object.keys(this.data.mats).length + Object.keys(this.data.objs).length; }

  // after a model opens: the colours saved for it (or the ones that came with a client link)
  load(data) {
    if (!data) { try { data = JSON.parse(localStorage.getItem(this.key)) || null; } catch { data = null; } }
    this.data = { mats: { ...(data?.mats || {}) }, objs: { ...(data?.objs || {}) } };
    if (!this.count) return;
    const seen = new Set();
    for (const m of this.v.meshes) {
      for (const s of [].concat(m.userData.src)) {
        if (seen.has(s)) continue;
        seen.add(s);
        const hex = this.data.mats[this.matKey(s)];
        if (hex) this.setMaterial(s, hex, false);
      }
    }
    const byKey = new Map(this.v.ents.map(E => [this.entKey(E), E]));
    for (const [k, hex] of Object.entries(this.data.objs)) {
      const E = byKey.get(k);
      if (E) this.setObject(E, hex, false);
    }
  }
}

export const hexOf = src => '#' + (src?.color || new THREE.Color(0xdddddd)).getHexString();
