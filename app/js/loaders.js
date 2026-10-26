// Opens .glb / .gltf (+ .bin + textures) and .dae (+ textures, optional .json sidecar with scenes).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';

export const MODEL_EXT = /\.(skp|glb|gltf|dae)$/i;
const ZUP_TO_YUP = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
const INCH_ZUP_TO_M_YUP = ZUP_TO_YUP.clone().multiply(new THREE.Matrix4().makeScale(0.0254, 0.0254, 0.0254));

// files: [{ name, blob }]
export async function loadFiles(files) {
  const main = files.find(f => MODEL_EXT.test(f.name));
  if (!main) throw new Error(`No .glb, .gltf or .dae file in: ${files.map(f => f.name).join(', ')}`);
  const urls = new Map();
  for (const f of files) if (f !== main) urls.set(f.name.toLowerCase(), URL.createObjectURL(f.blob));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    if (/^(data|blob):/.test(url)) return url;
    const base = decodeURIComponent(url.split(/[\\/]/).pop()).toLowerCase();
    return urls.get(base) || url;
  });
  const ext = main.name.split('.').pop().toLowerCase();
  try {
    const loaded = ext === 'dae' ? await loadDae(main, files, manager)
      : ext === 'skp' ? await loadSkp(main, manager)
      : await loadGltf(main, ext === 'glb' ? await main.blob.arrayBuffer() : await main.blob.text(), manager);
    for (const f of files) {
      if (!/\.json$/i.test(f.name)) continue;
      try {
        const j = JSON.parse(await f.blob.text());
        if (String(j.format || '').startsWith('mv-sequence')) loaded.sequence = j;
      } catch { /* not ours */ }
    }
    return loaded;
  } finally {
    setTimeout(() => urls.forEach(u => URL.revokeObjectURL(u)), 60000);   // textures may still be loading
  }
}

async function loadGltf(main, data, manager, srcFrame = null) {
  const gltf = await new GLTFLoader(manager).parseAsync(data, '');
  const json = gltf.parser.json, assoc = gltf.parser.associations;
  let frameNode = null;
  gltf.scene.traverse(o => {
    const a = assoc.get(o);
    if (a && a.nodes !== undefined) {
      o.userData._node = true;
      o.userData._name = json.nodes[a.nodes].name || '';   // GLTFLoader mangles names (spaces -> _)
    }
    if (o.userData.mv?.root) frameNode = o;
  });
  const meta = json.scenes?.[json.scene || 0]?.extras?.mv || null;
  const isEntity = o => !!o.userData._node;
  const groups = groupAll(gltf.scene, isEntity);
  return {
    name: main.name, kind: meta ? 'sketchup' : 'gltf', root: gltf.scene, meta, groups, isEntity,
    // SketchUp scene cameras are stored in model inches, Z up: the export's root node maps them
    srcFrame: () => (srcFrame ? srcFrame.clone() : frameNode ? frameNode.matrixWorld.clone() : ZUP_TO_YUP.clone()),
  };
}

// .skp read on the phone itself with openskp (open-source, reverse-engineered reader; loaded only
// when a .skp is opened). It converts to glTF; names, tags, attributes and scenes are copied into
// the same extras the SketchUp export button writes, so the rest of the app sees no difference.
async function loadSkp(main, manager) {
  const sk = await import('openskp');
  const file = sk.SkpFile.fromBuffer(await main.blob.arrayBuffer());
  const model = file.parse();
  const scene = file.buildInstancedScene();
  const glb = sk.toInstancedGLB(scene, { textures: true });
  const tag = n => (!n || n === 'Layer0' ? 'Untagged' : n);
  const title = main.name.replace(/\.skp$/i, '');
  const meta = {
    title, source: 'skp', file: main.name, sketchup: model.version,
    tags: model.layers.map(l => ({ name: tag(l.name), visible: !scene.layerHidden?.[l.name] && !l.hidden, color: [l.color.r, l.color.g, l.color.b] })),
    scenes: model.pages.filter(p => p.eye && p.target).map(p => ({
      name: p.name, eye: p.eye, target: p.target, up: p.up, persp: !p.parallel, fov: p.fov,
      hiddenTags: p.hiddenLayers.map(tag),
    })),
  };
  // the GLB's nodes are the scene hierarchy in depth-first order
  const flat = [];
  const walk = n => { flat.push(n); n.children.forEach(walk); };
  walk(scene.sceneHierarchy);
  const json = readGlbJson(glb);
  json.nodes.forEach((node, i) => {
    const h = flat[i];
    if (!h || h.name !== node.name) return;
    const attrs = {};
    for (const [d, kv] of Object.entries({ dynamic_attributes: h.properties, ...h.attributeDictionaries })) {
      for (const [k, v] of Object.entries(kv || {})) if (!k.startsWith('_') && String(v).length <= 160) attrs[`${d}: ${k}`] = v;
    }
    const mv = { name: h.name, tag: tag(h.layer), type: /^Group\d*$/.test(h.definitionName) ? 'group' : 'component' };
    if (mv.type === 'component') mv.def = h.definitionName;
    if (Object.keys(attrs).length) mv.attrs = attrs;
    node.extras = { mv };
  });
  json.scenes[json.scene || 0].extras = { mv: meta };
  const loaded = await loadGltf(main, writeGlbJson(glb, json), manager, INCH_ZUP_TO_M_YUP);
  loaded.kind = 'skp';
  return loaded;
}

function readGlbJson(glb) {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + dv.getUint32(12, true))));
}

// same GLB with a new JSON chunk (the binary chunk is copied as is)
function writeGlbJson(glb, json) {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const oldLen = dv.getUint32(12, true);
  const rest = glb.subarray(20 + oldLen);
  let text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - text.length % 4) % 4;
  const jsonChunk = new Uint8Array(text.length + pad).fill(0x20);
  jsonChunk.set(text);
  const out = new Uint8Array(20 + jsonChunk.length + rest.length);
  const o = new DataView(out.buffer);
  out.set(glb.subarray(0, 12));
  o.setUint32(8, out.length, true);
  o.setUint32(12, jsonChunk.length, true);
  o.setUint32(16, 0x4E4F534A, true);
  out.set(jsonChunk, 20);
  out.set(rest, 20 + jsonChunk.length);
  return out.buffer;
}

// Flat exports (one node per part) get groups back from the part names: consecutive siblings
// "Dining chair 1 seat", "Dining chair 1 leg"... become a group "Dining chair 1" that can be
// selected, moved and hidden as one. A differing number ("chair 1" / "chair 2") splits groups.
function commonPrefix(a, b) {
  const A = a.split(/\s+/), B = b.split(/\s+/);
  let n = 0;
  while (n < A.length && n < B.length && A[n] === B[n]) n++;
  if (n < 2 || (n === A.length && n === B.length)) return n >= 2 ? A.join(' ') : null;
  const pre = A.slice(0, n);
  if (!pre.some(t => /\d/.test(t)) && (/\d/.test(A[n] || '') || /\d/.test(B[n] || ''))) return null;
  return pre.join(' ').replace(/[\s:,;(\-–]+$/, '');
}

const nameOf = o => o.userData._name ?? o.name;

function groupRuns(parent, isEntity) {
  const kids = parent.children.filter(isEntity);
  if (kids.length < 3) return 0;
  let made = 0;
  for (let i = 0; i < kids.length;) {
    let j = i + 1, prefix = null;
    while (j < kids.length && nameOf(kids[i]) && nameOf(kids[j])) {
      const p = commonPrefix(prefix ?? nameOf(kids[i]), nameOf(kids[j]));
      if (!p || p.split(/\s+/).length < 2) break;
      prefix = p;
      j++;
    }
    if (j - i >= 2 && prefix && j - i < kids.length) {
      const g = new THREE.Group();
      g.name = prefix;
      g.userData = { auto: true, _node: true, _name: prefix, mv: { name: prefix, type: 'group (by name)' } };
      parent.children.splice(parent.children.indexOf(kids[i]), 0, g);
      g.parent = parent;
      for (let k = i; k < j; k++) g.attach(kids[k]);
      made++;
      i = j;
    } else i++;
  }
  return made;
}

function groupAll(root, isEntity) {
  const parents = [];
  root.traverse(o => { if (o.children.length >= 3 && !o.userData.auto) parents.push(o); });
  return parents.reduce((n, p) => n + groupRuns(p, isEntity), 0);
}

async function loadDae(main, files, manager) {
  const text = await main.blob.text();
  const collada = new ColladaLoader(manager).parse(text, '');
  if (!collada) throw new Error('Could not read this COLLADA file.');
  const root = collada.scene;
  let meta = null;
  const side = files.find(f => /\.json$/i.test(f.name));
  if (side) {
    try { meta = JSON.parse(await side.blob.text()); } catch { /* not a sidecar */ }
    if (meta && ((!meta.scenes && !meta.tags) || String(meta.format || '').startsWith('mv-sequence'))) meta = null;
  }
  root.updateMatrixWorld(true);
  const isEntity = o => o !== root && !!o.name;
  const groups = groupAll(root, isEntity);
  return {
    name: main.name, kind: 'collada', root, meta, groups, objectsUnderTags: true,
    isEntity: o => o !== root && !!o.name,
    srcFrame: () => root.matrixWorld.clone(),
  };
}
