// Opens .glb / .gltf (+ .bin + textures) and .dae (+ textures, optional .json sidecar with scenes).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';

export const MODEL_EXT = /\.(glb|gltf|dae)$/i;
const ZUP_TO_YUP = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

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
    const loaded = ext === 'dae' ? await loadDae(main, files, manager) : await loadGltf(main, ext, manager);
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

async function loadGltf(main, ext, manager) {
  const data = ext === 'glb' ? await main.blob.arrayBuffer() : await main.blob.text();
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
    srcFrame: () => (frameNode ? frameNode.matrixWorld.clone() : ZUP_TO_YUP.clone()),
  };
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
