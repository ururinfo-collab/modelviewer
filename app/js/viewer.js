// The 3D view: renderer, camera + touch orbit, lights, the loaded model and its object index,
// visibility (tags, categories, hide, isolate), materials (X-ray, ghost, selection), picking.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { categorize } from './categories.js';

const CREASE = THREE.MathUtils.degToRad(40);   // same 40 degrees BuildLapse uses for edge lines
const BG = 0xeef0f2;
// lets the progress bar paint; unlike setTimeout it is not slowed to 1/s in a background tab
const yieldToBrowser = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Viewer extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    r.setPixelRatio(this.pixelRatio);
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 5000);
    this.camera.position.set(20, 15, 20);

    const c = this.controls = new OrbitControls(this.camera, canvas);
    c.enableDamping = true;
    c.dampingFactor = 0.15;
    c.screenSpacePanning = true;
    c.rotateSpeed = 0.8;
    c.zoomToCursor = true;
    c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    c.addEventListener('change', () => this.requestRender());

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x9aa0a8, 1.9);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.sunDir = new THREE.Vector3(0.45, 0.8, 0.35).normalize();

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.22 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.visible = false;
    this.ground.raycast = () => {};
    this.scene.add(this.ground);

    this.edgeMat = new THREE.LineBasicMaterial({ color: 0x2c3238, transparent: true, opacity: 0.6, depthWrite: false });
    this.secUniforms = { uSecOn: { value: 0 }, uSecColor: { value: new THREE.Color(0xb8483f) } };
    this.mats = new Map();
    this.clipPlanes = [];
    this.tickers = new Set();
    this.afterRender = new Set();
    this.continuous = 0;
    this.needsRender = true;
    this.xray = false;
    this.ghostOpacity = 0.14;
    this.edges = true;
    this.shadows = false;
    this.selected = null;
    this.selSet = new Set();
    this.isolated = null;
    this.ents = [];
    this.meshes = [];
    this.pickables = [];
    this.raycaster = new THREE.Raycaster();
    this.clock = new THREE.Clock();

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    r.setAnimationLoop(() => this.frame());
  }

  requestRender() { this.needsRender = true; }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.applyInset();
  }

  // Keep the model centred in the part of the screen the panels leave free (pixels to shift).
  setInset(x, y) {
    const from = { ...(this.inset || { x: 0, y: 0 }) }, to = { x, y };
    if (Math.abs(from.x - x) < 1 && Math.abs(from.y - y) < 1) return;
    let t = 0;
    this.tickers.delete(this._inset);
    this._inset = dt => {
      t = Math.min(1, t + dt / 0.25);
      this.inset = { x: from.x + (to.x - from.x) * ease(t), y: from.y + (to.y - from.y) * ease(t) };
      this.applyInset();
      if (t >= 1) this.tickers.delete(this._inset);
    };
    this.tickers.add(this._inset);
  }

  applyInset() {
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    const i = this.inset || { x: 0, y: 0 };
    if (i.x || i.y) this.camera.setViewOffset(w, h, i.x, i.y, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    for (const t of [...this.tickers]) t(dt);
    if (this.controls.enabled) this.controls.update(dt);
    if (this.needsRender || this.tickers.size || this.continuous > 0) {
      this.needsRender = false;
      this.render();
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
    for (const f of this.afterRender) f();
  }

  // ---- model -------------------------------------------------------------

  async setModel(loaded, onProgress = () => {}) {
    this.clearModel();
    const { root, isEntity, meta } = loaded;
    this.meta = meta || {};
    this.modelName = loaded.name;
    this.objectsUnderTags = !!loaded.objectsUnderTags;
    this.root = root;
    root.traverse(o => { o.userData._ent = isEntity(o); });
    this.splitMeshParents(root);
    this.scene.add(root);
    root.updateMatrixWorld(true);
    this.srcFrame = loaded.srcFrame ? loaded.srcFrame() : new THREE.Matrix4();

    this.buildEntities(root, loaded.name);
    await this.prepareGeometry(onProgress);
    for (const m of this.meshes) this.applyMaterial(m);

    this.box = new THREE.Box3();
    for (const m of this.meshes) this.box.expandByObject(m);
    if (this.box.isEmpty()) this.box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    this.sphere = this.box.getBoundingSphere(new THREE.Sphere());
    const R = this.sphere.radius;
    this.camera.near = Math.max(0.01, R / 4000);
    this.camera.far = R * 40;
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = R * 12;
    const gy = THREE.MathUtils.clamp(0, this.box.min.y, this.box.max.y);
    this.ground.position.set(this.sphere.center.x, gy - 0.005, this.sphere.center.z);
    this.ground.scale.setScalar(R * 6);
    this.setSunDir(this.sunDir);
    this.updateVisibility();
    this.fitAll(false);
    this.dispatchEvent(new Event('model'));
  }

  clearModel() {
    if (!this.root) return;
    this.select(null);
    this.scene.remove(this.root);
    const geos = new Set();
    this.root.traverse(o => { if (o.geometry) geos.add(o.geometry); });
    geos.forEach(g => g.dispose());
    for (const v of this.mats.values()) for (const m of Object.values(v)) { m.map?.dispose(); m.dispose(); }
    this.mats.clear();
    this.root = null;
    this.ents = [];
    this.meshes = [];
    this.pickables = [];
    this.isolated = null;
  }

  // A mesh that also has child objects becomes a group holding the mesh, so its own faces can be
  // hidden (isolate, categories) without hiding everything inside it.
  splitMeshParents(root) {
    const fix = [];
    root.traverse(o => { if (o.isMesh && o.children.length) fix.push(o); });
    for (const m of fix) {
      const g = new THREE.Group();
      g.name = m.name;
      g.userData = m.userData;
      m.userData = {};
      g.position.copy(m.position); g.quaternion.copy(m.quaternion); g.scale.copy(m.scale);
      const p = m.parent;
      p.children[p.children.indexOf(m)] = g;
      g.parent = p;
      m.parent = null;
      while (m.children.length) g.add(m.children[0]);
      m.position.set(0, 0, 0); m.quaternion.identity(); m.scale.set(1, 1, 1);
      g.add(m);
    }
  }

  buildEntities(root, fileName) {
    const mkEnt = (obj, parent) => {
      const mv = obj.userData.mv || {};
      const E = {
        id: this.ents.length, obj, parent, children: [], meshes: [],
        name: mv.name || obj.userData._name || obj.name || mv.def || 'Object',
        tag: mv.tag ?? null, def: mv.def || '', type: mv.type || '', pid: mv.pid,
        attrs: mv.attrs || null, volume: mv.vol, material: mv.mat || '',
        hidden: !!mv.hidden, ghost: false, cat: null, shown: true,
      };
      this.ents.push(E);
      return E;
    };
    const rootEnt = mkEnt(root, null);
    rootEnt.name = this.meta.title || fileName;
    const walk = (obj, E) => {
      if (obj !== root && obj.userData._ent) {
        const child = mkEnt(obj, E);
        E.children.push(child);
        E = child;
      }
      obj.userData.ent = obj.userData._ent ? E : obj.userData.ent;
      if (obj.isMesh) {
        obj.userData.owner = E;
        obj.userData.src = obj.material;
        E.meshes.push(obj);
        this.meshes.push(obj);
      }
      for (const ch of obj.children) walk(ch, E);
    };
    walk(root, rootEnt);
    this.rootEnt = rootEnt;
    let top = rootEnt;
    while (top.children.length === 1 && top.meshes.length === 0) top = top.children[0];
    this.top = top;

    // Tags: from the SketchUp export, else the first level under the model (COLLADA categories)
    const metaTags = new Map((this.meta.tags || []).map(t => [t.name, t]));
    this.tags = new Map();
    // no tag of its own (COLLADA, name groups): the parent's, or at the top level its own name
    const tagOf = E => {
      if (E.tag != null) return E.tag;
      if (E.parent === top) return E.name;
      if (!E.parent || E.parent === rootEnt || E === top) return 'Untagged';
      return E.parent.tag;
    };
    for (const E of this.ents) {           // parents come before children
      if (E === rootEnt) continue;
      E.tag = tagOf(E) || 'Untagged';
      if (!this.tags.has(E.tag)) {
        const mt = metaTags.get(E.tag);
        this.tags.set(E.tag, { name: E.tag, visible: mt ? mt.visible !== false : true, color: mt?.color, folder: mt?.folder || '', count: 0 });
      }
      this.tags.get(E.tag).count++;
    }
    // keep the SketchUp tag order, then the rest alphabetically
    const order = [...metaTags.keys()];
    this.tags = new Map([...this.tags].sort((a, b) => {
      const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
      return a[0].localeCompare(b[0], undefined, { numeric: true });
    }));

    this.categories = new Map();
    for (const E of this.ents) {
      if (!E.meshes.length) continue;
      E.cat = categorize(E.name === rootEnt.name ? '' : E.name, E.tag);
      if (!this.categories.has(E.cat)) this.categories.set(E.cat, { name: E.cat, visible: true, count: 0 });
      this.categories.get(E.cat).count++;
    }
    this.byPid = new Map(this.ents.filter(E => E.pid != null).map(E => [E.pid, E]));
    // top level made of containers only (tag groups, COLLADA categories): a tap picks the object inside
    const kids = top.children, containers = kids.filter(E => E.children.length && !E.meshes.length).length;
    if (kids.length >= 3 && containers / kids.length >= 0.8) this.objectsUnderTags = true;
  }

  // Normals (creased at 40 degrees: flat walls, smooth pipes) and edge lines, a slice per frame.
  async prepareGeometry(onProgress) {
    const normals = new Map(), edges = new Map();
    let t0 = performance.now();
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      let g = m.geometry;
      if (!g.attributes.normal) {
        if (!normals.has(g)) {
          const ng = toCreasedNormals(g, CREASE);
          g.dispose();
          normals.set(g, ng);
        }
        g = m.geometry = normals.get(g);
      }
      if (!edges.has(g)) edges.set(g, new THREE.EdgesGeometry(g, 40));
      const line = new THREE.LineSegments(edges.get(g), this.edgeMat);
      line.raycast = () => {};
      line.userData.edge = true;
      line.visible = this.edges;
      line.renderOrder = 1;
      m.add(line);
      m.userData.line = line;
      if (performance.now() - t0 > 40) {
        onProgress(i / this.meshes.length);
        await yieldToBrowser();
        t0 = performance.now();
      }
    }
  }

  // ---- materials ---------------------------------------------------------

  withSection(mat) {
    const U = this.secUniforms;
    mat.onBeforeCompile = shader => {
      shader.uniforms.uSecOn = U.uSecOn;
      shader.uniforms.uSecColor = U.uSecColor;
      shader.fragmentShader = 'uniform float uSecOn;\nuniform vec3 uSecColor;\n' + shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        '#include <dithering_fragment>\n if (uSecOn > 0.5 && !gl_FrontFacing) gl_FragColor = vec4(uSecColor, 1.0);');
    };
    mat.customProgramCacheKey = () => 'mv-section';
    return mat;
  }

  variants(src) {
    let v = this.mats.get(src);
    if (v) return v;
    const opacity = src.opacity ?? 1;
    const base = this.withSection(new THREE.MeshLambertMaterial({
      name: src.name, color: src.color ? src.color.clone() : new THREE.Color(0xdddddd), map: src.map || null,
      side: THREE.DoubleSide, transparent: !!src.transparent || opacity < 1, opacity,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    }));
    if (base.transparent) base.depthWrite = false;
    const ghost = this.withSection(base.clone());
    ghost.transparent = true;
    ghost.userData.maxOpacity = opacity;
    this.styleGhost(ghost);
    const sel = this.withSection(base.clone());
    sel.emissive = new THREE.Color(0x2f6fe0);
    sel.emissiveIntensity = 0.5;
    sel.transparent = false;
    sel.opacity = 1;
    sel.depthWrite = true;
    const fresh = this.withSection(sel.clone());
    fresh.emissive = new THREE.Color(0xff6a00);
    fresh.emissiveIntensity = 0.75;
    v = { base, ghost, sel, fresh };
    this.mats.set(src, v);
    return v;
  }

  applyMaterial(mesh) {
    const E = mesh.userData.owner;
    const key = this.selSet.has(E) ? 'sel' : E.fresh ? 'fresh'
      : (E.ghost || this.xray || (E.unbuilt && this.seqGhost)) ? 'ghost' : 'base';
    const src = mesh.userData.src;
    mesh.material = Array.isArray(src) ? src.map(s => this.variants(s)[key]) : this.variants(src)[key];
    mesh.castShadow = this.shadows && key !== 'ghost';
    mesh.receiveShadow = this.shadows;
  }

  refreshMaterials() {
    for (const m of this.meshes) this.applyMaterial(m);
    this.requestRender();
  }

  setXray(on) { this.xray = on; this.styleEdges(); this.refreshMaterials(); }

  // how solid see-through things are (X-ray and See-thru objects), 0.02 .. 0.95
  setGhostOpacity(x) {
    this.ghostOpacity = Math.min(0.95, Math.max(0.02, x));
    for (const v of this.mats.values()) this.styleGhost(v.ghost);
    this.styleEdges();
    this.requestRender();
  }

  // in X-ray the edge lines fade with the faces, else the house reads as a dark wire mesh
  styleEdges() {
    this.edgeMat.opacity = this.xray ? Math.min(0.6, 0.12 + this.ghostOpacity * 0.8) : 0.6;
  }

  styleGhost(m) {
    m.opacity = Math.min(m.userData.maxOpacity ?? 1, this.ghostOpacity);
    // fairly solid: write depth so faces sort like solid ones; faint: let everything show through
    const depth = this.ghostOpacity > 0.6;
    m.depthWrite = depth;
  }

  setEdges(on) {
    this.edges = on;
    for (const m of this.meshes) if (m.userData.line) m.userData.line.visible = on;
    this.requestRender();
  }

  setShadows(on) {
    this.shadows = on;
    this.renderer.shadowMap.enabled = on;
    this.ground.visible = on;
    for (const v of this.mats.values()) for (const m of Object.values(v)) m.needsUpdate = true;
    this.refreshMaterials();
  }

  // dir: world-space unit vector pointing at the sun
  setSunDir(dir) {
    this.sunDir.copy(dir).normalize();
    const S = this.sphere || new THREE.Sphere(new THREE.Vector3(), 20);
    const up = this.sunDir.y;
    const day = THREE.MathUtils.smoothstep(up, -0.02, 0.12);
    this.sun.intensity = 1.5 * day;
    this.hemi.intensity = 1.2 + 0.7 * day;
    this.sun.position.copy(S.center).addScaledVector(this.sunDir, S.radius * 2);
    this.sun.target.position.copy(S.center);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -S.radius;
    sc.right = sc.top = S.radius;
    sc.near = 0.1;
    sc.far = S.radius * 4;
    sc.updateProjectionMatrix();
    this.requestRender();
  }

  // ---- visibility --------------------------------------------------------

  updateVisibility(quiet = false) {
    const iso = this.isolated;
    const visit = (E, hidden, inIso) => {
      hidden = hidden || E.hidden || this.tags.get(E.tag)?.visible === false;
      inIso = inIso || !iso || iso.has(E);
      const show = !hidden && inIso && this.categories.get(E.cat)?.visible !== false && !(E.unbuilt && !this.seqGhost);
      E.obj.visible = !hidden;
      for (const m of E.meshes) m.visible = show;   // after: the object may be the mesh itself
      E.shown = show;
      for (const c of E.children) visit(c, hidden, inIso);
    };
    visit(this.rootEnt, false, false);
    this.pickables = this.meshes.filter(m => m.visible && m.userData.owner.obj.visible && this.chainVisible(m));
    this.requestRender();
    if (!quiet) this.dispatchEvent(new Event('visibility'));
  }

  chainVisible(o) {
    for (let p = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  }

  setHidden(E, hidden) { E.hidden = hidden; this.updateVisibility(); }

  isolate(list) {
    this.isolated = list && list.length ? new Set(list) : null;
    this.updateVisibility();
  }

  showAll() {
    for (const E of this.ents) { E.hidden = false; E.ghost = false; }
    for (const t of this.tags.values()) t.visible = true;
    for (const c of this.categories.values()) c.visible = true;
    this.isolated = null;
    this.refreshMaterials();
    this.updateVisibility();
  }

  descendants(E, out = []) {
    out.push(E);
    for (const c of E.children) this.descendants(c, out);
    return out;
  }

  // ---- selection + picking -----------------------------------------------

  select(E) {
    const before = this.selSet;
    this.selected = E;
    this.selSet = new Set(E ? this.descendants(E) : []);
    for (const X of new Set([...before, ...this.selSet])) for (const m of X.meshes) this.applyMaterial(m);
    this.requestRender();
    this.dispatchEvent(new Event('select'));
  }

  // From the whole object (e.g. "Dining chair 1") down to the tapped part: the first tap
  // selects the object, tapping it again goes one level deeper (like SketchUp's double-click).
  chain(leaf) {
    const list = [];
    for (let e = leaf; e && e !== this.top && e !== this.rootEnt; e = e.parent) {
      if (this.objectsUnderTags && e.parent === this.top) break;   // COLLADA: that level is the tag
      list.unshift(e);
    }
    return list.length ? list : [leaf];
  }

  setGhost(E, on) {
    for (const X of this.descendants(E)) X.ghost = on;
    this.refreshMaterials();
  }

  ndc(x, y) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }

  // first visible, unclipped surface under a screen point
  pick(x, y, list = this.pickables) {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    return this.firstHit(this.raycaster.intersectObjects(list, false));
  }

  firstHit(hits) {
    for (const h of hits) {
      if (this.clipPlanes.some(p => p.distanceToPoint(h.point) < 0)) continue;
      return h;
    }
    return null;
  }

  ray(origin, dir, far) {
    this.raycaster.set(origin, dir);
    this.raycaster.far = far;
    const h = this.firstHit(this.raycaster.intersectObjects(this.pickables, false));
    this.raycaster.far = Infinity;
    return h;
  }

  toScreen(v) {
    const p = v.clone().project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: (p.x + 1) / 2 * r.width, y: (1 - p.y) / 2 * r.height, behind: p.z > 1 };
  }

  // ---- camera ------------------------------------------------------------

  flyTo(pos, target, fov, dur = 0.9) {
    const cam = this.camera, ctl = this.controls;
    const p0 = cam.position.clone(), t0 = ctl.target.clone(), f0 = cam.fov;
    let t = 0;
    if (this._fly) this.tickers.delete(this._fly);
    this._fly = dt => {
      t = dur > 0 ? Math.min(1, t + dt / dur) : 1;
      const k = ease(t);
      cam.position.lerpVectors(p0, pos, k);
      ctl.target.lerpVectors(t0, target, k);
      if (fov) { cam.fov = f0 + (fov - f0) * k; cam.updateProjectionMatrix(); }
      if (!ctl.enabled) cam.lookAt(ctl.target);
      if (t >= 1) { this.tickers.delete(this._fly); this.dispatchEvent(new Event('flown')); }
      this.requestRender();
    };
    if (dur <= 0) this._fly(0); else this.tickers.add(this._fly);
  }

  fitBox(box, dir, animate = true) {
    if (box.isEmpty()) return;
    const s = box.getBoundingSphere(new THREE.Sphere());
    const vf = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const hf = Math.atan(Math.tan(vf) * this.camera.aspect);
    const d = s.radius / Math.sin(Math.min(vf, hf)) * 1.02;
    dir = dir || this.camera.position.clone().sub(this.controls.target).normalize();
    if (!isFinite(dir.x) || dir.lengthSq() < 0.5) dir = new THREE.Vector3(1, 0.7, 1.2).normalize();
    this.flyTo(s.center.clone().addScaledVector(dir, d), s.center, null, animate ? 0.8 : 0);
  }

  visibleBox() {
    const b = new THREE.Box3();
    for (const m of this.pickables) b.expandByObject(m);
    return b.isEmpty() ? this.box.clone() : b;
  }

  fitAll(animate = true) {
    this.fitBox(this.visibleBox(), animate ? null : new THREE.Vector3(1, 0.7, 1.2).normalize(), animate);
  }

  entityBox(E) {
    const b = new THREE.Box3();
    for (const X of this.descendants(E)) for (const m of X.meshes) b.expandByObject(m);
    return b;
  }

  zoomTo(E) { this.fitBox(this.entityBox(E)); }

  // a SketchUp scene camera (source units / axes) -> world
  srcPoint(a) { return new THREE.Vector3(a[0], a[1], a[2]).applyMatrix4(this.srcFrame); }
  srcDir(a) { return new THREE.Vector3(a[0], a[1], a[2]).transformDirection(this.srcFrame); }
}
