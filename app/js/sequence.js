// Construction time-lapse: parts appear stage by stage, newest ones flash orange.
// Order comes from a BuildLapse sequence sidecar (<model>.sequence.json) when there is one,
// else from the object categories (foundations first, furniture last), bottom up within each.
import * as THREE from 'three';
import { OTHER } from './categories.js';

const AUTO = ['Foundations', 'Columns', 'Beams', 'Slabs', 'Walls', 'Stairs', 'Roof', 'Doors', 'Windows',
  'Plumbing', 'Electrical', 'HVAC', 'Sanitary', 'Finishes', 'Railings', 'Furniture', 'Site', OTHER];
const MM = { Foundations: 'အုတ်မြစ်', Columns: 'တိုင်များ', Beams: 'ဘီမ်များ', Slabs: 'ကြမ်းခင်း', Walls: 'နံရံများ',
  Stairs: 'လှေကား', Roof: 'အမိုး', Doors: 'တံခါးများ', Windows: 'ပြတင်းပေါက်များ', Furniture: 'ပရိဘောဂ' };
const FLASH = 0.6;   // seconds a new part stays orange

export class Sequence {
  constructor(viewer) {
    this.v = viewer;
    this.active = false;
    this.playing = false;
    this.steps = [];
    this.stages = [];
    this.pos = 0;
    this.duration = 40;      // seconds for the whole build
    this.ghostRest = false;
    this.orbit = false;
    this.data = null;        // sidecar
    this.tick = dt => this.update(dt);
  }

  get source() { return this.data ? 'file' : 'auto'; }

  prepare() {
    const v = this.v;
    const leaves = v.ents.filter(E => E.meshes.length && E !== v.rootEnt);
    const box = new THREE.Box3(), c = new THREE.Vector3();
    const info = E => {
      box.makeEmpty();
      for (const m of E.meshes) box.expandByObject(m);
      return { bottom: box.min.y, center: box.getCenter(c).clone() };
    };
    let keyed = [];
    this.unmatched = 0;
    if (this.data) {
      this.stages = this.data.stages.map(s => ({ en: s.en, mm: s.mm || '' }));
      const byName = new Map();
      for (const [name, st, order, x, y, z] of this.data.parts) {
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push({ st, order, c: new THREE.Vector3(x, y, z), used: false });
      }
      const missing = [];
      for (const E of leaves) {
        const list = byName.get(E.name);
        if (!list) { missing.push(E); continue; }
        const { center, bottom } = info(E);
        let best = null, bd = Infinity;
        for (const p of list) {
          if (p.used) continue;
          const d = p.c.distanceToSquared(center);
          if (d < bd) { bd = d; best = p; }
        }
        best = best || list[0];
        best.used = true;
        keyed.push({ E, stage: best.st, key: best.order, bottom });
      }
      // Parts new since that order was made (the model keeps changing): put each into the stage
      // where most matched parts of the same tag, else the same category, went; else last.
      if (missing.length) {
        const vote = (field) => {
          const m = new Map();
          for (const k of keyed) {
            const key = k.E[field];
            if (!m.has(key)) m.set(key, new Map());
            m.get(key).set(k.stage, (m.get(key).get(k.stage) || 0) + 1);
          }
          return key => {
            const c = m.get(key);
            return c ? [...c].sort((a, b) => b[1] - a[1])[0][0] : null;
          };
        };
        // Site context (neighbours, road) is never built: it stays in view from the start.
        const byTag = vote('tag'), byCat = vote('cat');
        for (const E of missing) {
          if (/context|indicative/i.test(`${E.tag} ${E.name}`)) continue;
          const st = byTag(E.tag) ?? byCat(E.cat);
          if (st == null) continue;
          const { bottom } = info(E);
          keyed.push({ E, stage: st, key: 1e12 + bottom, bottom });     // at the end of its stage, bottom up
          this.unmatched = (this.unmatched || 0) + 1;
        }
      }
      this.matched = leaves.length - missing.length;
    } else {
      const present = AUTO.filter(c => v.categories.has(c));
      this.stages = present.map(c => ({ en: c, mm: MM[c] || '' }));
      for (const E of leaves) {
        if (/context|indicative/i.test(`${E.tag} ${E.name}`)) continue;     // neighbours stay in view
        const { bottom, center } = info(E);
        keyed.push({ E, stage: present.indexOf(E.cat), key: bottom * 100 + center.x * 0.01, bottom });
      }
      keyed = keyed.filter(k => k.stage >= 0);
      this.matched = keyed.length;
      this.unmatched = 0;
    }
    keyed.sort((a, b) => a.stage - b.stage || a.key - b.key || a.bottom - b.bottom);
    // Playback time per part (0..1). BuildLapse order: its own frame timing. Automatic: every stage
    // gets the same time, so 1,900 pipe segments do not take half the film.
    const N = this.stages.length;
    const count = this.stages.map(() => 0), seen = this.stages.map(() => 0);
    for (const k of keyed) count[k.stage]++;
    const real = keyed.filter(k => k.key < 1e12);
    const k0 = this.data && real.length ? Math.min(...real.map(k => k.key)) : 0;
    const k1 = this.data && real.length ? Math.max(...real.map(k => k.key)) : 1;
    const stageEnd = this.stages.map(() => 0);
    for (const k of keyed) {
      seen[k.stage]++;
      if (this.data && k.key < 1e12) k.t = (k.key - k0) / Math.max(1, k1 - k0);
      else if (!this.data) k.t = (k.stage + seen[k.stage] / count[k.stage]) / N;
      if (k.t != null) stageEnd[k.stage] = Math.max(stageEnd[k.stage], k.t);
    }
    for (const k of keyed) if (k.t == null) k.t = stageEnd[k.stage];
    keyed.sort((a, b) => a.t - b.t || a.stage - b.stage);
    this.steps = keyed;
    this.stageStart = this.stages.map(() => Infinity);
    keyed.forEach((k, i) => { this.stageStart[k.stage] = Math.min(this.stageStart[k.stage], i); });
    for (const k of keyed) k.E.step = k;
  }

  start() {
    this.prepare();
    this.active = true;
    this.v.seqGhost = this.ghostRest;
    this.started = false;
    this.freshList = [];
    this.time = 0;
    this.setPos(0, false);
  }

  // number of parts whose time has come
  countAt(t) {
    let lo = 0, hi = this.steps.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.steps[mid].t <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  setTime(t, flash = true) {
    this.time = THREE.MathUtils.clamp(t, 0, 1);
    this.setPos(this.time <= 0 ? 0 : this.countAt(this.time), flash);
  }

  stop() {
    this.pause();
    this.active = false;
    for (const k of this.steps) { k.E.unbuilt = false; k.E.fresh = false; delete k.E.step; }
    this.v.seqGhost = false;
    this.v.controls.autoRotate = false;
    this.v.refreshMaterials();
    this.v.updateVisibility();
  }

  // pos = number of parts built (may be fractional while playing)
  setPos(pos, flash = true) {
    const n = this.steps.length;
    pos = THREE.MathUtils.clamp(pos, 0, n);
    const from = Math.floor(this.pos), to = Math.floor(pos);
    const now = performance.now() / 1000;
    const changed = [];
    const all = !this.started;
    for (let i = 0; i < n; i++) {
      if (!all && (i < Math.min(from, to) - 1 || i > Math.max(from, to) + 1)) continue;
      const k = this.steps[i], E = k.E, unbuilt = i >= to;
      if (E.unbuilt !== unbuilt) {
        E.unbuilt = unbuilt;
        if (!unbuilt && flash && to > from) { E.fresh = true; k.at = now; this.freshList.push(k); }
        else E.fresh = false;
        changed.push(E);
      }
    }
    this.started = true;
    this.pos = pos;
    for (const E of changed) for (const m of E.meshes) this.v.applyMaterial(m);
    if (changed.length) this.v.updateVisibility(true);
    this.onChange?.();
  }

  unflash(all) {
    const now = performance.now() / 1000;
    this.freshList = this.freshList.filter(k => {
      if (!all && now - k.at <= FLASH) return true;
      if (k.E.fresh) { k.E.fresh = false; for (const m of k.E.meshes) this.v.applyMaterial(m); }
      return false;
    });
    this.v.requestRender();
  }

  update(dt) {
    this.setTime(this.time + dt / this.duration);
    this.unflash(false);
    if (this.time >= 1) {
      this.unflash(true);
      this.pause();
      this.onEnd?.();
    }
  }

  play() {
    if (this.time >= 1) this.setTime(0, false);
    this.playing = true;
    this.v.controls.autoRotate = this.orbit;
    this.v.controls.autoRotateSpeed = 60 / this.duration;     // about one turn per build
    this.v.tickers.add(this.tick);
    this.onChange?.();
  }

  pause() {
    this.playing = false;
    this.v.controls.autoRotate = false;
    this.v.tickers.delete(this.tick);
    this.onChange?.();
  }

  setGhostRest(on) {
    this.ghostRest = on;
    this.v.seqGhost = on;
    this.v.refreshMaterials();
    this.v.updateVisibility(true);
  }

  // current stage (the one the last built part belongs to)
  get stageIndex() {
    const i = Math.min(this.steps.length - 1, Math.max(0, Math.floor(this.pos) - 1));
    return this.steps.length ? this.steps[i].stage : 0;
  }

  jumpStage(d) {
    const s = THREE.MathUtils.clamp(this.stageIndex + d, 0, this.stages.length - 1);
    // build up to the end of stage s
    let c = 0;
    this.steps.forEach((k, i) => { if (k.stage <= s) c = i + 1; });
    this.time = c >= this.steps.length ? 1 : this.steps[c].t - 1e-9;
    this.unflash(true);
    this.setPos(c, false);
  }
}
