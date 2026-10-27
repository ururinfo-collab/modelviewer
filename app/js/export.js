// Save what you see: a .glb 3D file with your colours and the plastered (joint-free) look built in, and a small
// look file for SketchUp, where Extensions › Flush joints › Save a clean copy turns it into a real .skp.
// (A web page cannot write .skp files: only SketchUp can.)
import * as THREE from 'three';
import { APP_VERSION } from './panels.js';

const METAL = /metal|steel|alu|chrome|inox|ss\b/i;
const safeName = s => (String(s || 'Model').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Model');

export class Exporter {
  constructor(app) {
    this.app = app;
    this.v = app.viewer;
  }

  get title() { return safeName(this.v.meta?.title || this.v.modelName || 'Model'); }

  // is this part drawn now (its own switch and every group above it)
  shown(o) {
    for (; o && o !== this.v.scene; o = o.parent) if (!o.visible) return false;
    return true;
  }

  // the paint a mesh shows now: its own colour, the wall's paint on a flush column, or its own material
  shownSrc(m) {
    return m.userData.colourSrc || (!this.v.showJoints && m.userData.paintSrc) || m.userData.src;
  }

  // ---- .glb ---------------------------------------------------------------------------------------------
  // Parts keep their names, tags and hierarchy, so the file opens in Model Viewer as a model of its own; the
  // edge lines are left out (any viewer draws its own), the gap strips and slab-edge skins go in.
  async glb(onProgress = () => {}) {
    const v = this.v;
    v.scene.updateMatrixWorld(true);
    const mats = new Map();
    const matOf = src => {
      if (Array.isArray(src)) return src.map(matOf);
      let m = mats.get(src);
      if (m) return m;
      const opacity = src.opacity ?? 1, glass = !!src.transparent || opacity < 0.999;
      m = new THREE.MeshStandardMaterial({
        name: src.name || '', color: src.color ? src.color.clone() : new THREE.Color(0xdddddd), map: src.map || null,
        transparent: glass, opacity, side: src.userData?.oneSided ? THREE.FrontSide : THREE.DoubleSide,
        roughness: glass ? 0.05 : METAL.test(src.name || '') ? 0.35 : 0.85, metalness: METAL.test(src.name || '') ? 0.6 : 0,
      });
      mats.set(src, m);
      return m;
    };
    // a scene, so title and tags go into the file's scene extras, where Model Viewer reads them back
    const out = new THREE.Scene();
    out.name = this.title;
    const tags = [...v.tags.values()].map(t => ({ name: t.name, visible: t.visible, color: t.color, folder: t.folder }));
    out.userData = { mv: { title: this.title, source: 'Model Viewer', tags, scenes: [] } };
    // the viewer keeps faces unshared (crisp creases); shared corners make the file about a third the size
    const { mergeVertices } = await import('three/addons/utils/BufferGeometryUtils.js');
    const geos = new Map();
    const geoOf = g => {
      let x = geos.get(g);
      if (!x) geos.set(g, x = g.index ? g : mergeVertices(g, 1e-5));
      return x;
    };
    const place = (node, obj) => obj.matrixWorld.decompose(node.position, node.quaternion, node.scale);
    const nodeOf = new Map([[v.rootEnt, out]]);
    let parts = 0;
    for (const E of v.ents) {
      if (E === v.rootEnt) continue;
      const parent = nodeOf.get(E.parent);
      if (!parent || !this.shown(E.obj)) continue;
      const g = new THREE.Group();
      g.name = E.name;
      g.userData = { mv: { name: E.name, tag: E.tag, ...(E.pid != null ? { pid: E.pid } : {}), ...(E.def ? { def: E.def } : {}) } };
      parent.add(g);
      nodeOf.set(E, g);
      for (const m of E.meshes) {
        if (!this.shown(m)) continue;
        // world placement, kept flat under the part's node (the node itself sits at the origin)
        const mesh = new THREE.Mesh(geoOf(m.geometry), matOf(this.shownSrc(m)));
        mesh.userData = { mvMesh: true };          // geometry of the part above, not a part of its own
        place(mesh, m);
        g.add(mesh);
        parts++;
        for (const extra of [m.userData.seal, ...(m.userData.skins || [])]) {
          if (!extra || !extra.visible) continue;
          const src = extra.userData.partner ? (extra.userData.partner.userData.paintSrc || [].concat(extra.userData.partner.userData.src)[0])
            : [].concat(this.shownSrc(m))[0];
          const x = new THREE.Mesh(geoOf(extra.geometry), matOf(src));
          x.userData = { mvMesh: true };
          place(x, extra);
          g.add(x);
        }
      }
    }
    if (!parts) throw new Error('Nothing is shown to save');
    onProgress(0.3);
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const res = await new GLTFExporter().parseAsync(out, { binary: true, onlyVisible: true, maxTextureSize: 2048 });
    for (const x of geos.values()) if (!v.meshes.some(m => m.geometry === x)) x.dispose();
    onProgress(1);
    return { blob: new Blob([res], { type: 'model/gltf-binary' }), name: `${this.title} (Model Viewer).glb`, parts };
  }

  // ---- look file for SketchUp -----------------------------------------------------------------------------
  // The colours you picked (by paint name, and by object: its path of names, and SketchUp's persistent id when
  // the model came through the SketchUp export) and whether the joint lines are hidden. Positions and moves are
  // not in it: SketchUp keeps the model as drawn.
  lookFile() {
    const v = this.v, C = this.app.colours;
    const materials = [];
    const seen = new Set();
    for (const m of v.meshes) {
      for (const s of [].concat(m.userData.src)) {
        if (seen.has(s) || !s.userData.origColor) continue;
        seen.add(s);
        const to = C.data.mats[C.matKey(s)];
        if (to) materials.push({ name: s.name || '', was: '#' + s.userData.origColor.getHexString(), to });
      }
    }
    const byKey = new Map(v.ents.map(E => [C.entKey(E), E]));
    const objects = Object.entries(C.data.objs).map(([path, to]) => {
      const E = byKey.get(path);
      return { path: path.split('/'), ...(E?.pid != null ? { pid: E.pid } : {}), to };
    });
    const look = {
      format: 'mv-look 1', app: `Model Viewer ${APP_VERSION}`, model: v.meta?.title || v.modelName || '',
      saved: new Date().toISOString(),
      joints: !v.showJoints,             // true: hide the lines between flush parts and paint flush parts
      flicker: true,
      colours: { materials, objects },
    };
    const text = JSON.stringify(look, null, 2);
    return {
      blob: new Blob([text], { type: 'application/json' }), name: `${this.title}.mvlook.json`,
      count: materials.length + objects.length,
    };
  }
}
