// AI render of the current view, through SketchRender's two engines:
//  - PC: the RTX 3070 on the PC runs SketchRender's local engine (ComfyUI, SDXL + ControlNet), reached through
//    the Wi-Fi server (tools/serve.py). Free, about 30 s. Needs the PC on and the same Wi-Fi.
//  - Gemini: Google's Nano Banana image model, called straight from this device with Lucie's key. Works anywhere,
//    paid per image.
// The viewer makes the same pictures SketchRender takes from SketchUp: the view without edge lines, a black line
// drawing, a depth map (near dark, far light) and the same depth map without the ground (marks the empty sky).
import * as THREE from 'three';

export const PRESETS = [
  { id: 'daylight', name: 'Daylight', kind: 'exterior',
    text: 'Bright clear late-morning daylight. Soft blue sky with a few white clouds. Crisp natural shadows that follow the sun direction already in the image. Neat green lawn, simple planting, clean paving.',
    sd: 'exterior, bright clear late morning daylight, blue sky with a few white clouds, crisp sun shadows, neat green lawn, simple landscaping' },
  { id: 'myanmar', name: 'Myanmar tropical', kind: 'exterior',
    text: 'Set in a tropical suburb in Myanmar near Yangon. Lush garden with coconut palms, banana plants, bougainvillea and frangipani, green grass and a little red laterite soil. Warm strong sunlight, humid bright sky with tall white cumulus clouds, a light sheen on the paving after monsoon rain.',
    sd: 'exterior, tropical suburb in Myanmar, lush garden with coconut palms, banana plants, bougainvillea and frangipani, green grass, warm strong sunlight, humid bright sky with tall white cumulus clouds, wet paving after monsoon rain' },
  { id: 'dusk', name: 'Dusk', kind: 'exterior',
    text: 'Blue hour just after sunset. Deep blue sky with a warm orange glow low on the horizon. Warm interior lights glow through every window, exterior wall lights are on, soft reflections on glass and paving.',
    sd: 'exterior, blue hour after sunset, deep blue sky, warm orange glow on the horizon, warm interior lights glowing through the windows, exterior wall lights on, reflections' },
  { id: 'overcast', name: 'Overcast', kind: 'exterior',
    text: 'Soft overcast sky, even diffuse light, gentle soft shadows, muted natural colours, slightly damp ground.',
    sd: 'exterior, soft overcast sky, even diffuse light, soft shadows, muted natural colours, damp ground' },
  { id: 'interior_warm', name: 'Interior warm', kind: 'interior',
    text: 'Interior photograph. Warm late-afternoon sunlight through the windows, warm 3000K lamps switched on, realistic fabrics, timber and stone. Keep all furniture and fittings exactly where they are.',
    sd: 'interior photograph, warm late afternoon sunlight through the windows, warm lamps on, cosy, realistic fabric, timber and stone' },
  { id: 'interior_bright', name: 'Interior bright', kind: 'interior',
    text: 'Interior photograph. Bright soft daylight filling the room, white balanced colours, clean minimal styling, realistic materials. Keep all furniture and fittings exactly where they are.',
    sd: 'interior photograph, bright soft daylight, white balanced colours, clean minimal styling, realistic materials' },
  { id: 'clay', name: 'White clay model', kind: 'exterior',
    text: 'Render it as a white clay architectural model: every surface matte white, glass slightly tinted grey, soft studio daylight with gentle ambient occlusion and soft shadows, plain light grey background.',
    sd: 'white clay architectural scale model, all surfaces matte white, soft studio light, ambient occlusion, plain light grey background' },
];

const BASE = `Turn this 3D model screenshot into a photorealistic architectural photograph of the same building.
Keep the exact camera position, lens, perspective, framing and aspect ratio.
Keep every building element exactly where it is and at exactly the same size and shape:
walls, roofs, slabs, openings, doors, windows, columns, beams, stairs and railings.
Do not add, remove, move, resize or redesign any part of the building.
Turn the flat model colours and textures into real materials of the same colour and pattern
(painted render, concrete, brick, timber, glass, metal, roof sheets, tiles). Glass becomes real
glass with reflections and some view of the interior.
Remove edge lines, axes, sketchy outlines and the flat background and ground,
and replace them with a real setting as described below.`;
const LINES = `The second image is a line drawing of the exact same view. Use it as a strict guide:
every edge in the line drawing must stay in the same place in the photograph.`;
const FINISH = 'Shot on a full-frame camera, sharp focus, natural colour, high dynamic range. No text, no watermark, no added people.';
export const SD_NEGATIVE = 'cartoon, anime, illustration, painting, drawing, sketch, line art, outlines, cgi, video game, plastic, blurry, low resolution, noise, distorted, warped, deformed architecture, extra floors, text, watermark, logo, people';

const preset = id => PRESETS.find(p => p.id === id) || PRESETS[0];

export function geminiPrompt(id, extra) {
  const parts = [BASE, LINES, `Setting and light: ${preset(id).text}`];
  if (extra?.trim()) parts.push(`Extra instructions from the architect (follow these, they override the setting above): ${extra.trim()}`);
  parts.push(FINISH);
  return parts.join('\n');
}

export function sdPrompt(id, extra) {
  const lead = id === 'clay' ? 'architectural model photograph' : 'professional architectural photograph of a house';
  return [lead, extra?.trim() || null, preset(id).sd,
    'photorealistic, real materials, sharp focus, high detail, natural colours, shot on a full-frame camera'].filter(Boolean).join(', ');
}

export const GEMINI_MODELS = {
  'gemini-nano-banana-2.1': { name: 'Standard', price: { '1K': 0.034, '2K': 0.05, '4K': 0.113 } },
  'gemini-3-pro-image': { name: 'Best (Pro)', price: { '1K': 0.134, '2K': 0.134, '4K': 0.24 } },
};

// ---- capture --------------------------------------------------------------------

const DEPTH_VS = `#include <common>
#include <clipping_planes_pars_vertex>
varying float vDepth;
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  vDepth = -mvPosition.z;
  #include <clipping_planes_vertex>
}`;
const DEPTH_FS = `uniform float uNear;
uniform float uFar;
varying float vDepth;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  // near dark, far light, the model never pure white (pure white = no model, for the change mask)
  float g = clamp((vDepth - uNear) / max(uFar - uNear, 1e-3), 0.0, 1.0) * 0.94;
  gl_FragColor = vec4(vec3(g), 1.0);
}`;

// SDXL likes about 1 megapixel, both sides multiples of 8, in the screen's shape
export function sizeFor(aspect, pixels = 1024 * 1024) {
  const w = Math.round(Math.sqrt(pixels * aspect) / 8) * 8;
  return [w, Math.round(w / aspect / 8) * 8];
}

// the four pictures of the current camera, as data URLs, all in one go (nothing shows on screen)
export function capturePasses(v) {
  const r = v.renderer, cv = v.canvas, cam = v.camera, scene = v.scene;
  const [W, H] = sizeFor(cv.clientWidth / cv.clientHeight);
  // the AI needs real walls: See inside / X-ray would hand it a see-through house
  const mode = v.viewMode;
  if (mode !== 'solid') v.setViewMode('solid');
  const saved = { pr: r.getPixelRatio(), aspect: cam.aspect, view: cam.view ? { ...cam.view } : null, bg: scene.background,
    ground: v.ground.visible, surface: v.groundSurface.visible, surfaceMat: v.groundSurface.material,
    fog: scene.fog, contact: v.contact.plane.visible };
  const meshes = v.meshes.filter(m => m.visible);
  const mats = meshes.map(m => m.material);
  const lines = meshes.map(m => m.userData.line).filter(Boolean);
  const lineState = lines.map(l => [l.material, l.visible]);
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const black = new THREE.LineBasicMaterial({ color: 0x000000, toneMapped: false });
  const depth = new THREE.ShaderMaterial({ vertexShader: DEPTH_VS, fragmentShader: DEPTH_FS, side: THREE.DoubleSide,
    clipping: true, uniforms: { uNear: { value: 0.1 }, uFar: { value: 100 } } });
  const out = { width: W, height: H };
  try {
    r.setPixelRatio(1);
    r.setSize(W, H, false);
    cam.clearViewOffset();
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    v.applyTwoPoint();                // the same straight verticals as on screen
    cam.updateMatrixWorld();

    // 1. the view as it looks now, without edge lines
    for (const l of lines) l.visible = false;
    if (v.ao && v.composer && v.viewMode === 'solid') {
      v.composer.setPixelRatio(1);
      v.composer.setSize(W, H);
      v.composer.render();
    } else r.render(scene, cam);
    out.view = cv.toDataURL('image/png');
    out.viewJpeg = cv.toDataURL('image/jpeg', 0.92);

    // 2. black lines on white (no haze, no ground shadow in the guide pictures)
    scene.fog = null;
    v.contact.plane.visible = false;
    scene.background = new THREE.Color(0xffffff);
    v.ground.visible = v.groundSurface.visible = false;
    for (const m of meshes) m.material = white;
    for (const l of lines) { l.material = black; l.visible = true; }
    r.render(scene, cam);
    out.lines = cv.toDataURL('image/png');
    for (const l of lines) l.visible = false;

    // 3. depth between the nearest and farthest visible part, with a ground plane; 4. the same without it
    const box = v.visibleBox(), inv = cam.matrixWorldInverse;
    let near = Infinity, far = 0;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv);
      near = Math.min(near, -p.z);
      far = Math.max(far, -p.z);
    }
    depth.uniforms.uNear.value = Math.max(cam.near, near);
    depth.uniforms.uFar.value = Math.max(far, depth.uniforms.uNear.value + 1);
    for (const m of meshes) m.material = depth;
    v.groundSurface.material = depth;
    v.groundSurface.visible = true;
    r.render(scene, cam);
    out.depth = cv.toDataURL('image/png');
    v.groundSurface.visible = false;
    r.render(scene, cam);
    out.void = cv.toDataURL('image/png');
  } finally {
    meshes.forEach((m, i) => { m.material = mats[i]; });
    lines.forEach((l, i) => { [l.material, l.visible] = lineState[i]; });
    scene.background = saved.bg;
    scene.fog = saved.fog;
    v.contact.plane.visible = saved.contact;
    v.ground.visible = saved.ground;
    v.groundSurface.visible = saved.surface;
    v.groundSurface.material = saved.surfaceMat;
    white.dispose(); black.dispose(); depth.dispose();
    r.setPixelRatio(saved.pr);
    cam.aspect = saved.aspect;
    v.resize();                       // sizes, the composer and the panel offset come back
    if (mode !== 'solid') v.setViewMode(mode);
    v.render();
  }
  return out;
}

// ---- engines ----------------------------------------------------------------------

const LOCAL = /^(localhost|127\.|\[::1\])/;
// an https page may reach the PC on the Wi-Fi only with Chrome's local-network permission
const lanFetch = (url, init = {}) => {
  const host = new URL(url).hostname;
  const opts = location.protocol === 'https:' && url.startsWith('http:')
    ? { targetAddressSpace: LOCAL.test(host) ? 'loopback' : 'local' } : {};
  return fetch(url, { ...opts, ...init });
};

async function timed(promise, ms, msg) {
  let t;
  try { return await Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]); }
  finally { clearTimeout(t); }
}

export class PCEngine {
  constructor(store) { this.store = store; }

  // where the PC server is: this page itself when opened from the PC link, else the saved address, else this PC
  candidates() {
    const list = [];
    if (location.protocol === 'http:') list.push(location.origin);
    const pc = this.store.pc?.trim();
    if (pc) list.push(/^https?:\/\//.test(pc) ? pc.replace(/\/$/, '') : `http://${pc.includes(':') ? pc : pc + ':8765'}`);
    if (matchMedia('(hover: hover) and (pointer: fine)').matches) list.push('http://localhost:8765');
    return [...new Set(list)];
  }

  async find() {
    for (const base of this.candidates()) {
      try {
        const r = await timed(lanFetch(`${base}/ai/ping`), 3000, 'timeout');
        const j = await r.json();
        if (j.ok) { this.base = base; this.info = j; return j; }
      } catch { /* next */ }
    }
    this.base = null;
    return null;
  }

  async render(shot, opts, onStatus, signal) {
    if (!this.base && !await this.find()) throw new Error('The PC is not reachable. Start the Model Viewer Wi-Fi server on the PC and check the PC address in AI render settings.');
    if (!this.info.installed) throw new Error('SketchRender\'s local engine is not installed on the PC.');
    const body = JSON.stringify({ view: shot.view, depth: shot.depth, lines: shot.lines, void: shot.void,
      width: shot.width, height: shot.height, prompt: sdPrompt(opts.preset, opts.extra), negative: SD_NEGATIVE,
      freedom: opts.freedom, detail: opts.detail });
    onStatus('Sending the view to the PC...');
    const r = await lanFetch(`${this.base}/ai/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
    const { id, error } = await r.json();
    if (!id) throw new Error(error || 'The PC refused the render');
    this.job = id;
    for (;;) {
      await new Promise(res => setTimeout(res, 1500));
      if (signal?.aborted) { lanFetch(`${this.base}/ai/cancel?id=${id}`, { method: 'POST' }).catch(() => {}); throw new DOMException('Cancelled', 'AbortError'); }
      const s = await (await lanFetch(`${this.base}/ai/status?id=${id}`)).json();
      if (s.state === 'error') throw new Error(s.message);
      if (s.state === 'done') {
        const img = await lanFetch(`${this.base}/ai/image?id=${id}`);
        return { blob: await img.blob(), seconds: s.seconds };
      }
      onStatus(s.message);
    }
  }
}

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiEngine {
  constructor(store) { this.store = store; }

  get key() { try { return localStorage.getItem('mv:ai:key') || ''; } catch { return ''; } }
  set key(k) { try { if (k) localStorage.setItem('mv:ai:key', k); else localStorage.removeItem('mv:ai:key'); } catch { /* private mode */ } }

  async test(key = this.key) {
    const r = await fetch(`${GEMINI}/models?pageSize=1`, { headers: { 'x-goog-api-key': key } });
    if (!r.ok) throw new Error(await failure(r));
  }

  async render(shot, opts, onStatus, signal) {
    const key = this.key;
    if (!key) throw new Error('Add your Google API key in AI render settings first.');
    const input = [{ type: 'text', text: geminiPrompt(opts.preset, opts.extra) },
      { type: 'image', mime_type: 'image/jpeg', data: shot.viewJpeg.split(',')[1] },
      { type: 'image', mime_type: 'image/png', data: shot.lines.split(',')[1] }];
    const body = { model: opts.model, input, store: false, response_format: { type: 'image', image_size: opts.size } };
    const post = b => fetch(`${GEMINI}/interactions`, { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(b) });
    onStatus('Rendering with Gemini...');
    const t0 = performance.now();
    let r = await post(body);
    if (r.status === 400) {
      const txt = await r.clone().text();
      if (/response_format|image_size/i.test(txt)) { delete body.response_format; r = await post(body); }  // model refused the size option
    }
    if (!r.ok) throw new Error(await failure(r));
    const found = extract(await r.json());
    if (!found.data) throw new Error(found.text || 'The AI returned no image (it may have refused the prompt).');
    const bin = Uint8Array.from(atob(found.data), c => c.charCodeAt(0));
    return { blob: new Blob([bin], { type: found.mime }), seconds: Math.round((performance.now() - t0) / 1000), text: found.text };
  }
}

// the last image anywhere in the answer (Interactions API: steps[].content[]; generateContent: inlineData)
function extract(json) {
  let img = null;
  const texts = [];
  const walk = o => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    const inline = o.inlineData || o.inline_data;
    if (o.type === 'image' && typeof o.data === 'string') img = { data: o.data, mime: o.mime_type || 'image/png' };
    else if (inline?.data) img = { data: inline.data, mime: inline.mimeType || inline.mime_type || 'image/png' };
    else if (o.type === 'text' && typeof o.text === 'string') texts.push(o.text);
    Object.values(o).forEach(walk);
  };
  walk(json);
  return { ...(img || {}), text: texts.join(' ').trim() };
}

async function failure(r) {
  let j = null;
  try { j = await r.json(); } catch { /* not json */ }
  if (Array.isArray(j)) j = j[0];        // the Interactions API wraps errors in a list
  const msg = j?.error?.message || `HTTP ${r.status}`;
  const hint = r.status === 400 && /API key/i.test(msg) ? ' Check the API key.'
    : r.status === 401 || r.status === 403 ? ' Check the API key, and that billing is on for it.'
    : r.status === 429 ? ' Too many requests or out of quota. Wait a minute or check billing.' : '';
  return `Google error ${r.status}: ${msg}${hint}`;
}

// ---- the render flow, kept between panel openings -------------------------------------

const DEFAULTS = { engine: 'auto', preset: 'myanmar', extra: '', freedom: 'medium', detail: false,
  model: 'gemini-nano-banana-2.1', size: '2K', pc: '' };

export class AIRender {
  constructor(app) {
    this.app = app;
    this.v = app.viewer;
    try { this.store = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('mv:ai') || '{}') }; } catch { this.store = { ...DEFAULTS }; }
    this.pc = new PCEngine(this.store);
    this.gemini = new GeminiEngine(this.store);
    this.results = [];          // this session only: { blob, url, before, engine, preset, seconds }
    this.busy = false;
    this.status = '';
  }

  set(k, val) {
    this.store[k] = val;
    if (k === 'pc') this.pc.base = null;
    try { localStorage.setItem('mv:ai', JSON.stringify(this.store)); } catch { /* private mode */ }
  }

  setStatus(s) { this.status = s; this.onStatus?.(s); }

  // auto: the PC when it answers, else Gemini when there is a key
  async pickEngine() {
    const e = this.store.engine;
    if (e === 'pc' || e === 'gemini') return e;
    if (await this.pc.find()) return 'pc';
    if (this.gemini.key) return 'gemini';
    throw new Error('No AI engine available: the PC is not reachable and no Gemini key is set. Open AI render settings below.');
  }

  async render() {
    if (this.busy) return;
    this.busy = true;
    this.abort = new AbortController();
    try {
      this.setStatus('Looking for an engine...');
      const engine = await this.pickEngine();
      const shot = capturePasses(this.v);
      const S = this.store;
      const opts = { preset: S.preset, extra: S.extra, freedom: S.freedom, detail: S.detail, model: S.model, size: S.size };
      const res = await (engine === 'pc' ? this.pc : this.gemini).render(shot, opts, s => this.setStatus(s), this.abort.signal);
      const item = { ...res, url: URL.createObjectURL(res.blob), before: shot.viewJpeg, engine,
        preset: preset(S.preset).name, name: this.fileName(/png/.test(res.blob.type) ? 'png' : 'jpg') };
      this.results.unshift(item);
      this.setStatus(`Done in ${res.seconds ?? '?'} s (${engine === 'pc' ? 'PC' : 'Gemini'})`);
      this.onResult?.(item);
    } catch (e) {
      this.setStatus(e.name === 'AbortError' ? 'Cancelled' : e.message);
      if (e.name !== 'AbortError') throw e;
    } finally {
      this.busy = false;
      this.abort = null;
      this.onStatus?.(this.status);
    }
  }

  cancel() { this.abort?.abort(); }

  fileName(ext) {
    const stem = (this.v.modelName || 'model').replace(/\.(skp|glb|gltf|dae)$/i, '').replace(/[^\w.-]+/g, '_');
    const t = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
    return `${stem}_AI_${this.store.preset}_${t}.${ext}`;
  }
}
