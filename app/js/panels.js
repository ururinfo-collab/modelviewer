// Side / bottom panels: layers (tags + categories), model tree, object info, section, sun, settings.
import * as THREE from 'three';
import { fmt, fmtVol, fmtArea, getUnit, setUnit, UNITS } from './units.js';
import { sunPosition, sunVectorSrc, localToUtc, SKETCHUP_DEFAULT, FALLBACK } from './sun.js';
import { getSetting, setSetting, listRecent, deleteRecent } from './store.js';
import { icon } from './icons.js';
import { STYLES, BACKGROUNDS, GROUNDS } from './look.js';
import { quantities, toCSV } from './quantities.js';
import { PRESETS, GEMINI_MODELS } from './ai.js';

export const APP_VERSION = '1.19.0';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TITLES = { layers: 'Layers', tree: 'Model tree', info: 'Object info', section: 'Section cut', sun: 'Sun and shadows', settings: 'More', look: 'Look', qty: 'Quantities', compare: 'Compare revisions', notes: 'Notes', ai: 'AI render', share: 'Client link' };

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
      if (this.name === 'section') this.render('section', true);
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
    const hiddenEnts = v.ents.filter(E => E.hidden), ghostEnts = v.ents.filter(E => E.ghost && !(E.parent?.ghost));
    let h = `<div class="seg"><button data-tab="tags" class="${tab === 'tags' ? 'on' : ''}">Tags (${v.tags.size})</button>` +
            `<button data-tab="cats" class="${tab === 'cats' ? 'on' : ''}">Categories (${v.categories.size})</button>` +
            `<button data-tab="hidden" class="${tab === 'hidden' ? 'on' : ''}">Hidden (${hiddenEnts.length + ghostEnts.length})</button></div>`;
    if (tab === 'hidden') return this.hiddenList(h, hiddenEnts, ghostEnts);
    const map = tab === 'tags' ? v.tags : v.categories;
    const iso = v.isolated;
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
      const rec = label => this.app.history.record(label);
      if (b.dataset.tab) { this.layersTab = b.dataset.tab; return this.render('layers'); }
      if (b.dataset.all === 'show') { rec('Show all'); return v.showAll(); }
      if (b.dataset.all === 'hide') { rec(`Hide all ${tab === 'tags' ? 'tags' : 'categories'}`); for (const t of map.values()) t.visible = false; return v.updateVisibility(); }
      if (b.dataset.all === 'uniso') { rec('Exit isolate'); return v.isolate(null); }
      if (b.dataset.vis) {
        const t = map.get(b.dataset.vis);
        rec(`${t.visible ? 'Hide' : 'Show'} ${t.name}`);
        t.visible = !t.visible;
        return v.updateVisibility();
      }
      if (b.dataset.iso) {
        const key = `${tab}:${b.dataset.iso}`;
        rec(iso && iso.__key === key ? 'Exit isolate' : `Isolate ${b.dataset.iso}`);
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

  // objects hidden or made see-through one by one: bring them back singly or all at once
  hiddenList(head, hiddenEnts, ghostEnts) {
    const v = this.v;
    const path = E => {
      const p = [];
      for (let a = E.parent; a && a !== v.top && a !== v.rootEnt; a = a.parent) p.unshift(a.name);
      return p.join(' › ');
    };
    const row = (E, kind) => `<div class="row"><span class="nm">${esc(E.name)}<small>${esc(path(E) || E.tag || '')}</small></span>` +
      `<button class="ib" data-zoomback="${E.id}" data-kind="${kind}" data-icon="zoom" title="Show and zoom to it"></button>` +
      `<button class="ib" data-back="${E.id}" data-kind="${kind}" data-icon="eye" title="Show again"></button></div>`;
    let h = head;
    if (!hiddenEnts.length && !ghostEnts.length) h += '<p class="note">Nothing hidden. Objects you hide with the Hide button or the tree show up here.</p>';
    if (hiddenEnts.length) {
      h += `<div class="btnrow"><button class="btn primary" data-allback="hidden">Show all ${hiddenEnts.length} hidden</button></div>`;
      h += hiddenEnts.map(E => row(E, 'hidden')).join('');
    }
    if (ghostEnts.length) {
      h += `<p class="note" style="margin-top:14px">See-through</p><div class="btnrow"><button class="btn" data-allback="ghost">Make all solid</button></div>`;
      h += ghostEnts.map(E => row(E, 'ghost')).join('');
    }
    this.body.innerHTML = h;
    this.body.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tab) { this.layersTab = b.dataset.tab; return this.render('layers'); }
      const rec = label => this.app.history.record(label);
      if (b.dataset.allback === 'hidden') { rec('Show hidden objects'); for (const E of hiddenEnts) E.hidden = false; return v.updateVisibility(); }
      if (b.dataset.allback === 'ghost') { rec('Make all solid'); for (const E of v.ents) E.ghost = false; v.refreshMaterials(); return this.render('layers', true); }
      const id = b.dataset.back ?? b.dataset.zoomback;
      if (id == null) return;
      const E = v.ents[+id];
      rec(`Show ${E.name}`);
      if (b.dataset.kind === 'hidden') v.setHidden(E, false);
      else { v.setGhost(E, false); this.render('layers', true); }
      if (b.dataset.zoomback != null) { v.select(E); v.zoomTo(E); }
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
      else if (t.dataset.hide) { this.app.history.record(`${E.hidden ? 'Show' : 'Hide'} ${E.name}`); v.setHidden(E, !E.hidden); }
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
    let h = `<div class="btnrow">${b('off', 'Off')}${b('plan', 'Plan (horizontal)')}${b('x', 'Across')}${b('z', 'Along')}${b('face', 'On a face…')}${b('box', 'Box')}</div>`;
    if (this.app.tool === 'sectionPick') h += '<p class="warn">Tap a wall or floor to cut parallel to it.</p>';
    if (mode === 'box') return this.sectionBox(h);
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

  // six sides: a slider each over the model's extent (plus a metre), -10 / +10 cm buttons
  sectionBox(head) {
    const s = this.app.section, v = this.v, B = s.box, M = v.box;
    const sides = [
      ['minX', 'Left (red −)', 'x'], ['maxX', 'Right (red +)', 'x'],
      ['maxZ', 'Front (green −)', 'z'], ['minZ', 'Back (green +)', 'z'],
      ['minY', 'Bottom', 'y'], ['maxY', 'Top', 'y'],
    ];
    let h = head;
    h += `<div class="btnrow"><button class="btn primary" data-fit="sel" ${v.selected ? '' : 'disabled'}>Box around the selection</button>` +
      '<button class="btn" data-fit="all">Box around everything</button><button class="btn" data-fit="zoom">Zoom to the box</button></div>';
    if (!v.selected) h += '<p class="note">For one room: select its floor (or anything in it), then Box around the selection.</p>';
    for (const [side, label, k] of sides) {
      const val = B[side.slice(0, 3)][k];
      h += `<div class="field"><label>${label}</label><input type="range" data-side="${side}" min="${M.min[k] - 1}" max="${M.max[k] + 1}" step="0.01" value="${val}">` +
        `<button class="btn" data-nudge="${side}:-0.1">−</button><button class="btn" data-nudge="${side}:0.1">+</button></div>`;
    }
    h += `<p class="note">Box ${fmt(B.max.x - B.min.x)} × ${fmt(B.max.z - B.min.z)} × ${fmt(B.max.y - B.min.y)} high. Cut faces show red.</p>`;
    this.body.innerHTML = h;
    this.body.oninput = e => { const r = e.target.dataset.side; if (r) s.setSide(r, +e.target.value); };
    this.body.onchange = e => { if (e.target.dataset.side) this.render('section', true); };
    this.body.onclick = e => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.mode) { s.set(t.dataset.mode); return this.render('section'); }
      if (t.dataset.fit === 'sel' && v.selected) { s.fitBox(v.entityBox(v.selected), true); v.fitBox(s.box.clone()); }
      if (t.dataset.fit === 'all') s.fitBox(v.visibleBox(), false);
      if (t.dataset.fit === 'zoom') v.fitBox(s.box.clone());
      if (t.dataset.nudge) { const [side, d] = t.dataset.nudge.split(':'); s.moveSide(side, +d); }
      this.render('section', true);
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

  // ---- notes ------------------------------------------------------------------------

  notes() {
    const N = this.app.notes, client = !!this.app.client;
    let h = client ? '' : '<div class="btnrow"><button class="btn primary" data-act="add">Add a note</button>' +
      '<button class="btn" data-act="export">Export</button><button class="btn" data-act="import">Import</button></div>';
    h += `<label class="toggle">Show the pins<input type="checkbox" data-k="pins" ${N.visible ? 'checked' : ''}></label>`;
    if (client) h += `<p class="note">${N.list.length ? 'The architect\'s notes. Tap one to read it and see its photo.' : 'No notes were shared with this model.'}</p>`;
    else if (!N.list.length) h += '<p class="note">No notes yet. Tap Add a note, then tap the spot on the model.</p>';
    else h += '<p class="note">Saved on this device for this model. Export to move them to another phone or computer.</p>';
    h += N.list.map((n, i) => `<div class="row"><span class="nm" data-open="${esc(n.id)}"><b>${i + 1}.</b> ${esc(n.text.split('\n')[0] || '(no text)')}` +
      `<small>${esc(n.date || '')}${n.photo ? ' · photo' : ''}</small></span>` +
      `<button class="ib" data-goto="${esc(n.id)}" data-icon="zoom" title="Go to its view"></button>` +
      (client ? '' : `<button class="ib" data-del="${esc(n.id)}" data-icon="trash" title="Delete this note"></button>`) + '</div>').join('');
    if (N.list.length > 1 && !client) h += '<div class="btnrow"><button class="btn" data-act="clear">Delete all notes</button></div>';
    this.body.innerHTML = h;
    this.body.onclick = e => {
      const t = e.target.closest('[data-act],[data-open],[data-goto],[data-del]');
      if (!t) return;
      if (t.dataset.act === 'add') return this.app.startNote();
      if (t.dataset.act === 'export') return this.app.saveFile(N.exportFile());
      if (t.dataset.act === 'import') return document.getElementById('notesFile').click();
      if (t.dataset.act === 'clear') {
        if (confirm(`Delete all ${N.list.length} notes of this model?`) && !N.removeAll()) this.app.toast('The device could not save the change', 5000);
        return;
      }
      if (t.dataset.del) { if (confirm('Delete this note?')) this.app.deleteNote(t.dataset.del); return; }
      if (t.dataset.open) return this.app.openNote(t.dataset.open);
      if (t.dataset.goto) N.go(t.dataset.goto);
    };
    this.body.onchange = e => { if (e.target.dataset.k === 'pins') N.setVisible(e.target.checked); };
  }

  // ---- revision compare -------------------------------------------------------------

  compare() {
    const C = this.app.compare, v = this.v;
    if (!C.active) {
      this.body.innerHTML = `<p class="note">Compare the open model with another revision of it (.skp, .glb or .dae). ` +
        `Parts are matched by name and place: <b style="color:#2e9e4f">added</b>, <b style="color:#f08c00">moved or resized</b> ` +
        `and <b style="color:#d23c2c">removed</b> parts are coloured, the rest fades.</p>` +
        '<div class="btnrow"><button class="btn primary" data-act="pick">Choose the other revision...</button></div>';
      this.body.onclick = e => { if (e.target.closest('[data-act=pick]')) document.getElementById('compareFile').click(); };
      return;
    }
    const L = C.lists;
    const row = (kind, i, name, extra = '') => `<div class="row"><span class="sw" style="background:${{ added: '#2e9e4f', changed: '#f08c00', removed: '#d23c2c' }[kind]}"></span>` +
      `<span class="nm" data-go="${kind}:${i}">${esc(name)}${extra ? `<small>${extra}</small>` : ''}</span>` +
      `<button class="ib" data-go="${kind}:${i}" data-icon="zoom" title="Zoom to it"></button></div>`;
    let h = `<p class="note">Open model compared with <b>${esc(C.otherName)}</b></p>`;
    h += `<div class="btnrow"><span class="btn" style="background:#2e9e4f;color:#fff">${L.added.length} added</span>` +
      `<span class="btn" style="background:#f08c00;color:#fff">${L.changed.length} changed</span>` +
      `<span class="btn" style="background:#d23c2c;color:#fff">${L.removed.length} removed</span>` +
      `<span class="btn">${L.same.length} same</span></div>`;
    h += `<label class="toggle">Show unchanged parts (faded)<input type="checkbox" data-k="same" ${C.showSame ? 'checked' : ''}></label>`;
    h += `<label class="toggle">Show removed parts (red)<input type="checkbox" data-k="removed" ${C.showRemoved ? 'checked' : ''}></label>`;
    h += '<div class="btnrow"><button class="btn" data-act="end">End comparison</button><button class="btn" data-act="pick">Compare with another file...</button></div>';
    const cap = (arr, kind, fn) => arr.slice(0, 300).map(fn).join('') + (arr.length > 300 ? `<p class="note">${arr.length - 300} more ${kind}</p>` : '');
    if (L.added.length) h += '<p class="note" style="margin-top:12px">Added</p>' + cap(L.added, 'added', (E, i) => row('added', i, E.name, E.tag?.split(' ')[0]));
    if (L.changed.length) h += '<p class="note" style="margin-top:12px">Moved or resized</p>' + cap(L.changed, 'changed', (E, i) => row('changed', i, E.name, `by ${fmt(E.diffBy)}`));
    if (L.removed.length) h += '<p class="note" style="margin-top:12px">Removed</p>' + cap(L.removed, 'removed', (q, i) => row('removed', i, q.name));
    this.body.innerHTML = h;
    this.body.onclick = e => {
      const t = e.target.closest('[data-go],[data-act]');
      if (!t) return;
      if (t.dataset.act === 'end') { C.stop(); return this.render('compare'); }
      if (t.dataset.act === 'pick') return document.getElementById('compareFile').click();
      const [kind, i] = t.dataset.go.split(':');
      if (kind === 'removed') { v.select(null); v.fitBox(L.removed[+i].box.clone().expandByScalar(1)); }
      else { const E = L[kind][+i]; v.select(E); v.zoomTo(E); }
    };
    this.body.onchange = e => {
      if (e.target.dataset.k === 'same') C.showSame = e.target.checked;
      if (e.target.dataset.k === 'removed') C.showRemoved = e.target.checked;
      C.apply();
    };
  }

  // ---- quantities ----------------------------------------------------------------

  qty() {
    const v = this.v, by = this.qtyBy || 'tag', vis = this.qtyVisible ?? true;
    const groups = quantities(v, by, vis);
    this.qtyGroups = groups;
    const label = { tag: 'Tag', cat: 'Category', name: 'Name' };
    let h = `<div class="seg">${Object.entries(label).map(([k, n]) => `<button data-by="${k}" class="${by === k ? 'on' : ''}">By ${n.toLowerCase()}</button>`).join('')}</div>`;
    h += `<label class="toggle">Only what is shown now<input type="checkbox" data-k="vis" ${vis ? 'checked' : ''}></label>`;
    h += '<div class="btnrow"><button class="btn primary" data-act="csv">Export CSV (Excel)</button></div>';
    const tot = groups.reduce((t, g) => ({ count: t.count + g.count, volume: t.volume + g.volume, area: t.area + g.area }), { count: 0, volume: 0, area: 0 });
    h += `<p class="note">${tot.count} objects · ${fmtVol(tot.volume)} solid volume · ${fmtArea(tot.area)} surface. Volumes count closed solids only.</p>`;
    h += groups.map((g, i) => `<div class="row qrow"><span class="nm">${esc(g.name)}<small>${g.count} pcs · ${g.volParts ? fmtVol(g.volume) : 'no solid volume'} · ${fmtArea(g.area)} · ${fmt(g.length)} long</small></span>` +
      `<button class="ib" data-iso="${i}" data-icon="isolate" title="Show only these"></button></div>`).join('');
    this.body.innerHTML = h;
    this.body.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.by) { this.qtyBy = b.dataset.by; return this.render('qty'); }
      if (b.dataset.act === 'csv') {
        const csv = toCSV(groups, label[by]);
        const name = `${(v.modelName || 'model').replace(/\.(skp|glb|gltf|dae)$/i, '')}_quantities_by_${label[by].toLowerCase()}.csv`;
        return this.app.saveFile({ blob: new Blob([csv], { type: 'text/csv' }), name });
      }
      if (b.dataset.iso != null) {
        const g = groups[+b.dataset.iso];
        this.app.history.record(`Isolate ${g.name}`);
        v.isolate(g.objects.map(o => o.E));
        v.fitAll();
      }
    };
    this.body.onchange = e => { if (e.target.dataset.k === 'vis') { this.qtyVisible = e.target.checked; this.render('qty'); } };
  }

  // ---- look: render style and lighting ------------------------------------------

  look() {
    const L = this.app.look, s = L.state, st = L.style;
    const seg = (key, opts, cur) => `<div class="seg">${Object.entries(opts).map(([k, n]) =>
      `<button data-set="${key}" data-val="${k}" class="${cur === k ? 'on' : ''}">${n}</button>`).join('')}</div>`;
    let h = '<div class="menu stylelist">' + Object.entries(STYLES).map(([k, d]) =>
      `<button data-style="${k}" class="${s.style === k ? 'on' : ''}"><b>${s.style === k ? '✓ ' : ''}${d.label}</b><small>${d.note}</small></button>`).join('') + '</div>';
    h += '<p class="note" style="margin-top:12px">Background</p>' + seg('bg', BACKGROUNDS, L.bg);
    h += '<p class="note">Ground</p>' + seg('ground', GROUNDS, L.ground);
    h += `<label class="toggle">Soft shadows in corners (ambient occlusion)<input type="checkbox" data-k="ao" ${L.ao ? 'checked' : ''}></label>`;
    h += `<label class="toggle">Sun shadows<input type="checkbox" data-k="shadows" ${this.v.shadows ? 'checked' : ''}></label>`;
    h += `<label class="toggle">Edge lines<input type="checkbox" data-k="edges" ${L.edges ? 'checked' : ''}></label>`;
    if (st.tone) h += `<div class="field"><label>Brightness</label><input type="range" data-k="exposure" min="0.5" max="1.8" step="0.05" value="${s.exposure}"><output>${s.exposure.toFixed(2)}</output></div>`;
    h += '<p class="note">Soft corners are off on phones unless you switch them on (they cost battery). In See inside and X-ray they pause.</p>';
    this.body.innerHTML = h;
    this.body.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.style) { L.setStyle(b.dataset.style); return this.render('look', true); }
      if (b.dataset.set) { L.set(b.dataset.set, b.dataset.val); return this.render('look', true); }
    };
    this.body.oninput = e => {
      const k = e.target.dataset.k;
      if (k === 'ao') L.set('ao', e.target.checked);
      if (k === 'edges') L.set('edges', e.target.checked);
      if (k === 'exposure') { L.set('exposure', +e.target.value); e.target.nextElementSibling.textContent = (+e.target.value).toFixed(2); }
      if (k === 'shadows') {
        const S = this.sunState;
        S.shadows = e.target.checked;
        this.v.setShadows(S.shadows);
        this.applySun();
      }
    };
  }

  // ---- AI render (SketchRender's engines: the PC's graphics card or Gemini) ------------------

  ai() {
    const A = this.app.ai, S = A.store;
    const seg = (key, opts) => `<div class="seg">${Object.entries(opts).map(([k, n]) =>
      `<button data-set="${key}" data-val="${k}" class="${String(S[key]) === k ? 'on' : ''}">${n}</button>`).join('')}</div>`;
    let h = seg('engine', { auto: 'Auto', pc: 'PC (free)', gemini: 'Gemini' });
    h += '<p class="note">Style</p><div class="chips">' + PRESETS.map(p =>
      `<button class="chip ${S.preset === p.id ? 'on' : ''}" data-preset="${p.id}">${p.name}</button>`).join('') + '</div>';
    h += `<textarea id="aiExtra" rows="2" placeholder="Extra (optional): red clay roof tiles, a white car in the driveway...">${esc(S.extra)}</textarea>`;
    if (S.engine !== 'gemini') {
      h += '<p class="note">PC: how far it may stray from the model colours</p>' + seg('freedom', { low: 'Low', medium: 'Medium', high: 'High' });
      h += `<label class="toggle">PC: extra detail (about twice as long)<input type="checkbox" data-k="detail" ${S.detail ? 'checked' : ''}></label>`;
    }
    if (S.engine !== 'pc') {
      const price = GEMINI_MODELS[S.model]?.price[S.size];
      h += '<p class="note">Gemini quality and size</p>' + seg('model', Object.fromEntries(Object.entries(GEMINI_MODELS).map(([k, m]) => [k, m.name])));
      h += seg('size', { '1K': '1K', '2K': '2K', '4K': '4K' });
      if (price) h += `<p class="note">About $${price.toFixed(3)} per Gemini render (Google list price).</p>`;
    }
    h += `<div class="btnrow"><button class="btn primary" data-act="render" ${A.busy ? 'disabled' : ''}>${A.busy ? 'Rendering...' : 'Render this view'}</button>` +
      (A.busy ? '<button class="btn" data-act="cancel">Cancel</button>' : '') + '</div>';
    h += `<p class="note" id="aiStatus">${esc(A.status || 'Frame the view, pick a style, render. Hidden parts and section cuts carry into the picture.')}</p>`;
    if (A.results.length) {
      h += '<p class="note">This session</p><div class="aithumbs">' + A.results.map((r, i) =>
        `<button data-res="${i}" title="${esc(r.preset)}"><img src="${r.url}" alt=""></button>`).join('') + '</div>';
    }
    h += '<details class="aiset"><summary>AI render settings</summary>';
    h += `<div class="field"><label>PC address</label><input id="aiPC" type="text" inputmode="url" placeholder="192.168.x.x:8765" value="${esc(S.pc)}"></div>`;
    h += '<div class="btnrow"><button class="btn" data-act="testpc">Test the PC</button></div>';
    h += '<p class="note">On the PC run the Model Viewer Wi-Fi server (it also drives SketchRender\'s local engine). Opened from the PC link, the address is found by itself. Chrome may ask once to allow devices on your local network: allow it.</p>';
    h += `<div class="field"><label>Gemini key</label><input id="aiKey" type="password" autocomplete="off" placeholder="${A.gemini.key ? 'saved on this device' : 'paste the Google API key'}"></div>`;
    h += '<div class="btnrow"><button class="btn" data-act="savekey">Save key</button><button class="btn" data-act="testkey">Test key</button>' +
      (A.gemini.key ? '<button class="btn" data-act="forgetkey">Forget key</button>' : '') + '</div>';
    h += '<p class="note">The key stays on this device only and goes only to Google. Make one at aistudio.google.com/apikey (billing on: images are paid).</p></details>';
    this.body.innerHTML = h;
    const status = this.body.querySelector('#aiStatus');
    A.onStatus = s => { if (this.name === 'ai') { status.textContent = s; if (!A.busy) this.render('ai', true); } };
    const say = s => { status.textContent = s; };
    this.body.onclick = async e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.set) { A.set(b.dataset.set, b.dataset.val); return this.render('ai', true); }
      if (b.dataset.preset) { A.set('preset', b.dataset.preset); return this.render('ai', true); }
      if (b.dataset.res) return this.app.showAIResult(A.results[+b.dataset.res]);
      const act = b.dataset.act;
      if (act === 'render') {
        const p = A.render().catch(() => {});
        this.render('ai', true);
        return p;
      }
      if (act === 'cancel') return A.cancel();
      if (act === 'testpc') {
        say('Looking for the PC...');
        const j = await A.pc.find();
        return say(!j ? 'The PC did not answer. Is the Wi-Fi server running, and the address right?'
          : !j.installed ? `PC found (${A.pc.base}) but SketchRender's local engine is not installed there.`
          : `PC found (${A.pc.base}). Local engine ${j.running ? 'running' : 'starts on the first render (about a minute)'}.`);
      }
      if (act === 'savekey') {
        const k = this.body.querySelector('#aiKey').value.trim();
        if (!k) return say('Paste the key first.');
        A.gemini.key = k;
        this.render('ai', true);
        return this.app.toast('Gemini key saved on this device');
      }
      if (act === 'testkey') {
        const k = this.body.querySelector('#aiKey').value.trim() || A.gemini.key;
        if (!k) return say('Paste the key first.');
        say('Testing the key...');
        try { await A.gemini.test(k); say('Key works.'); } catch (err) { say(err.message); }
        return;
      }
      if (act === 'forgetkey') { A.gemini.key = ''; return this.render('ai', true); }
    };
    this.body.oninput = e => {
      if (e.target.id === 'aiExtra') A.set('extra', e.target.value);
      if (e.target.id === 'aiPC') A.set('pc', e.target.value.trim());
      if (e.target.dataset.k === 'detail') A.set('detail', e.target.checked);
    };
  }

  // ---- client link: a view-only copy for a client ------------------------------------------

  share() {
    const app = this.app, S = app.share, v = this.v;
    const say = (s, warn) => { const el = this.body.querySelector('#shStatus'); if (el) { el.textContent = s; el.className = warn ? 'warn' : 'note'; } };
    let h = '';
    if (!S.code) {
      // first the owner code: chosen once (first device), typed once on each other device
      if (S.claimed === null) { S.status().then(() => this.name === 'share' && this.render('share')).catch(e => say(e.message, true)); }
      h += S.claimed === false
        ? '<p class="note">Choose an owner code (at least 8 characters). It protects your client links: only someone with this code can make or withdraw links. Keep it somewhere safe; you type it once on each device you share from.</p>'
        : '<p class="note">Type your owner code (the one you chose the first time) to make and manage client links on this device.</p>';
      h += `<div class="field"><label>Owner code</label><input id="shCode" type="password" autocomplete="off" minlength="8"></div>`;
      h += `<div class="btnrow"><button class="btn primary" data-act="signin" ${S.claimed === null ? 'disabled' : ''}>${S.claimed === false ? 'Set owner code' : 'Continue'}</button></div>`;
      h += '<p class="note" id="shStatus"></p>';
    } else {
      const order = app.chosenOrder?.(), nNotes = app.notes.list.length;
      const days = this.shareDays || 30;
      h += `<div class="field"><label>Title</label><input id="shTitle" type="text" value="${esc(this.shareTitle ?? (v.meta?.title || document.title))}"></div>`;
      h += '<p class="note">The link works for</p><div class="seg">' + [[7, '1 week'], [30, '30 days'], [90, '3 months'], [365, '1 year']].map(([d, n]) =>
        `<button data-days="${d}" class="${days === d ? 'on' : ''}">${n}</button>`).join('') + '</div>';
      h += `<label class="toggle">Include my notes (${nNotes}, read-only)<input type="checkbox" data-k="shNotes" ${this.shareNotes !== false && nNotes ? 'checked' : ''} ${nNotes ? '' : 'disabled'}></label>`;
      h += `<label class="toggle">Build time-lapse with ${order ? 'my build order' : 'the automatic order'}<input type="checkbox" checked disabled></label>`;
      h += '<div class="btnrow"><button class="btn primary" data-act="create">Create client link</button></div>';
      h += `<p class="${this.shareMsg ? 'warn' : 'note'}" id="shStatus">${esc(this.shareMsg || 'The client can orbit, use your scenes, layers, section, measure, walk, See-thru, Look, Sun, photo and AR. They cannot move objects, compare, open other files or change notes.')}</p>`;
      this.shareMsg = null;
      if (this.shareLast) {
        h += `<div class="shlink"><input type="text" readonly value="${esc(this.shareLast)}"><div class="btnrow">` +
          '<button class="btn primary" data-act="sendlast">Share</button><button class="btn" data-act="copylast">Copy</button></div></div>';
      }
      h += '<p class="note" style="margin-top:14px"><b>Your links</b></p><div id="shList">' + this.shareRows() + '</div>';
      h += '<div class="btnrow"><button class="btn" data-act="refresh">Refresh</button><button class="btn" data-act="forget">Forget owner code here</button></div>';
      if (!S.shares && !this.shareLoading) {
        this.shareLoading = true;
        S.list().catch(e => { S.shares = S.shares || []; this.shareMsg = e.message; }).finally(() => { this.shareLoading = false; if (this.name === 'share') this.render('share', true); });
      }
    }
    this.body.innerHTML = h;
    const copy = async text => {
      try { await navigator.clipboard.writeText(text); app.toast('Link copied'); }
      catch { prompt('Copy the link:', text); }
    };
    const send = async text => {
      if (navigator.share) { try { await navigator.share({ title: document.title, text: 'View the model (view only):', url: text }); } catch { /* closed */ } }
      else copy(text);
    };
    this.body.onclick = async e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.days) { this.shareDays = +b.dataset.days; return this.render('share', true); }
      if (b.dataset.copy) return copy(S.links[b.dataset.copy]);
      if (b.dataset.revoke) {
        if (!confirm('Withdraw this link? The client can no longer open it, and its files are deleted.')) return;
        try { await S.revoke(b.dataset.revoke); S.shares = null; this.render('share', true); } catch (err) { say(err.message, true); }
        return;
      }
      const act = b.dataset.act;
      if (act === 'signin') {
        const code = this.body.querySelector('#shCode').value;
        if (code.length < 8) return say('At least 8 characters.', true);
        b.disabled = true;
        say('Checking...');
        try { await S.signIn(code); S.shares = null; this.render('share'); } catch (err) { b.disabled = false; say(err.message, true); }
      }
      if (act === 'create') {
        b.disabled = true;
        this.shareTitle = this.body.querySelector('#shTitle').value.trim();
        const notes = !!this.body.querySelector('[data-k=shNotes]')?.checked;
        try {
          const r = await S.create({ title: this.shareTitle || document.title, days: this.shareDays || 30, notes, order: app.chosenOrder?.() || null },
            (f, msg) => say(`${msg} ${Math.round(f * 100)}%`));
          this.shareLast = r.link;
          S.shares = null;
          this.render('share', true);
          send(r.link);
        } catch (err) { b.disabled = false; say(err.message, true); }
      }
      if (act === 'copylast') return copy(this.shareLast);
      if (act === 'sendlast') return send(this.shareLast);
      if (act === 'refresh') { S.shares = null; return this.render('share', true); }
      if (act === 'forget') { S.code = ''; S.shares = null; this.shareLast = null; return this.render('share'); }
    };
    this.body.onchange = e => { if (e.target.dataset.k === 'shNotes') this.shareNotes = e.target.checked; };
  }

  shareRows() {
    const S = this.app.share, list = S.shares;
    if (!list) return '<p class="note">Loading...</p>';
    if (!list.length) return '<p class="note">No links yet.</p>';
    const day = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    return list.map(s => {
      const gone = s.revoked ? 'withdrawn' : new Date(s.expires_at) < new Date() ? 'expired' : !s.ready ? 'unfinished' : '';
      return `<div class="row ${gone ? 'off' : ''}"><span class="nm">${esc(s.title)}<small>${gone || `until ${day(s.expires_at)}`} · opened ${s.views}× · ${(s.bytes / 1048576).toFixed(1)} MB</small></span>` +
        (!gone && S.links[s.id] ? `<button class="ib" data-copy="${esc(s.id)}" data-icon="share" title="Copy the link"></button>` : '') +
        (!gone ? `<button class="ib" data-revoke="${esc(s.id)}" data-icon="trash" title="Withdraw the link"></button>` : '') + '</div>';
    }).join('');
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
      if (k === 'edges') app.look.set('edges', e.target.checked);
      if (k === 'unit') { setUnit(e.target.value); app.onUnit(); }
      if (k === 'pr') { v.pixelRatio = +e.target.value; v.setPixelRatio(v.pixelRatio); }
      if (k === 'eye') app.walk.eye = +e.target.value || 1.6;
      if (k === 'shotScale') app.shotScale = +e.target.value;
    };
    this.body.onclick = async e => {
      const a = e.target.closest('button')?.dataset.act;
      if (a === 'showall') { app.history.record('Show everything'); v.showAll(); }
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
