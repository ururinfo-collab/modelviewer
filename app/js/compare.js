// Revision compare: the open model against another file of the same house. Parts are matched by
// name, nearest centre among same-named parts (the same idea as BuildLapse's name transfer).
// added = only in the open model, changed = moved or resized more than 2 cm, removed = only in the
// other file (drawn in red where it was), same = everything else (faded).
import * as THREE from 'three';
import { loadFiles } from './loaders.js';

const TOL = 0.02;   // metres

function partsOf(root, isEntity) {
  // leaf owners: nearest named node above each mesh
  const owners = new Map();
  root.updateMatrixWorld(true);
  root.traverse(o => {
    if (!o.isMesh) return;
    let e = o;
    while (e && e !== root && !isEntity(e)) e = e.parent;
    if (!e || e === root) e = o;
    if (!owners.has(e)) owners.set(e, []);
    owners.get(e).push(o);
  });
  const out = [];
  for (const [e, meshes] of owners) {
    const box = new THREE.Box3();
    for (const m of meshes) box.expandByObject(m);
    const name = e.userData.mv?.name || e.userData._name || e.name || '';
    out.push({ name, meshes, box, center: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()) });
  }
  return out;
}

export class Compare {
  constructor(app) {
    this.app = app;
    this.v = app.viewer;
    this.active = false;
    this.showSame = true;
    this.showRemoved = true;
    this.mats = {
      added: new THREE.MeshLambertMaterial({ color: 0x2e9e4f, side: THREE.DoubleSide }),
      changed: new THREE.MeshLambertMaterial({ color: 0xf08c00, side: THREE.DoubleSide }),
      removed: new THREE.MeshBasicMaterial({ color: 0xd23c2c, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
    };
  }

  async start(files) {
    const v = this.v;
    this.stop();
    const other = await loadFiles(files);
    this.otherName = other.name;
    const mine = v.ents.filter(E => E.meshes.length && E !== v.rootEnt).map(E => {
      const box = v.entityBox(E);
      return { E, name: E.name, center: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()) };
    });
    const theirs = partsOf(other.root, other.isEntity);
    const byName = new Map();
    for (const p of theirs) {
      if (!byName.has(p.name)) byName.set(p.name, []);
      byName.get(p.name).push(p);
    }
    this.lists = { added: [], changed: [], removed: [], same: [] };
    for (const p of mine) {
      const cands = (byName.get(p.name) || []).filter(q => !q.used);
      let best = null, bd = Infinity;
      for (const q of cands) { const d = q.center.distanceTo(p.center); if (d < bd) { bd = d; best = q; } }
      if (!best) { p.E.diff = 'added'; this.lists.added.push(p.E); continue; }
      best.used = true;
      const resized = Math.max(Math.abs(best.size.x - p.size.x), Math.abs(best.size.y - p.size.y), Math.abs(best.size.z - p.size.z));
      if (bd > TOL || resized > TOL) { p.E.diff = 'changed'; p.E.diffBy = Math.max(bd, resized); this.lists.changed.push(p.E); }
      else { p.E.diff = 'same'; this.lists.same.push(p.E); }
    }
    // what disappeared: shown from the other file, in red
    this.otherRoot = other.root;
    this.otherRoot.traverse(o => { if (o.isMesh) o.visible = false; });
    for (const q of theirs) {
      if (q.used) continue;
      for (const m of q.meshes) { m.visible = true; m.material = this.mats.removed; m.raycast = () => {}; m.renderOrder = 2; }
      this.lists.removed.push(q);
    }
    this.otherRoot.traverse(o => { if (!o.isMesh) o.visible = true; });
    v.scene.add(this.otherRoot);
    this.active = true;
    this.apply();
    return this.lists;
  }

  apply() {
    const v = this.v;
    v.diffMats = this.active ? this.mats : null;
    v.diffShowSame = this.showSame;
    if (this.otherRoot) this.otherRoot.visible = this.active && this.showRemoved;
    v.refreshMaterials();
    v.updateVisibility();
  }

  stop() {
    if (!this.active) return;
    const v = this.v;
    this.active = false;
    for (const E of v.ents) { delete E.diff; delete E.diffBy; }
    if (this.otherRoot) {
      v.scene.remove(this.otherRoot);
      this.otherRoot.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      this.otherRoot = null;
    }
    this.apply();
  }
}
