// App shell: opening models, scene chips, tool bar, selection / move / measure / walk bars, gestures.
import * as THREE from 'three';
import { Viewer } from './viewer.js';
import { loadFiles, MODEL_EXT } from './loaders.js';
import { SectionTool, MeasureTool, WalkTool } from './tools.js';
import { MoveTool } from './transform.js';
import { Sequence } from './sequence.js';
import { screenshot, Recorder, showSave } from './capture.js';
import { saveRecent, listRecent, getRecent, deleteRecent, getSetting, setSetting } from './store.js';
import { Panels, esc } from './panels.js';
import { icon } from './icons.js';
import { getUnit, setUnit } from './units.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const nextFrame = () => new Promise(r => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 100); });

function fillIcons(root = document) {
  const els = [...root.querySelectorAll('[data-icon]')];
  if (root.dataset?.icon) els.push(root);
  els.forEach(el => {
    const old = el.querySelector(':scope > svg');
    if (old && old.dataset.n === el.dataset.icon) return;
    old?.remove();
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
    el.querySelector(':scope > svg').dataset.n = el.dataset.icon;
  });
}
fillIcons();

const viewer = new Viewer($('#view'));
const app = window.app = {
  viewer, fillIcons, toast, tool: null, shotScale: 1,
  section: new SectionTool(viewer),
  measure: new MeasureTool(viewer, $('#labels')),
  walk: new WalkTool(viewer),
  move: new MoveTool(viewer),
  recorder: new Recorder(viewer),
  seq: new Sequence(viewer),
};
app.panels = new Panels(app);

// ---- toast + busy ------------------------------------------------------------

let toastTimer;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function busy(text, frac) {
  if (text === false) { $('#busy').hidden = true; return; }
  $('#busy').hidden = false;
  if (text) $('#busyText').textContent = text;
  $('#busyBar').style.width = `${Math.round((frac ?? 0) * 100)}%`;
}

// ---- opening models ----------------------------------------------------------

async function openFiles(files, keep = true) {
  files = files.filter(f => f && f.blob);
  const main = files.find(f => MODEL_EXT.test(f.name));
  if (!main) { toast('Pick a .skp, .glb, .gltf or .dae file'); return; }
  busy(/\.skp$/i.test(main.name) ? `Reading SketchUp file ${main.name} (a few seconds)` : `Opening ${main.name}`, 0.05);
  await nextFrame();
  try {
    const loaded = await loadFiles(files);
    busy('Preparing objects and edge lines', 0.1);
    await nextFrame();
    exitTools();
    app.panels.close();
    await viewer.setModel(loaded, f => busy(null, 0.1 + f * 0.9));
    app.loaded = loaded;
    app.useOrderFile = true;
    app.move = resetMove();
    $('#title').textContent = viewer.meta.title || main.name.replace(/\.[^.]+$/, '');
    document.title = $('#title').textContent;
    $('#welcome').hidden = true;
    app.section.set('off');
    app.measure.clear();
    app.panels.sunInit();
    buildScenes();
    if (keep) saveRecent([main, ...files.filter(f => f !== main)]);
    const nScenes = (viewer.meta.scenes || []).length;
    toast(`${viewer.ents.length - 1} objects · ${viewer.tags.size} tags${nScenes ? ` · ${nScenes} scenes` : ''}`);
  } catch (e) {
    console.error(e);
    alert(`Could not open ${main.name}:\n${e.message}`);
  } finally {
    busy(false);
  }
}

function resetMove() {
  app.move.stop();
  app.move.undoStack = [];
  app.move.original.clear();
  return app.move;
}

async function fetchModel(url, name) {
  busy(`Downloading ${name}`, 0);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const total = +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) busy(null, got / total);
  }
  return { name, blob: new Blob(parts) };
}

// a build order beside the model on the PC: <model>.sequence.json, else the only one there
async function fetchOrder(url) {
  const tryGet = async u => {
    const r = await fetch(u, { cache: 'no-store' });
    if (!r.ok) return null;
    return { name: decodeURIComponent(u.split('/').pop()), blob: await r.blob() };
  };
  try {
    const own = await tryGet(url.replace(/\.[^./?]+(\?.*)?$/, '.sequence.json'));
    if (own) return own;
    const r = await fetch('models/sequences.json', { cache: 'no-store' });
    const list = r.ok ? await r.json() : [];
    return list.length === 1 ? await tryGet(list[0].url) : null;
  } catch { return null; }
}

async function openUrl(url, name) {
  try {
    const f = await fetchModel(url, name || decodeURIComponent(url.split('/').pop().split('?')[0]));
    const order = await fetchOrder(url);
    await openFiles(order ? [f, order] : [f]);
  } catch (e) {
    busy(false);
    alert(`Could not download the model: ${e.message}`);
  }
}

const fileInput = $('#file');
fileInput.onchange = () => {
  const files = [...fileInput.files].map(f => ({ name: f.name, blob: f }));
  fileInput.value = '';
  openFiles(files);
};
$('#btnOpen').onclick = () => showWelcome();
$('#wOpen').onclick = () => fileInput.click();

addEventListener('dragover', e => { e.preventDefault(); $('#welcome').classList.add('drag'); });
addEventListener('dragleave', () => $('#welcome').classList.remove('drag'));
addEventListener('drop', e => {
  e.preventDefault();
  $('#welcome').classList.remove('drag');
  openFiles([...e.dataTransfer.files].map(f => ({ name: f.name, blob: f })));
});

const sizeMB = b => `${(b / 1048576).toFixed(1)} MB`;
const when = t => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function showWelcome() {
  $('#welcome').hidden = false;
  if (viewer.root) $('#welcome').onclick = e => { if (e.target.id === 'welcome') $('#welcome').hidden = true; };
  const recent = await listRecent();
  $('#wRecent').hidden = !recent.length;
  $('#recentList').innerHTML = recent.map(r => `<li><button class="go" data-name="${esc(r.name)}"><span class="nm">${esc(r.name)}</span>` +
    `<small>${sizeMB(r.size)} · ${when(r.date)}</small></button><button class="ib" data-del="${esc(r.name)}" data-icon="trash"></button></li>`).join('');
  fillIcons($('#recentList'));
  $('#recentList').onclick = async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.del) { await deleteRecent(b.dataset.del); return showWelcome(); }
    const r = await getRecent(b.dataset.name);
    if (r) openFiles(r.files);
  };
  // models the PC's Wi-Fi server offers (only when the app itself comes from that server)
  try {
    const res = await fetch('models/index.json', { cache: 'no-store' });
    if (!res.ok) throw 0;
    const list = await res.json();
    $('#wPC').hidden = !list.length;
    $('#pcList').innerHTML = list.map(m => `<li><button class="go" data-url="${esc(m.url)}" data-name="${esc(m.name)}"><span class="nm">${esc(m.name)}</span>` +
      `<small>${sizeMB(m.size)} · ${when(m.mtime * 1000)}</small></button></li>`).join('');
    $('#pcList').onclick = e => { const b = e.target.closest('button'); if (b) openUrl(b.dataset.url, b.dataset.name); };
  } catch { $('#wPC').hidden = true; }
}
app.showWelcome = showWelcome;

// Android: files shared to the installed app land in the service worker's cache
async function takeShared() {
  const cache = await caches.open('mv-share');
  const keys = await cache.keys();
  const files = [];
  for (const k of keys) {
    const res = await cache.match(k);
    files.push({ name: decodeURIComponent(k.url.split('/').pop()), blob: await res.blob() });
    await cache.delete(k);
  }
  return files;
}

// ---- scenes ------------------------------------------------------------------

function buildScenes() {
  const bar = $('#scenes');
  const chips = [];
  if (viewer.isolated) chips.push(`<button class="chip on" data-v="uniso">Exit isolate</button>`);
  for (const [k, n] of [['home', 'Home'], ['top', 'Top'], ['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right']]) {
    chips.push(`<button class="chip std" data-v="${k}">${n}</button>`);
  }
  const scenes = viewer.meta.scenes || [];
  if (scenes.length) chips.push('<span class="chip-sep"></span>');
  scenes.forEach((s, i) => chips.push(`<button class="chip" data-s="${i}">${esc(s.name)}</button>`));
  const mine = getSetting(viewer.modelName, 'views', []);
  if (mine.length) chips.push('<span class="chip-sep"></span>');
  mine.forEach((s, i) => chips.push(`<button class="chip" data-u="${i}">${esc(s.name)}</button>`));
  chips.push('<button class="chip add" data-v="add" title="Save this view">+ View</button>');
  bar.innerHTML = chips.join('');
}

const STD = { top: [0, 0, 1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0] };

function stdView(k) {
  if (k === 'home') return viewer.fitAll();
  const d = viewer.srcDir(STD[k]);
  if (k === 'top') d.add(viewer.srcDir([0, -0.002, 0])).normalize();
  viewer.fitBox(viewer.visibleBox(), d);
}

// SketchUp keeps the vertical field of view; on a narrow phone keep the scene's width instead
function fitFov(fov, srcAspect) {
  const a = viewer.camera.aspect, sa = srcAspect || 16 / 9;
  const h = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * sa);
  const need = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(h / 2) / a));
  return Math.min(80, Math.max(fov, need));      // wider than 80 degrees distorts too much
}

function applyScene(s) {
  if (s.useCamera !== false && s.eye) {
    const eye = viewer.srcPoint(s.eye), target = viewer.srcPoint(s.target);
    let fov = s.fov || 35;
    if (s.persp === false) fov = 20;
    viewer.flyTo(eye, target, fitFov(fov, s.aspect), 1.0);
  }
  if (s.hiddenTags) {
    const hidden = new Set(s.hiddenTags);
    for (const t of viewer.tags.values()) t.visible = !hidden.has(t.name);
  }
  if (s.hidden) {
    const hidden = new Set(s.hidden);
    for (const E of viewer.ents) if (E.pid != null) E.hidden = hidden.has(E.pid);
  }
  if (s.hiddenTags || s.hidden) { viewer.isolated = null; viewer.updateVisibility(); }
  if (s.shadow) {
    const S = app.panels.sunState;
    if (s.shadow.time) { S.date = s.shadow.time.slice(0, 10); S.minutes = +s.shadow.time.slice(11, 13) * 60 + +s.shadow.time.slice(14, 16); }
    if (s.shadow.on != null && s.shadow.on !== S.shadows) { S.shadows = s.shadow.on; viewer.setShadows(S.shadows); }
    app.panels.applySun(false);
    if (app.panels.name === 'sun') app.panels.render('sun');
  }
}

$('#scenes').onclick = e => {
  const b = e.target.closest('button');
  if (!b || !viewer.root) return;
  $$('#scenes .chip').forEach(c => c.classList.toggle('on', c === b && !b.dataset.v));
  if (app.tool === 'walk') exitTools();
  const views = getSetting(viewer.modelName, 'views', []);
  if (b.dataset.v === 'uniso') { viewer.isolate(null); return; }
  if (b.dataset.v === 'add') {
    const name = prompt('Name for this view', `View ${views.length + 1}`);
    if (!name) return;
    views.push({ name, pos: viewer.camera.position.toArray(), target: viewer.controls.target.toArray(), fov: viewer.camera.fov });
    setSetting(viewer.modelName, 'views', views);
    buildScenes();
    return toast('View saved. Press and hold it to delete.');
  }
  if (b.dataset.v) return stdView(b.dataset.v);
  if (b.dataset.s) return applyScene(viewer.meta.scenes[+b.dataset.s]);
  if (b.dataset.u) {
    const u = views[+b.dataset.u];
    viewer.flyTo(new THREE.Vector3().fromArray(u.pos), new THREE.Vector3().fromArray(u.target), u.fov);
  }
};

// press and hold a saved view to delete it
let holdTimer;
$('#scenes').addEventListener('pointerdown', e => {
  const b = e.target.closest('[data-u]');
  if (!b) return;
  holdTimer = setTimeout(() => {
    const views = getSetting(viewer.modelName, 'views', []);
    if (confirm(`Delete view "${views[+b.dataset.u].name}"?`)) {
      views.splice(+b.dataset.u, 1);
      setSetting(viewer.modelName, 'views', views);
      buildScenes();
    }
  }, 650);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(t => $('#scenes').addEventListener(t, () => clearTimeout(holdTimer)));
viewer.addEventListener('visibility', () => {
  const has = !!$('#scenes [data-v=uniso]');
  if (has !== !!viewer.isolated) buildScenes();
});

$('#btnHome').onclick = () => { if (app.tool === 'walk') exitTools(); viewer.fitAll(); };

// ---- tool bar ----------------------------------------------------------------

function setToolButtons() {
  $$('#tools [data-tool]').forEach(b => {
    const t = b.dataset.tool;
    b.classList.toggle('on', app.panels.name === t || app.tool === t || (t === 'xray' && viewer.xray)
      || (t === 'section' && app.section.mode !== 'off'));
    b.classList.toggle('rec', t === 'record' && app.recorder.active);
  });
}

function setTool(t) {
  app.tool = t;
  updateBars();
  setToolButtons();
}
app.setTool = setTool;

function exitTools() {
  if (app.tool === 'walk') { app.walk.exit(); document.body.classList.remove('walking'); $('#walkui').hidden = true; updateInset(); }
  if (app.tool === 'move') app.move.stop();
  if (app.tool === 'build') app.seq.stop();
  app.tool = null;
  updateBars();
  setToolButtons();
}

function togglePanel(name) {
  if (app.panels.name === name) app.panels.close();
  else app.panels.open(name);
  setToolButtons();
}

$('#panelClose').onclick = () => {
  if (app.tool === 'sectionPick') setTool(null);
  app.panels.close();
  setToolButtons();
};

$('#tools').onclick = async e => {
  const b = e.target.closest('[data-tool]');
  if (!b) return;
  const t = b.dataset.tool;
  if (!viewer.root && t !== 'settings') return toast('Open a model first');
  if (['layers', 'tree', 'section', 'sun', 'settings'].includes(t)) {
    if (app.tool === 'walk' || app.tool === 'measure' || app.tool === 'build') exitTools();
    return togglePanel(t);
  }
  if (t === 'measure') {
    if (app.tool === 'measure') return exitTools();
    exitTools();
    viewer.select(null);
    app.panels.close();
    setTool('measure');
    return toast('Tap two points to measure');
  }
  if (t === 'walk') {
    if (app.tool === 'walk') return exitTools();
    exitTools();
    viewer.select(null);
    app.panels.close();
    app.walk.enter();
    document.body.classList.add('walking');
    updateInset();
    $('#walkui').hidden = false;
    $('#walkHint').hidden = false;
    return setTool('walk');
  }
  if (t === 'build') {
    if (app.tool === 'build') return exitTools();
    exitTools();
    viewer.select(null);
    app.panels.close();
    app.seq.data = app.useOrderFile !== false ? app.loaded.sequence || null : null;
    app.seq.start();
    setTool('build');
    updateBuildBar();
    const s = app.seq;
    return toast(s.data ? `Build order from ${s.data.model || 'file'}: ${s.stages.length} stages${s.unmatched ? `, ${s.unmatched} new parts placed by type` : ''}`
                        : `Automatic build order: ${s.stages.length} stages`, 3200);
  }
  if (t === 'xray') {
    viewer.setXray(!viewer.xray);
    toast(viewer.xray ? 'X-ray on: everything see-through, the selection stays solid' : 'X-ray off');
    return setToolButtons();
  }
  if (t === 'shot') {
    const shot = await screenshot(viewer, app.shotScale);
    return showSave($('#saveDlg'), shot);
  }
  if (t === 'record') return toggleRecord();
};

// ---- recording ---------------------------------------------------------------

// captions burnt into the video: build stage, or the sun's date and time while the day plays
function recordOverlay() {
  if (app.tool === 'build' && app.seq.active) {
    const s = app.seq, st = s.stages[s.stageIndex] || {};
    return { title: `${s.stageIndex + 1}/${s.stages.length}  ${st.en || ''}`, line2: st.mm || '', progress: s.time };
  }
  if (app.panels.playing) {
    const S = app.panels.sunState, m = Math.round(S.minutes);
    const d = new Date(`${S.date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
    return { title: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, line2: d, progress: (S.minutes - 330) / (1140 - 330) };
  }
  return null;
}

let recTimer;
async function toggleRecord() {
  const r = app.recorder;
  if (r.active) {
    clearInterval(recTimer);
    $('#rec').hidden = true;
    const clip = await r.stop();
    setToolButtons();
    return showSave($('#saveDlg'), clip);
  }
  try { r.start(recordOverlay); } catch (e) { return alert(e.message); }
  $('#rec').hidden = false;
  recTimer = setInterval(() => {
    const s = Math.floor(r.seconds);
    $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
  setToolButtons();
  toast('Recording the 3D view. Tap stop when done.');
}
$('#recStop').onclick = toggleRecord;
app.toggleRecord = toggleRecord;

// ---- build (construction time-lapse) bar --------------------------------------

function updateBuildBar() {
  const s = app.seq;
  if (!s.active) return;
  const st = s.stages[s.stageIndex] || {};
  $('#buildStage').textContent = `${s.pos > 0 ? s.stageIndex + 1 : 0}/${s.stages.length} · ${s.pos > 0 ? st.en : 'Empty site'}`;
  $('#buildMM').textContent = s.pos > 0 ? st.mm || '' : '';
  if (!rangeHeld) $('#buildRange').value = Math.round(s.time * 1000);
  const play = $('#buildbar [data-bd=play]');
  if (play.dataset.icon !== (s.playing ? 'pause' : 'play')) {
    play.dataset.icon = s.playing ? 'pause' : 'play';
    play.querySelector('span').textContent = s.playing ? 'Pause' : 'Play';
    fillIcons(play);
  }
  $('#buildbar [data-bd=ghost]').classList.toggle('on', s.ghostRest);
  $('#buildbar [data-bd=orbit]').classList.toggle('on', s.orbit);
  $('#buildSpeed').textContent = `${s.duration} s`;
  $('#buildOrder').textContent = s.data ? 'BuildLapse' : 'Auto order';
}
app.seq.onChange = updateBuildBar;

// while a finger is on the slider the bar must not move it back
let rangeHeld = false;
$('#buildRange').addEventListener('pointerdown', () => { rangeHeld = true; });
['pointerup', 'pointercancel', 'change'].forEach(t => $('#buildRange').addEventListener(t, () => { rangeHeld = false; }));
$('#buildRange').oninput = e => {
  const t = e.target.value / 1000;     // read first: pausing refreshes the bar
  rangeHeld = true;
  app.seq.pause();
  app.seq.setTime(t, false);
};

$('#buildbar').onclick = e => {
  const a = e.target.closest('[data-bd]')?.dataset.bd, s = app.seq;
  if (!a) return;
  if (a === 'play') s.playing ? s.pause() : s.play();
  if (a === 'prev' || a === 'next') { s.pause(); s.jumpStage(a === 'next' ? 1 : -1); }
  if (a === 'ghost') s.setGhostRest(!s.ghostRest);
  if (a === 'orbit') { s.orbit = !s.orbit; viewer.controls.autoRotate = s.orbit && s.playing; }
  if (a === 'speed') {
    const opts = [20, 40, 60, 90, 120];
    s.duration = opts[(opts.indexOf(s.duration) + 1) % opts.length];
    viewer.controls.autoRotateSpeed = 60 / s.duration;
  }
  if (a === 'rec') {
    if (app.recorder.active) return toggleRecord();
    s.pause();
    s.setTime(0, false);
    toggleRecord();
    if (!app.recorder.active) return;
    s.onEnd = () => { s.onEnd = null; setTimeout(() => { if (app.recorder.active) toggleRecord(); }, 1500); };
    s.play();
  }
  if (a === 'order') {
    if (app.loaded.sequence) {
      app.useOrderFile = !s.data;
      s.stop();
      s.data = app.useOrderFile ? app.loaded.sequence : null;
      s.start();
      toast(s.data ? 'BuildLapse order' : 'Automatic order (by object type, bottom up)');
    } else $('#orderFile').click();
  }
  if (a === 'done') exitTools();
  updateBuildBar();
};

$('#orderFile').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (!String(j.format || '').startsWith('mv-sequence')) throw new Error('Not a build order file (.sequence.json)');
    app.loaded.sequence = j;
    app.useOrderFile = true;
    app.seq.stop();
    app.seq.data = j;
    app.seq.start();
    updateBuildBar();
    toast(`Build order loaded: ${j.stages.length} stages`);
  } catch (err) { alert(err.message); }
};

// ---- selection bar -----------------------------------------------------------

function updateBars() {
  const E = viewer.selected, t = app.tool;
  $('#selbar').hidden = !E || !!t;
  $('#movebar').hidden = t !== 'move';
  $('#measurebar').hidden = t !== 'measure';
  $('#buildbar').hidden = t !== 'build';
  if (E) $('#selName').textContent = E.name;
  if (E) {
    $('#selUp').style.visibility = E.parent && E.parent !== viewer.rootEnt && E.parent !== viewer.top ? 'visible' : 'hidden';
    const hidden = $('#selbar [data-sel=isolate]');
    hidden.classList.toggle('on', !!viewer.isolated?.has(E));
    $('#selbar [data-sel=ghost]').classList.toggle('on', E.ghost);
  }
  if (t === 'move') {
    const m = app.move;
    $('#moveName').textContent = `${m.E?.name || ''}${m.undoStack.length ? ` · ${m.undoStack.length} change${m.undoStack.length > 1 ? 's' : ''}` : ''}`;
    $('#movebar [data-mv=translate]').classList.toggle('on', m.mode === 'translate');
    $('#movebar [data-mv=rotate]').classList.toggle('on', m.mode === 'rotate');
    $('#movebar [data-mv=free]').classList.toggle('on', !m.horizontal);
    $('#movebar [data-mv=snap]').classList.toggle('on', m.snap);
  }
  $('#unitLabel').textContent = { m: 'm', mm: 'mm', ft: 'ft-in' }[getUnit()];
}
viewer.addEventListener('select', updateBars);
viewer.addEventListener('visibility', updateBars);

$('#selUp').onclick = () => {
  const E = viewer.selected;
  if (E?.parent && E.parent !== viewer.rootEnt && E.parent !== viewer.top) viewer.select(E.parent);
};

$('#selbar').onclick = e => {
  const a = e.target.closest('[data-sel]')?.dataset.sel, E = viewer.selected;
  if (!a || !E) return;
  if (a === 'info') { app.panels.open('info'); setToolButtons(); }
  if (a === 'zoom') viewer.zoomTo(E);
  if (a === 'hide') { viewer.setHidden(E, true); viewer.select(null); toast('Hidden. Layers › Show all brings it back.'); }
  if (a === 'isolate') {
    if (viewer.isolated?.has(E)) viewer.isolate(null);
    else { viewer.isolate([E]); viewer.zoomTo(E); }
  }
  if (a === 'ghost') { viewer.setGhost(E, !E.ghost); updateBars(); }
  if (a === 'move') { app.panels.close(); setTool('move'); app.move.start(E); updateBars(); toast('Drag the arrows. Rotate and Up/down below.'); }
  if (a === 'close') viewer.select(null);
};

app.move.onChange = () => { updateBars(); if (app.panels.name === 'info') app.panels.render('info'); };
$('#movebar').onclick = e => {
  const a = e.target.closest('[data-mv]')?.dataset.mv, m = app.move;
  if (!a) return;
  if (a === 'translate' || a === 'rotate') { m.mode = a; m.applySettings(); }
  if (a === 'free') { m.horizontal = !m.horizontal; m.applySettings(); }
  if (a === 'snap') { m.snap = !m.snap; m.applySettings(); toast(m.snap ? 'Snap: 5 cm and 15°' : 'Snap off'); }
  if (a === 'undo') m.undo();
  if (a === 'reset' && m.E) m.reset(m.E);
  if (a === 'done') exitTools();
  updateBars();
};

app.measure.onChange = () => {
  $('#measureHint').textContent = app.measure.pending ? 'Now tap the second point' : `${app.measure.items.length} measured. Tap two more points.`;
};
$('#measurebar').onclick = e => {
  const a = e.target.closest('[data-ms]')?.dataset.ms;
  if (a === 'undo') app.measure.undo();
  if (a === 'clear') app.measure.clear();
  if (a === 'unit') {
    const order = ['m', 'mm', 'ft'];
    setUnit(order[(order.indexOf(getUnit()) + 1) % 3]);
    app.onUnit();
  }
  if (a === 'done') exitTools();
};
app.onUnit = () => { app.measure.relabel(); updateBars(); if (app.panels.name) app.panels.refresh(); };

// ---- walk controls -----------------------------------------------------------

const joy = $('#joy'), knob = $('#joyKnob');
let joyId = null;
joy.addEventListener('pointerdown', e => { joyId = e.pointerId; joy.setPointerCapture(e.pointerId); moveJoy(e); });
joy.addEventListener('pointermove', e => { if (e.pointerId === joyId) moveJoy(e); });
const endJoy = e => {
  if (e.pointerId !== joyId) return;
  joyId = null;
  knob.style.transform = '';
  app.walk.move.set(0, 0);
};
joy.addEventListener('pointerup', endJoy);
joy.addEventListener('pointercancel', endJoy);
function moveJoy(e) {
  const r = joy.getBoundingClientRect(), R = r.width / 2 - 10;
  let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const d = Math.hypot(dx, dy);
  if (d > R) { dx *= R / d; dy *= R / d; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  app.walk.move.set(dx / R, -dy / R);
}

$('.walkbtns').addEventListener('pointerdown', e => {
  const b = e.target.closest('[data-wk]');
  if (!b) return;
  const a = b.dataset.wk, w = app.walk;
  if (a === 'up') w.vert = 1;
  if (a === 'down') w.vert = -1;
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(t => $('.walkbtns').addEventListener(t, () => { app.walk.vert = 0; }));
$('.walkbtns').onclick = e => {
  const b = e.target.closest('[data-wk]');
  if (!b) return;
  const a = b.dataset.wk, w = app.walk;
  if (a === 'fly') {
    w.fly = !w.fly;
    b.classList.toggle('on', w.fly);
    $$('.walkbtns [data-wk=up], .walkbtns [data-wk=down]').forEach(x => { x.hidden = !w.fly; });
  }
  if (a === 'collide') { w.collide = !w.collide; toast(w.collide ? 'Walls block you' : 'Walk through walls'); }
  if (a === 'exit') exitTools();
  $('.walkbtns [data-wk=collide]').classList.toggle('on', !w.collide);
};

// ---- gestures on the 3D view -------------------------------------------------

const canvas = viewer.canvas;
const ptrs = new Map();
let gesture = null, lastTap = null;

canvas.addEventListener('pointerdown', e => {
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) gesture = { x: e.clientX, y: e.clientY, t: performance.now(), multi: false };
  else if (gesture) gesture.multi = true;
});

canvas.addEventListener('pointermove', e => {
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  if (app.tool === 'walk' && app.walk.placed) app.walk.look(e.clientX - p.x, e.clientY - p.y);
  p.x = e.clientX;
  p.y = e.clientY;
});

const endPtr = e => {
  if (!ptrs.delete(e.pointerId)) return;
  const g = gesture;
  if (!ptrs.size) gesture = null;
  if (!g || g.multi || ptrs.size || e.type === 'pointercancel') return;
  if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < 10 && performance.now() - g.t < 450) onTap(e.clientX, e.clientY);
};
canvas.addEventListener('pointerup', endPtr);
canvas.addEventListener('pointercancel', endPtr);

function onTap(x, y) {
  if (!viewer.root) return;
  if (app.move.usedGizmo) { app.move.usedGizmo = false; return; }
  const t = app.tool;
  if (t === 'walk') {
    if (!app.walk.placed) {
      const h = viewer.pick(x, y);
      if (h) { app.walk.place(h); $('#walkHint').hidden = true; toast('Left thumb: walk. Drag elsewhere: look around.'); }
    }
    return;
  }
  if (t === 'measure') return app.measure.onTap(x, y);
  if (t === 'build') return;           // the build plays; nothing to pick
  if (t === 'sectionPick') {
    const h = viewer.pick(x, y);
    if (h) { app.section.set('face', h); setTool(null); if (app.panels.name === 'section') app.panels.render('section'); }
    return;
  }
  const h = viewer.pick(x, y);
  const now = performance.now();
  if (lastTap && now - lastTap.t < 350 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) {
    lastTap = null;
    if (h) {        // double tap: orbit around that point and move in a little
      const cam = viewer.camera.position;
      viewer.flyTo(h.point.clone().add(cam.clone().sub(h.point).multiplyScalar(0.7)), h.point, null, 0.5);
    }
    return;
  }
  lastTap = { t: now, x, y };
  let E = null;
  if (h) {
    const chain = viewer.chain(h.object.userData.owner);
    const i = chain.indexOf(viewer.selected);
    E = i < 0 ? chain[0] : chain[Math.min(i + 1, chain.length - 1)];
  }
  if (t === 'move') {
    if (E && E !== app.move.E) { viewer.select(E); app.move.start(E); updateBars(); }
    return;
  }
  viewer.select(E);
}

addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'Escape') { if (app.tool) exitTools(); else viewer.select(null); }
  if ((e.key === 'Delete' || e.key === 'h') && viewer.selected && !app.tool) { viewer.setHidden(viewer.selected, true); viewer.select(null); }
  if (e.key === 'z' && (e.ctrlKey || e.metaKey) && app.tool === 'move') app.move.undo();
  if (e.key === 'f' && viewer.selected) viewer.zoomTo(viewer.selected);
});

// ---- keep the model centred in the free part of the screen -------------------

function updateInset() {
  const w = innerWidth, h = innerHeight;
  // the panel and the tool bars take screen room; the small selection bar does not count, so
  // selecting does not shift the view
  const blocks = ['#panel', '#buildbar', '#measurebar', '#movebar'].map(s => $(s)).filter(el => !el.hidden);
  if (document.body.classList.contains('walking')) viewer.setInset(0, 0);
  else if (matchMedia('(orientation: landscape)').matches) {
    const left = $('#tools').getBoundingClientRect().right;
    const right = blocks.length ? w - Math.min(...blocks.map(el => el.getBoundingClientRect().left)) + 8 : 0;
    viewer.setInset(Math.round((right - left) / 2), 0);
  } else {
    const top = $('#scenes').getBoundingClientRect().bottom;
    const bottom = h - (blocks.length ? Math.min(...blocks.map(el => el.getBoundingClientRect().top)) : $('#tools').getBoundingClientRect().top);
    viewer.setInset(0, Math.round((bottom - top) / 2));
  }
}
new ResizeObserver(updateInset).observe($('#dock'));
for (const s of ['#panel', '#buildbar', '#measurebar', '#movebar']) {
  new MutationObserver(updateInset).observe($(s), { attributes: true, attributeFilter: ['hidden'] });
}
addEventListener('resize', updateInset);
document.body.addEventListener('transitionend', updateInset);

// ---- start -------------------------------------------------------------------

const local = ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && isSecureContext && !local) {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('No offline mode:', err));
  // a new version took over: reload once so it is in use now, not on the next launch
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const idle = !viewer.root && $('#busy').hidden && !location.search;   // never while a model is opening
      if (idle) location.reload(); else toast('App updated. Reopen it to use the new version.', 5000);
    });
  }
}

// "Open with Viewer" from a file manager (installed app, where the browser supports file handling)
let launched = false;
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async params => {
    if (!params.files?.length) return;
    launched = true;
    const files = await Promise.all(params.files.map(async h => { const f = await h.getFile(); return { name: f.name, blob: f }; }));
    openFiles(files);
  });
}

(async () => {
  const q = new URLSearchParams(location.search);
  if (q.has('shared')) {
    history.replaceState(null, '', location.pathname);
    const files = await takeShared().catch(() => []);
    if (files.length) return openFiles(files);
  }
  if (q.get('model')) return openUrl(q.get('model'));
  if (!launched) showWelcome();
})();
