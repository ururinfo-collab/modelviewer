// Side / bottom panels: layers (tags + categories), model tree, object info, section, sun, settings.
import * as THREE from 'three';
import { fmt, fmtVol, getUnit, setUnit, UNITS } from './units.js';
import { sunPosition, sunVectorSrc, localToUtc, SKETCHUP_DEFAULT, FALLBACK } from './sun.js';
import { getSetting, setSetting, listRecent, deleteRecent } from './store.js';
import { icon } from './icons.js';

export const APP_VERSION = '1.1.1';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TITLES = { layers: 'Layers', tree: 'Model tree', info: 'Object info', section: 'Section cut', sun: 'Sun and shadows', settings: 'More' };

export class Panels {
  constructor(app) {
    this.app = app;
    this.v = app.viewer;
    this.name = null;
    this.layersTab = 'tags';
    this.expanded = new Set();
    this.query = '';
    this.body = document.getElementById('panelBody');
    this.v.addEventListener('visibility', () => { if (['layers', 'tree'].includes(this.name)) this.refresh(); });
    this.v.addEventListener('select', () => {
      if (this.name === 'info') this.render('info');
      if (this.name === 'tree') { this.revealSelected(); this.refresh(); this.scrollToSelected(); }
    });
  }

  open(name) {
    this.name = name;
    document.getElementById('panelTitle').textContent = TITLES[name];
    document.getElementById('panel').hidden = false;
    this.body.scrollTop = 0;
    this.render(name);
    if (name === 'tree') { this.revealSelected(); this.refresh(); this.scrollToSelected(); }
  }

  close() {
    this.name = null;
    document.getElementById('panel').hidden = true;
  }

  refresh() { if (this.name) this.render(this.name, true); }

  render(name, keepScroll) {
    const top = this.body.scrollTop;
    this[name]();
    this.app.fillIcons(this.body);
    if (keepScroll) this.body.scrollTop = top;
  }

  // ---- layers ----------------------------------------------------------------

  layers() {
    const v = this.v, tab = this.layersTab;
    const map = tab === 'tags' ? v.tags : v.categories;
    const iso = v.isolated;
    let h = `<div class="seg"><button data-tab="tags" class="${tab === 'tags' ? 'on' : ''}">Tags (${v.tags.size})</button>` +
            `<button data-tab="cats" class="${tab === 'cats' ? 'on' : ''}">Categories (${v.categories.size})</button></div>`;
    h += `<div class="btnrow"><button class="btn" data-all="show">Show all</button><button class="btn" data-all="hide">Hide all</button>` +
         (iso ? '<button class="btn primary" data-all="uniso">Exit isolate</button>' : '') + '</div>';
    if (tab === 'cats') h += '<p class="note">Guessed from object names. Hides the parts themselves, wherever they sit.</p>';
    for (const t of map.values()) {
      const sw = t.color ? `<span class="sw" style="background:rgb(${t.color.slice(0, 3).join(',')})"></span>` : '';
      const isoOn = iso && iso.__key === `${tab}:${t.name}`;
      h += `<div class="row ${t.visible ? '' : 'off'}">${sw}<span class="nm">${esc(t.name)}<small>${t.count}</small></span>` +
           `<button class="ib ${isoOn ? 'on' : ''}" data-iso="${esc(t.name)}" data-icon="isolate" title="Isolate"></button>` +
           `<button class="ib" data-vis="${esc(t.name)}" data-icon="${t.visible ? 'eye' : 'eyeOff'}" title="Show / hide"></button></div>`;
    }
    this.body.innerHTML = h;
    this.body.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tab) { this.layersTab = b.dataset.tab === 'tags' ? 'tags' : 'cats'; return this.render('layers'); }
      if (b.dataset.all === 'show') return v.showAll();
      if (b.dataset.all === 'hide') { for (const t of map.values()) t.visible = false; return v.updateVisibility(); }
      if (b.dataset.all === 'uniso') return v.isolate(null);
      if (b.dataset.vis) { const t = map.get(b.dataset.vis); t.visible = !t.visible; return v.updateVisibility(); }
      if (b.dataset.iso) {
        const key = `${tab}:${b.dataset.iso}`;
        if (iso && iso.__key === key) return v.isolate(null);
        const t = map.get(b.dataset.iso);
        t.visible = true;
        const list = v.ents.filter(E => (tab === 'tags' ? E.tag : E.cat) === b.dataset.iso);
        v.isolate(list);
        v.isolated.__key = key;
        v.updateVisibility();
        v.fitAll();
      }
    };
  }

  // ---- tree ------------------------------------------------------------------

  revealSelected() {
    for (let E = this.v.selected?.parent; E; E = E.parent) this.expanded.add(E.id);
  }

  scrollToSelected() {
    const el = this.body.querySelector('.row.sel');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  tree() {
    const v = this.v;
    let h = `<input class="search" type="search" placeholder="Search ${v.ents.length - 1} objects" value="${esc(this.query)}">`;
    const rows = [];
    const row = (E, depth, path) => {
      const kids = E.children.length;
      const open = this.expanded.has(E.id);
      rows.push(`<div class="row ${E.shown || kids ? '' : 'off'} ${v.selected === E ? 'sel' : ''}" data-id="${E.id}" style="padding-left:${depth * 14}px">` +
        `<button class="exp" data-exp="${E.id}">${kids ? (open ? '▾' : '▸') : ''}</button>` +
        `<span class="nm" data-pick="${E.id}">${esc(E.name)}${path ? `<small>${esc(path)}</small>` : (kids ? `<small>${kids}</small>` : '')}</span>` +
        `<button class="ib" data-zoom="${E.id}" data-icon="zoom" title="Zoom to"></button>` +
        `<button class="ib" data-hide="${E.id}" data-icon="${E.hidden ? 'eyeOff' : 'eye'}" title="Show / hide"></button></div>`);
      if (open && !path) for (const c of E.children) row(c, depth + 1);
    };
    const q = this.query.trim().toLowerCase();
    if (q) {
      const hits = v.ents.filter(E => E !== v.rootEnt && E !== v.top && (`${E.name} ${E.tag} ${E.def}`).toLowerCase().includes(q));
      for (const E of hits.slice(0, 200)) row(E, 0, E.tag);
      if (hits.length > 200) rows.push(`<p class="note">${hits.length - 200} more. Type more of the name.</p>`);
      if (!hits.length) rows.push('<p class="note">Nothing found.</p>');
    } else {
      for (const E of v.top.children) row(E, 0);
      if (v.top.meshes.length) rows.unshift(`<p class="note">${v.top.meshes.length} loose faces at the top level.</p>`);
    }
    this.body.innerHTML = h + `<div class="tree">${rows.join('')}</div>`;
    const input = this.body.querySelector('.search');
    input.oninput = () => {
      this.query = input.value;
      const pos = input.selectionStart;
      this.render('tree');
      const again = this.body.querySelector('.search');
      again.focus();
      again.setSelectionRange(pos, pos);
    };
    this.body.onclick = e => {
      const t = e.target.closest('[data-exp],[data-pick],[data-zoom],[data-hide]');
      if (!t) return;
      const E = v.ents[+(t.dataset.exp ?? t.dataset.pick ?? t.dataset.zoom ?? t.dataset.hide)];
      if (t.dataset.exp) { this.expanded.has(E.id) ? this.expanded.delete(E.id) : this.expanded.add(E.id); this.render('tree', true); }
      else if (t.dataset.pick) v.select(v.selected === E ? null : E);
      else if (t.dataset.zoom) { v.select(E); v.zoomTo(E); }
      else if (t.dataset.hide) v.setHidden(E, !E.hidden);
    };
  }

  // ---- info ------------------------------------------------------------------

  info() {
    const v = this.v, E = v.selected;
    if (!E) { this.body.innerHTML = '<p class="note">Tap an object to see its details.</p>'; return; }
    const b = v.entityBox(E), size = b.getSize(new THREE.Vector3());
    const path = [];
    for (let p = E.parent; p && p !== v.rootEnt && p !== v.top; p = p.parent) path.unshift(p.name);
    let tris = 0, n = 0;
    for (const X of v.descendants(E)) { n++; for (const m of X.meshes) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3; }
    const mats = new Set();
    for (const m of E.meshes) for (const s of [].concat(m.userData.src)) if (s?.name) mats.add(s.name);
    const rows = [
      ['Name', E.name],
      ['Type', E.type ? E.type[0].toUpperCase() + E.type.slice(1) + (E.def && E.def !== E.name ? ` of "${E.def}"` : '') : (E.children.length ? 'Group' : 'Object')],
      ['Tag', E.tag], ['Category', E.cat || 'Container'],
      ['Material', E.material || [...mats].join(', ')],
      ['Inside', path.join(' › ')],
      ['Width (red)', fmt(size.x)], ['Depth (green)', fmt(size.z)], ['Height', fmt(size.y)],
      ['Bottom / top', `${fmt(b.min.y)} / ${fmt(b.max.y)}`],
      ['Volume', E.volume > 0 ? fmtVol(E.volume) : ''],
      ['Parts inside', n > 1 ? String(n - 1) : ''],
      ['Triangles', Math.round(tris).toLocaleString()],
      ['Moved', this.app.move.original.has(E) && !E.obj.matrix.equals(this.app.move.original.get(E)) ? 'Yes (Reset in the Move bar)' : ''],
    ];
    if (E.attrs) for (const [k, val] of Object.entries(E.attrs)) rows.push([k, String(val)]);
    this.body.innerHTML = `<table class="info">${rows.filter(r => r[1]).map(([k, val]) => `<tr><td>${esc(k)}</td><td>${esc(val)}</td></tr>`).join('')}</table>`;
    this.body.onclick = null;
  }

  // ---- section ---------------------------------------------------------------

  section() {
    const s = this.app.section, mode = s.mode;
    const b = (m, label) => `<button class="btn ${mode === m ? 'on' : ''}" data-mode="${m}">${label}</button>`;
    let h = `<div class="btnrow">${b('off', 'Off')}${b('plan', 'Plan (horizontal)')}${b('x', 'Across')}${b('z', 'Along')}${b('face', 'On a face…')}</div>`;
    if (this.app.tool === 'sectionPick') h += '<p class="warn">Tap a wall or floor to cut parallel to it.</p>';
    if (mode !== 'off') {
      const [lo, hi] = s.range;
      const label = mode === 'plan' ? 'Height' : 'Position';
      h += `<div class="field"><label>${label}</label><input type="range" min="${lo}" max="${hi}" step="${Math.max(0.005, (hi - lo) / 1000)}" value="${s.value}"><output>${fmt(s.value)}</output></div>`;
      h += `<div class="btnrow"><button class="btn" data-act="flip">Flip side</button><button class="btn" data-act="m">-10 cm</button><button class="btn" data-act="p">+10 cm</button></div>`;
      h += '<p class="note">Cut faces show in red where the model is closed. Measure and pick ignore the cut-away part.</p>';
    }
    this.body.innerHTML = h;
    const range = this.body.querySelector('input[type=range]'), out = this.body.querySelector('output');
    if (range) range.oninput = () => { s.setValue(+range.value); out.textContent = fmt(s.value); };
    this.body.onclick = e => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.mode === 'face') { this.app.setTool('sectionPick'); return this.render('section'); }
      if (t.dataset.mode) { if (this.app.tool === 'sectionPick') this.app.setTool(null); s.set(t.dataset.mode); return this.render('section'); }
      if (t.dataset.act === 'flip') s.toggleFlip();
      if (t.dataset.act === 'm' || t.dataset.act === 'p') {
        s.setValue(THREE.MathUtils.clamp(s.value + (t.dataset.act === 'p' ? 0.1 : -0.1), s.range[0], s.range[1]));
        this.render('section');
      }
    };
  }

  // ---- sun -------------------------------------------------------------------

  sunDefaults() {
    const v = this.v, loc = v.meta.location;
    const today = new Date();
    const d = { date: today.toISOString().slice(0, 10), minutes: 10 * 60, shadows: false };
    if (loc && loc.lat != null) {
      Object.assign(d, { lat: loc.lat, lon: loc.lon, tz: loc.tz ?? 0, north: loc.north ?? 0, city: loc.city || '' });
      if (loc.time) { d.date = loc.time.slice(0, 10); d.minutes = +loc.time.slice(11, 13) * 60 + +loc.time.slice(14, 16); }
      d.shadows = !!loc.shadows;
    } else Object.assign(d, FALLBACK);
    return d;
  }

  sunInit() {
    this.sunState = { ...this.sunDefaults(), ...getSetting(this.v.modelName, 'sun', {}) };
    this.v.setShadows(!!this.sunState.shadows);
    this.applySun();
  }

  applySun(save = true) {
    const S = this.sunState;
    const [y, m, d] = S.date.split('-').map(Number);
    const utc = localToUtc(y, m, d, S.minutes, S.tz);
    const p = sunPosition(utc, S.lat, S.lon);
    this.sunPos = p;
    this.v.setSunDir(this.v.srcDir(sunVectorSrc(p.el, p.az, S.north).toArray()));
    if (save) setSetting(this.v.modelName, 'sun', S);
  }

  setSunTime(minutes) { this.sunState.minutes = minutes; this.applySun(false); }

  sun() {
    const S = this.sunState, p = this.sunPos;
    const hhmm = mm => `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(Math.round(mm % 60)).padStart(2, '0')}`;
    const boulder = Math.abs(S.lat - SKETCHUP_DEFAULT.lat) < 0.05 && Math.abs(S.lon - SKETCHUP_DEFAULT.lon) < 0.05;
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    let h = `<label class="toggle">Shadows<input type="checkbox" data-k="shadows" ${S.shadows ? 'checked' : ''}></label>`;
    h += `<div class="field"><label>Time</label><input type="range" data-k="minutes" min="300" max="1200" step="5" value="${S.minutes}"><output id="sunT">${hhmm(S.minutes)}</output></div>`;
    h += `<div class="btnrow"><button class="btn" data-act="play">${this.playing ? 'Stop' : 'Play the day'}</button>` +
         `<button class="btn primary" data-act="recday">Record the day</button><button class="btn" data-act="now">Now</button></div>`;
    h += `<div class="field"><label>Date</label><input type="date" data-k="date" value="${S.date}"></div>`;
    h += `<p class="note" id="sunInfo">${p ? (p.el > 0 ? `Sun ${p.el.toFixed(0)}° up, from the ${dirs[Math.round(p.az / 45) % 8]} (${p.az.toFixed(0)}°)` : 'Sun is below the horizon') : ''}</p>`;
    if (boulder) h += '<p class="warn">The model still has SketchUp\'s default location (Boulder, USA). Set the site below, or in SketchUp: Window › Model Info › Geo-location.</p>';
    h += `<div class="field"><label>Latitude</label><input type="number" step="0.0001" data-k="lat" value="${S.lat}"></div>`;
    h += `<div class="field"><label>Longitude</label><input type="number" step="0.0001" data-k="lon" value="${S.lon}"></div>`;
    h += `<div class="field"><label>UTC offset (h)</label><input type="number" step="0.5" data-k="tz" value="${S.tz}"></div>`;
    h += `<div class="field"><label>North angle</label><input type="number" step="1" data-k="north" value="${S.north}"></div>`;
    h += `<div class="btnrow"><button class="btn" data-act="yangon">Yangon</button><button class="btn" data-act="mandalay">Mandalay</button><button class="btn" data-act="file">From the model</button></div>`;
    this.body.innerHTML = h;
    this.body.oninput = e => {
      const k = e.target.dataset.k;
      if (!k) return;
      if (k === 'shadows') { S.shadows = e.target.checked; this.v.setShadows(S.shadows); }
      else if (k === 'date') S.date = e.target.value || S.date;
      else S[k] = +e.target.value;
      this.applySun();
      if (k === 'minutes') this.body.querySelector('#sunT').textContent = hhmm(S.minutes);
      this.updateSunInfo(dirs);
    };
    this.body.onclick = e => {
      const a = e.target.closest('button')?.dataset.act;
      if (!a) return;
      if (a === 'play') { this.recordingDay = false; return this.togglePlay(); }
      if (a === 'recday') {          // 05:30 to 19:00 with shadows, about 14 s of video with the time on it
        if (this.app.recorder.active) return;
        S.shadows = true;
        this.v.setShadows(true);
        S.minutes = 330;
        this.applySun();
        if (!this.playing) this.togglePlay();
        this.recordingDay = true;
        this.app.toggleRecord();
        if (!this.app.recorder.active) { this.recordingDay = false; this.togglePlay(); }
        return this.render('sun');
      }
      if (a === 'now') { const n = new Date(Date.now() + S.tz * 3600000); S.date = n.toISOString().slice(0, 10); S.minutes = n.getUTCHours() * 60 + n.getUTCMinutes(); }
      if (a === 'yangon') Object.assign(S, { lat: 16.8409, lon: 96.1735, tz: 6.5 });
      if (a === 'mandalay') Object.assign(S, { lat: 21.9588, lon: 96.0891, tz: 6.5 });
      if (a === 'file') Object.assign(S, this.sunDefaults(), { shadows: S.shadows });
      this.applySun();
      this.render('sun');
    };
  }

  updateSunInfo(dirs) {
    const p = this.sunPos, el = this.body.querySelector('#sunInfo');
    if (el && p) el.textContent = p.el > 0 ? `Sun ${p.el.toFixed(0)}° up, from the ${dirs[Math.round(p.az / 45) % 8]} (${p.az.toFixed(0)}°)` : 'Sun is below the horizon';
  }

  togglePlay() {
    const v = this.v;
    if (this.playing) { v.tickers.delete(this.playing); this.playing = null; this.applySun(); }
    else {
      this.playing = dt => {
        let m = this.sunState.minutes + dt * 60;     // one hour per second
        if (m > 1140) {
          if (this.recordingDay) {                  // "Record the day" ends at 19:00
            this.recordingDay = false;
            this.togglePlay();
            if (this.app.recorder.active) this.app.toggleRecord();
            return;
          }
          m = 330;
        }
        this.setSunTime(m);
        if (this.name === 'sun') {
          const r = this.body.querySelector('input[data-k=minutes]'), o = this.body.querySelector('#sunT');
          if (r) r.value = m;
          if (o) o.textContent = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
        }
      };
      v.tickers.add(this.playing);
    }
    if (this.name === 'sun') this.render('sun');
  }

  // ---- settings --------------------------------------------------------------

  settings() {
    const v = this.v, app = this.app;
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    let h = `<label class="toggle">Edge lines<input type="checkbox" data-k="edges" ${v.edges ? 'checked' : ''}></label>`;
    h += `<div class="field"><label>Units</label><select data-k="unit">${Object.entries(UNITS).map(([k, n]) => `<option value="${k}" ${getUnit() === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>`;
    h += `<div class="field"><label>Sharpness</label><select data-k="pr">${[[1, 'Battery saver'], [1.5, 'Normal'], [2, 'Sharp']].map(([k, n]) => `<option value="${k}" ${v.pixelRatio === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>`;
    h += `<div class="field"><label>Walk eye height</label><input type="number" step="0.05" data-k="eye" value="${app.walk.eye}"></div>`;
    h += `<div class="field"><label>Photo size</label><select data-k="shotScale">${[[1, 'Screen'], [2, '2x'], [3, '3x']].map(([k, n]) => `<option value="${k}" ${app.shotScale === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>`;
    const moved = app.move.editedCount;
    h += `<div class="btnrow"><button class="btn" data-act="showall">Show everything</button>` +
         `<button class="btn" data-act="resetmoved" ${moved ? '' : 'disabled'}>Reset moved objects (${moved})</button></div>`;
    h += `<div class="btnrow"><button class="btn" data-act="open">Open another model</button><button class="btn" data-act="forget">Clear models kept on this phone</button></div>`;
    if (!standalone) h += `<p class="note">${ios ? 'Install: tap Share, then Add to Home Screen.' : 'Install: browser menu (⋮), then Install app / Add to Home screen.'}</p>`;
    h += `<p class="note">Model Viewer ${APP_VERSION} · opens .skp .glb .gltf .dae · three.js r180 · ${v.ents.length - 1} objects, ${v.meshes.length} meshes</p>`;
    this.body.innerHTML = h;
    this.body.onchange = e => {
      const k = e.target.dataset.k;
      if (k === 'edges') v.setEdges(e.target.checked);
      if (k === 'unit') { setUnit(e.target.value); app.onUnit(); }
      if (k === 'pr') { v.pixelRatio = +e.target.value; v.renderer.setPixelRatio(v.pixelRatio); v.resize(); }
      if (k === 'eye') app.walk.eye = +e.target.value || 1.6;
      if (k === 'shotScale') app.shotScale = +e.target.value;
    };
    this.body.onclick = async e => {
      const a = e.target.closest('button')?.dataset.act;
      if (a === 'showall') v.showAll();
      if (a === 'resetmoved') { app.move.resetAll(); this.render('settings'); }
      if (a === 'open') app.showWelcome();
      if (a === 'forget' && confirm('Remove the models kept on this phone? Your files elsewhere are not touched.')) {
        for (const r of await listRecent()) await deleteRecent(r.name);
        app.toast('Cleared');
      }
    };
  }
}

export { esc, icon };
