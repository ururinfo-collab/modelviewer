// App shell: opening models, scene chips, tool bar, selection / move / measure / walk bars, gestures.
import * as THREE from 'three';
import { Viewer } from './viewer.js';
import { loadFiles, MODEL_EXT } from './loaders.js';
import { SectionTool, MeasureTool, WalkTool } from './tools.js';
import { MoveTool } from './transform.js';
import { Sequence } from './sequence.js';
import { History } from './history.js';
import { Look } from './look.js';
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
app.history = new History(app);
app.panels = new Panels(app);
app.look = new Look(app);
app.look.apply();
app.move.onBeforeChange = label => app.history.record(label);
app.move.onNoChange = () => app.history.dropLast();

// ---- toast + busy ------------------------------------------------------------

let toastTimer;
// action: optional { label, fn } shown as a button in the toast (e.g. Undo)
function toast(msg, ms = 2400, action = null) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('act', !!action);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { t.classList.remove('show'); action.fn(); };
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? Math.max(ms, 4500) : ms);
}

// ---- undo / redo -------------------------------------------------------------

function undo() {
  const label = app.history.undo();
  if (label) toast(`Undone: ${label}`);
}
function redo() {
  const label = app.history.redo();
  if (label) toast(`Redone: ${label}`);
}
app.undo = undo;
app.history.onChange = () => {
  $('#btnUndo').disabled = !app.history.canUndo;
  $('#btnRedo').disabled = !app.history.canRedo;
  $('#btnUndo').title = app.history.canUndo ? `Undo: ${app.history.undoStack.at(-1).label} (Ctrl+Z)` : 'Nothing to undo';
  $('#btnRedo').title = app.history.canRedo ? `Redo: ${app.history.redoStack.at(-1).label} (Ctrl+Y)` : 'Nothing to redo';
  updateBars();
  if (app.panels.name && app.panels.name !== 'section' && app.panels.name !== 'sun') app.panels.refresh();
};
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
const undoAction = { label: 'Undo', fn: undo };

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
    if (loaded.sequence) keepOrder(loaded.sequence);    // opened together with the model: keep it too
    app.move = resetMove();
    app.history.clear();
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
  if (viewer.isolated) chips.push(`<button class="chip warn" data-v="uniso">Exit isolate</button>`);
  const nHidden = hiddenCount();
  if (nHidden) chips.push(`<button class="chip warn" data-v="hidden">Hidden (${nHidden})</button>`);
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

// objects hidden one by one (Hide button, tree eye), not by tags or categories
function hiddenCount() {
  return viewer.ents.filter(E => E.hidden).length;
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
  if (s.hiddenTags || s.hidden) app.history.record(`Scene ${s.name}`);
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
  if (b.dataset.v === 'uniso') { app.history.record('Exit isolate'); viewer.isolate(null); return; }
  if (b.dataset.v === 'hidden') {
    app.panels.layersTab = 'hidden';
    if (app.panels.name === 'layers') app.panels.render('layers'); else togglePanel('layers');
    return;
  }
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
let shownHidden = 0;
viewer.addEventListener('visibility', () => {
  const has = !!$('#scenes [data-v=uniso]'), n = hiddenCount();
  if (has !== !!viewer.isolated || n !== shownHidden) { shownHidden = n; buildScenes(); }
});

// ---- rows that scroll sideways: also with a mouse (wheel, drag, arrows), not just a finger

function mouseScroll(el) {
  el.addEventListener('wheel', e => {
    const sideways = el.scrollWidth > el.clientWidth + 1;
    if (!sideways || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    el.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  let drag = null;
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button === 0) drag = { x: e.clientX, left: el.scrollLeft, moved: false };
  });
  addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 5) { drag.moved = true; el.classList.add('dragging'); }
    if (drag.moved) el.scrollLeft = drag.left - dx;
  });
  let draggedAt = 0;
  addEventListener('pointerup', () => {
    if (drag?.moved) draggedAt = performance.now();
    drag = null;
    el.classList.remove('dragging');
  });
  // the click that ends a drag is not a tap on a chip
  el.addEventListener('click', ev => {
    if (performance.now() - draggedAt < 250) { ev.stopPropagation(); ev.preventDefault(); }
  }, { capture: true });
}
mouseScroll($('#scenes'));
mouseScroll($('#tools'));
$$('.baracts').forEach(mouseScroll);

// arrows at the ends of the views row (computers; phones swipe)
function updateSceneArrows() {
  const s = $('#scenes'), max = s.scrollWidth - s.clientWidth;
  $('#scenesWrap [data-dir="-1"]').hidden = s.scrollLeft <= 2;
  $('#scenesWrap [data-dir="1"]').hidden = s.scrollLeft >= max - 2;
}
$('#scenes').addEventListener('scroll', updateSceneArrows);
addEventListener('resize', updateSceneArrows);
new MutationObserver(updateSceneArrows).observe($('#scenes'), { childList: true });
$$('#scenesWrap .sarrow').forEach(b => {
  b.onclick = () => { const s = $('#scenes'); s.scrollLeft += +b.dataset.dir * s.clientWidth * 0.8; };
});

$('#btnHome').onclick = () => { if (app.tool === 'walk') exitTools(); viewer.fitAll(); };

// ---- tool bar ----------------------------------------------------------------

function setToolButtons() {
  $$('#tools [data-tool]').forEach(b => {
    const t = b.dataset.tool;
    b.classList.toggle('on', app.panels.name === t || app.tool === t || (t === 'xray' && viewer.viewMode !== 'solid')
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
  if (app.tool === 'render') { clearInterval(renderTimer); app.photo.stop(); }
  app.tool = null;
  updateBars();
  setToolButtons();
}

function togglePanel(name) {
  $('#viewMenu').hidden = true;
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
  if (['layers', 'tree', 'section', 'sun', 'settings', 'look'].includes(t)) {
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
    app.seq.data = chosenOrder();
    app.seq.start();
    setTool('build');
    updateBuildBar();
    const s = app.seq;
    return toast(s.data ? `Build order from ${s.data.model || 'file'}: ${s.stages.length} stages${s.unmatched ? `, ${s.unmatched} new parts placed by type` : ''}`
                        : `Automatic build order: ${s.stages.length} stages`, 3200);
  }
  if (t === 'render') {
    if (app.tool === 'render') return exitTools();
    exitTools();
    app.panels.close();
    $('#viewMenu').hidden = true;
    return startRender();
  }
  if (t === 'xray') {
    const menu = $('#viewMenu');
    if (!menu.hidden) { menu.hidden = true; return; }
    return showViewMenu();
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
  $('#buildOrder').textContent = s.data ? 'Order: BL' : 'Order: auto';
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
  if (a === 'order') return showOrderMenu();
  if (a === 'done') exitTools();
  updateBuildBar();
};

// ---- photoreal render ------------------------------------------------------------

let renderTimer, renderMod;
async function startRender() {
  if (!app.photo) {
    busy('Loading the renderer', 0.3);
    try {
      renderMod = await import('./render.js');      // loaded only when first used
      app.photo = new renderMod.PhotoRender(app);
      app.photo.onStatus = msg => { if (msg) $('#renderStatus').textContent = msg; };
      app.photo.onDone = () => toast('Render finished. Save it, or move the view to render another.', 4000);
      app.photo.onBusy = on => (on ? busy('Preparing the scene for rendering (a few seconds)', 0.5) : busy(false));
    } catch (e) {
      busy(false);
      return alert(`Could not load the renderer: ${e.message}`);
    } finally { busy(false); }
  }
  setTool('render');
  buildRenderBar();
  renderTimer = setInterval(updateRenderStatus, 250);
  if (matchMedia('(hover: none)').matches) toast('Rendering works on phones but is much faster on a computer.', 4000);
  try { await app.photo.start(); } catch (e) { console.error(e); alert(`Render failed: ${e.message}`); exitTools(); }
}

function buildRenderBar() {
  const p = app.photo;
  const seg = (id, opts, cur, key) => {
    $(id).innerHTML = Object.entries(opts).map(([k, o]) =>
      `<button data-ro="${key}" data-val="${k}" class="${cur === k ? 'on' : ''}" title="${esc(o.note || '')}">${o.label}</button>`).join('');
  };
  seg('#renderLight', renderMod.LIGHTS, p.light, 'light');
  seg('#renderQuality', renderMod.QUALITY, p.quality, 'quality');
  seg('#renderSize', renderMod.SIZES, p.size, 'size');
}

function updateRenderStatus() {
  const p = app.photo;
  if (!p?.active) return;
  if (p.ready) {
    const n = Math.min(p.samples, p.target);
    $('#renderStatus').textContent = p.done ? `Done: ${p.target} samples` : `Rendering: ${n} / ${p.target} samples`;
    $('#renderProgress').style.width = `${Math.round(n / p.target * 100)}%`;
  }
}

$('#renderbar').onclick = async e => {
  const o = e.target.closest('[data-ro]');
  if (o) { app.photo.setOption(o.dataset.ro, o.dataset.val); return buildRenderBar(); }
  const a = e.target.closest('[data-rb]')?.dataset.rb;
  if (a === 'save') showSave($('#saveDlg'), await app.photo.save());
  if (a === 'done') exitTools();
};

// ---- see-through views: Solid / See inside / X-ray -------------------------------

const VIEW_LABEL = { solid: 'Solid', inside: 'See inside', xray: 'X-ray' };

function setViewMode(mode) {
  viewer.setViewMode(mode);
  $('[data-tool=xray] span').textContent = mode === 'solid' ? 'See-thru' : VIEW_LABEL[mode];
  setToolButtons();
}

function showViewMenu() {
  const m = viewer.viewMode, ghosts = viewer.ents.filter(E => E.ghost && !E.parent?.ghost).length;
  const item = (act, label, note) =>
    `<button data-vm="${act}" class="${m === act ? 'on' : ''}"><b>${m === act ? '✓ ' : ''}${label}</b><small>${note}</small></button>`;
  $('#viewMenu').innerHTML = '<div class="omtitle">See-through</div>' +
    item('solid', 'Solid', 'Everything as built') +
    item('inside', 'See inside', 'Walls, roof, ceilings, doors and windows see-through; furniture, fittings, pipes and stairs solid. Taps go through to what is inside') +
    item('xray', 'X-ray', 'Everything see-through; the selected object stays solid') +
    (ghosts ? `<button data-vm="clear"><b>Make ${ghosts} see-through object${ghosts > 1 ? 's' : ''} solid</b><small>Ones set with the See-thru button</small></button>` : '') +
    '<button data-vm="close"><b>Cancel</b></button>';
  $('#viewMenu').hidden = false;
}

$('#viewMenu').onclick = e => {
  const a = e.target.closest('[data-vm]')?.dataset.vm;
  if (!a) return;
  $('#viewMenu').hidden = true;
  if (VIEW_LABEL[a]) {
    setViewMode(a);
    if (a !== 'solid') toast(`${VIEW_LABEL[a]} view`);
  }
  if (a === 'clear') {
    app.history.record('Make all solid');
    for (const E of viewer.ents) E.ghost = false;
    viewer.refreshMaterials();
    updateBars();
  }
};

// Build orders loaded once stay on the phone and work for every revision (parts match by name).
// Each model remembers which order it uses ('auto' or an order's name).
const ORDERS_KEY = 'mv:orders';
function savedOrders() {
  try { return JSON.parse(localStorage.getItem(ORDERS_KEY)) || {}; } catch { return {}; }
}
function keepOrder(seq) {
  const name = seq.model || 'BuildLapse order';
  const all = savedOrders();
  all[name] = seq;
  try { localStorage.setItem(ORDERS_KEY, JSON.stringify(all)); } catch { toast('Phone storage full: the order is used now but not kept'); }
  return name;
}
app.keepOrder = keepOrder;

// which order Build starts with for the open model
function chosenOrder() {
  const pick = getSetting(viewer.modelName, 'order', null);
  if (pick === 'auto') return null;
  if (pick && savedOrders()[pick]) return savedOrders()[pick];
  if (app.loaded.sequence) return app.loaded.sequence;          // one opened with the model
  // a new revision: the saved order whose part names match at least a third of this model
  const names = new Set(viewer.ents.map(E => E.name));
  let best = null, bestShare = 0.33;
  for (const o of Object.values(savedOrders())) {
    const share = o.parts.filter(p => names.has(p[0])).length / Math.max(1, o.parts.length);
    if (share > bestShare) { best = o; bestShare = share; }
  }
  return best;
}

function useOrder(name) {
  const s = app.seq;
  setSetting(viewer.modelName, 'order', name);
  s.stop();
  s.data = name === 'auto' ? null : savedOrders()[name] || app.loaded.sequence;
  s.start();
  updateBuildBar();
  toast(s.data ? `BuildLapse order: ${s.stages.length} stages${s.unmatched ? `, ${s.unmatched} new parts placed by tag` : ''}`
               : `Automatic order from tags: ${s.stages.length} stages`, 3200);
}

// Order button: a small menu, so choosing the automatic order never opens a file picker
function showOrderMenu() {
  const menu = $('#orderMenu'), s = app.seq, orders = savedOrders();
  const cur = s.data ? (s.data.model || 'BuildLapse order') : 'auto';
  const item = (act, label, on, note = '') =>
    `<button data-om="${esc(act)}" class="${on ? 'on' : ''}"><b>${on ? '✓ ' : ''}${esc(label)}</b>${note ? `<small>${esc(note)}</small>` : ''}</button>`;
  let h = '<div class="omtitle">Build order</div>' + item('auto', 'Automatic', cur === 'auto', 'From the tags (S-FDN, A-WALL, P-WATER...), bottom up');
  for (const [name, o] of Object.entries(orders)) h += item(`o:${name}`, `BuildLapse: ${name}`, cur === name, `${o.stages.length} stages, saved on this phone`);
  if (s.data && !orders[cur]) h += item(`o:${cur}`, `BuildLapse: ${cur}`, true, `${s.data.stages.length} stages`);
  h += item('load', 'Load an order file...', false, '.sequence.json from BuildLapse; kept for next time');
  if (Object.keys(orders).length) h += item('forget', 'Remove saved orders', false);
  h += item('close', 'Cancel', false);
  menu.innerHTML = h;
  menu.hidden = false;
}

$('#orderMenu').onclick = e => {
  const a = e.target.closest('[data-om]')?.dataset.om;
  if (!a) return;
  $('#orderMenu').hidden = true;
  if (a === 'auto') useOrder('auto');
  if (a.startsWith('o:')) useOrder(a.slice(2));
  if (a === 'load') $('#orderFile').click();
  if (a === 'forget' && confirm('Remove the build orders saved on this phone?')) {
    try { localStorage.removeItem(ORDERS_KEY); } catch { /* private mode */ }
    if (app.seq.data && app.seq.data !== app.loaded.sequence) useOrder('auto');
  }
};

$('#orderFile').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (!String(j.format || '').startsWith('mv-sequence')) throw new Error('Not a build order file (.sequence.json)');
    useOrder(keepOrder(j));
  } catch (err) { alert(err.message); }
};

// ---- selection bar -----------------------------------------------------------

function updateBars() {
  const E = viewer.selected, t = app.tool;
  $('#selbar').hidden = !E || !!t;
  $('#movebar').hidden = t !== 'move';
  $('#measurebar').hidden = t !== 'measure';
  $('#buildbar').hidden = t !== 'build';
  $('#renderbar').hidden = t !== 'render';
  if (t) $('#viewMenu').hidden = true;
  if (t !== 'build') $('#orderMenu').hidden = true;
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
  if (a === 'hide') {
    app.history.record(`Hide ${E.name}`);
    viewer.setHidden(E, true);
    viewer.select(null);
    toast('Hidden. The Hidden button in the views row brings it back.', 4500, undoAction);
  }
  if (a === 'isolate') {
    app.history.record(viewer.isolated?.has(E) ? 'Exit isolate' : `Isolate ${E.name}`);
    if (viewer.isolated?.has(E)) viewer.isolate(null);
    else { viewer.isolate([E]); viewer.zoomTo(E); }
  }
  if (a === 'ghost') {
    app.history.record(`See-through ${E.name}`);
    viewer.setGhost(E, !E.ghost);
    updateBars();
  }
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
  if (a === 'undo') undo();
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
  if (a === 'collide') {
    w.collide = !w.collide;
    toast(w.free ? 'In See inside and X-ray nothing blocks you' : w.collide ? 'Walls block you' : 'Walk through walls');
  }
  if (a === 'exit') exitTools();
  $('.walkbtns [data-wk=collide]').classList.toggle('on', !w.collide || w.free);
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
      const h = viewer.pickFloor(x, y);
      if (h) {
        app.walk.place(h);
        $('#walkHint').hidden = true;
        toast(app.walk.free ? 'Left thumb: walk, drag elsewhere: look. Walls and furniture do not block you here.'
                            : 'Left thumb: walk. Drag elsewhere: look around.', 3500);
      }
    }
    return;
  }
  if (t === 'measure') return app.measure.onTap(x, y);
  if (t === 'build' || t === 'render') return;     // nothing to pick while these run
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
  if ((e.key === 'Delete' || e.key === 'h') && viewer.selected && !app.tool) {
    app.history.record(`Hide ${viewer.selected.name}`);
    viewer.setHidden(viewer.selected, true);
    viewer.select(null);
  }
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  if (e.key === 'f' && viewer.selected) viewer.zoomTo(viewer.selected);
});

// ---- keep the model centred in the free part of the screen -------------------

function updateInset() {
  const w = innerWidth, h = innerHeight;
  // the panel and the tool bars take screen room; the small selection bar does not count, so
  // selecting does not shift the view
  const blocks = ['#panel', '#buildbar', '#measurebar', '#movebar', '#renderbar'].map(s => $(s)).filter(el => !el.hidden);
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
for (const s of ['#panel', '#buildbar', '#measurebar', '#movebar', '#renderbar']) {
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
