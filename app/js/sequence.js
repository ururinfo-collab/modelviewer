// Construction time-lapse: parts appear stage by stage, newest ones flash orange.
// Order comes from a BuildLapse sequence sidecar (<model>.sequence.json) when there is one,
// else automatic: each part's stage from its tag (S-FDN, A-WALL, P-WATER...), from its name when
// the tag says nothing; bottom up within each stage.
import * as THREE from 'three';

// automatic stages in site order (captions as in BuildLapse)
const STAGES = [
  ['fdn', 'Excavation and foundations', 'မြေတူးခြင်းနှင့် ဖောင်ဒေးရှင်း'],
  ['ug', 'Underground services: tanks, drains and pipes', 'မြေအောက် လုပ်ငန်းများ - ရေကန်၊ မိလ္လာကန်နှင့် ပိုက်များ'],
  ['col', 'Columns', 'တိုင်များ'],
  ['beam', 'Beams', 'ဘီမ်များ'],
  ['slab', 'Slabs', 'ကွန်ကရစ်ကြမ်းခင်း'],
  ['stair', 'Staircase', 'လှေကား'],
  ['steel', 'Roof structure', 'ခေါင်မိုး သံမူဘောင်များ'],
  ['roof', 'Roofing', 'ခေါင်မိုးမိုးခြင်း'],
  ['wall', 'Brickwork and walls', 'အုတ်စီခြင်း'],
  ['open', 'Doors and windows', 'တံခါးနှင့် ပြတင်းပေါက်များ'],
  ['plumb', 'Plumbing and drainage', 'ရေပိုက်နှင့် မိလ္လာပိုက်များ'],
  ['mech', 'Air-conditioning', 'လေအေးပေးစက်'],
  ['elec', 'Electrical', 'လျှပ်စစ်'],
  ['fin', 'Finishes: floors, tiles, ceilings', 'ကြမ်းခင်း၊ နံရံ ကြွေပြားနှင့် မျက်နှာကျက်များ'],
  ['rail', 'Railings', 'လက်ရန်းများ'],
  ['int', 'Interior: kitchen, sanitary ware and furniture', 'မီးဖိုချောင်၊ ရေချိုးခန်းပစ္စည်းနှင့် ပရိဘောဂများ'],
  ['solar', 'Solar panels', 'ဆိုလာပြားများ'],
  ['bound', 'Boundary wall and gate', 'ခြံစည်းရိုးနှင့် ခြံတံခါး'],
  ['site', 'Paving and site works', 'ခြံဝင်း ကြမ်းခင်းနှင့် အပြီးသတ်လုပ်ငန်း'],
  ['other', 'Other parts', ''],
];
// CAD-style tag codes: discipline letter + element code (A-WALL, S-COL, P-WATER, E-ELEC...)
const DISCIPLINE = { P: 'plumb', F: 'plumb', M: 'mech', E: 'elec', I: 'int', X: 'ctx' };
const CODE = {
  FDN: 'fdn', FOUND: 'fdn', FTG: 'fdn', PILE: 'fdn', EXC: 'fdn', COL: 'col', BEAM: 'beam', BM: 'beam', SLAB: 'slab',
  STAIR: 'stair', STEEL: 'steel', TRUSS: 'steel', FRAME: 'steel', ROOF: 'roof', WALL: 'wall', MASN: 'wall', BRICK: 'wall',
  OPEN: 'open', DOOR: 'open', WIN: 'open', GLAZ: 'open', CEIL: 'fin', FLOOR: 'fin', FLOR: 'fin', FIN: 'fin', TILE: 'fin',
  RAIL: 'rail', BOUND: 'bound', FENCE: 'bound', SITE: 'site', LAND: 'site', PAVE: 'site', CTX: 'ctx',
};
// tags without a code: words, most specific first
const TAG_WORDS = [
  ['ctx', /context|indicative|neighbo/i], ['plumb', /plumb|water|waste|soil|drain|sewer|rain|septic/i],
  ['mech', /hvac|air.?con|mechanical|acmv/i], ['elec', /electric|power|lighting/i], ['solar', /solar|\bpv\b/i],
  ['int', /interior|furniture|kitchen|sanitary|joinery/i], ['bound', /boundary|fence|gate/i],
  ['fdn', /foundation|footing|excavat|pile/i], ['stair', /stair/i], ['col', /column/i], ['beam', /beam/i],
  ['slab', /slab/i], ['steel', /truss|purlin|steel/i], ['roof', /roof/i], ['rail', /rail|balustr/i],
  ['open', /door|window|opening|glaz/i], ['fin', /ceiling|finish|tile|floor/i], ['wall', /wall|brick|masonry|partition/i],
  ['site', /site|paving|landscape|garden|terrain/i],
];
// untagged parts: the category guessed from the name
const FROM_CATEGORY = {
  Foundations: 'fdn', Columns: 'col', Beams: 'beam', Slabs: 'slab', Walls: 'wall', Stairs: 'stair', Roof: 'roof',
  Doors: 'open', Windows: 'open', Plumbing: 'plumb', Sanitary: 'int', HVAC: 'mech', Electrical: 'elec', Solar: 'solar',
  Finishes: 'fin', Railings: 'rail', Furniture: 'int', Site: 'site',
};

function stageFromTag(tag) {
  const t = String(tag || '').trim();
  if (!t || /^(untagged|layer0)$/i.test(t)) return null;
  const m = /^([A-Z])-([A-Z]+)/i.exec(t);
  if (m) {
    const d = DISCIPLINE[m[1].toUpperCase()];
    if (d) return d;
    const c = CODE[m[2].toUpperCase()];
    if (c) return c;
  }
  for (const [k, re] of TAG_WORDS) if (re.test(t)) return k;
  return null;
}

export function autoStage(E) {
  if (/\bpv\b|solar panel|solar module/i.test(E.name)) return 'solar';
  return stageFromTag(E.tag) ?? FROM_CATEGORY[E.cat] ?? 'other';
}

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
      return { bottom: box.min.y, top: box.max.y, center: box.getCenter(c).clone() };
    };
    let keyed = [];
    this.unmatched = 0;
    this.stageT = null;
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
          keyed.push({ E, stage: st, key: 1e12 + bottom, bottom, extra: true });   // end of its stage, bottom up
          this.unmatched = (this.unmatched || 0) + 1;
        }
      }
      this.matched = leaves.length - missing.length;
    } else {
      const byStage = new Map();
      for (const E of leaves) {
        let st = autoStage(E);
        if (st === 'ctx' || /context|indicative/i.test(`${E.tag} ${E.name}`)) continue;   // neighbours stay in view
        // services that stay below ground level (y = 0) go in before the ground slab
        if ((st === 'plumb' || st === 'elec' || st === 'mech') && info(E).top < 0.05) st = 'ug';
        if (!byStage.has(st)) byStage.set(st, []);
        byStage.get(st).push(E);
      }
      const present = STAGES.filter(([k]) => byStage.has(k));
      this.stages = present.map(([, en, mm]) => ({ en, mm }));
      present.forEach(([k], i) => {
        for (const E of byStage.get(k)) {
          const { bottom, center } = info(E);
          keyed.push({ E, stage: i, key: bottom * 100 + center.x * 0.01, bottom });
        }
      });
      this.matched = keyed.length;
      this.unmatched = 0;
    }
    keyed.sort((a, b) => a.stage - b.stage || a.key - b.key || a.bottom - b.bottom);
    // Playback time per part (0..1). BuildLapse order: its own frame timing. Automatic: every stage
    // gets the same time, so 1,900 pipe segments do not take half the film.
    const N = this.stages.length;
    const count = this.stages.map(() => 0), seen = this.stages.map(() => 0);
    for (const k of keyed) count[k.stage]++;
    const real = keyed.filter(k => !k.extra);
    let k0 = Infinity, k1 = -Infinity;
    for (const k of real) { k0 = Math.min(k0, k.key); k1 = Math.max(k1, k.key); }
    const stageEnd = this.stages.map(() => 0);
    for (const k of keyed) {
      seen[k.stage]++;
      if (this.data && !k.extra) k.t = (k.key - k0) / Math.max(1, k1 - k0);
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

  // current stage: the latest one whose first part has been built (a stray early part of a later
  // stage does not move the caption)
  get stageIndex() {
    if (!this.stageT) {
      // a stage starts when a tenth of its parts are in
      this.stageT = this.stages.map((_, i) => {
        const ts = this.steps.filter(k => k.stage === i).map(k => k.t).sort((a, b) => a - b);
        return ts.length ? ts[Math.floor(ts.length * 0.1)] : Infinity;
      });
    }
    const t = this.pos > 0 ? Math.max(this.time, this.steps[Math.max(0, Math.floor(this.pos) - 1)].t) : 0;
    let best = 0;
    this.stageT.forEach((s, i) => { if (s <= t && s >= this.stageT[best]) best = i; });
    return best;
  }

  jumpStage(d) {
    const si = this.stageIndex;                               // also fills this.stageT
    const cur = this.pos > 0 ? si : -1;                       // empty site: before stage 1
    if (cur + d < 0) { this.time = 0; this.unflash(true); return this.setPos(0, false); }
    // stages in the order they start; go to the end of the chosen one (just before the next starts)
    const order = this.stages.map((_, i) => i).filter(i => this.stageT[i] < Infinity)
      .sort((a, b) => this.stageT[a] - this.stageT[b]);
    const at = cur < 0 ? -1 : order.indexOf(cur);
    const k = THREE.MathUtils.clamp(at + d, 0, order.length - 1);
    const next = order[k + 1];
    this.unflash(true);
    this.setTime(next === undefined ? 1 : this.stageT[next] - 1e-6, false);
  }
}
