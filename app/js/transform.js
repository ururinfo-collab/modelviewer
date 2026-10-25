// Move / rotate the selected object with a gizmo, with undo and reset.
// The gizmo drives a proxy at the object's base (world metres), and the object follows the
// proxy's change, so it works at any depth of the model's hierarchy and units.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export class MoveTool {
  constructor(viewer) {
    this.v = viewer;
    this.E = null;
    this.mode = 'translate';
    this.horizontal = true;
    this.snap = true;
    this.undoStack = [];
    this.original = new Map();     // entity -> local matrix before its first edit
    this.proxy = new THREE.Object3D();
    viewer.scene.add(this.proxy);
    const tc = this.tc = new TransformControls(viewer.camera, viewer.canvas);
    tc.setSize(1.4);
    this.helper = tc.getHelper();
    viewer.scene.add(this.helper);
    tc.enabled = false;
    this.helper.visible = false;
    tc.addEventListener('change', () => viewer.requestRender());
    tc.addEventListener('dragging-changed', e => {
      viewer.controls.enabled = !e.value;
      e.value ? this.begin() : this.end();
    });
    tc.addEventListener('mouseDown', () => { this.usedGizmo = true; });
    tc.addEventListener('objectChange', () => this.follow());
    this.applySettings();
  }

  start(E) {
    this.E = E;
    this.placeProxy();
    this.tc.attach(this.proxy);
    this.tc.enabled = true;
    this.helper.visible = true;
    this.applySettings();
    this.v.requestRender();
  }

  stop() {
    this.tc.detach();
    this.tc.enabled = false;
    this.helper.visible = false;
    this.E = null;
    this.v.requestRender();
  }

  placeProxy() {
    const b = this.v.entityBox(this.E);
    const c = b.getCenter(new THREE.Vector3());
    this.proxy.position.set(c.x, b.min.y, c.z);
    this.proxy.quaternion.identity();
    this.proxy.updateMatrixWorld();
  }

  applySettings() {
    const tc = this.tc;
    tc.setMode(this.mode);
    tc.setSpace('world');
    tc.setTranslationSnap(this.snap ? 0.05 : null);
    tc.setRotationSnap(this.snap ? THREE.MathUtils.degToRad(15) : null);
    if (this.mode === 'translate') {
      tc.showX = true; tc.showZ = true; tc.showY = !this.horizontal;
    } else {
      tc.showY = true; tc.showX = !this.horizontal; tc.showZ = !this.horizontal;
    }
    this.v.requestRender();
  }

  begin() {
    const obj = this.E.obj;
    this.proxy.updateMatrixWorld();
    this.start0 = { proxyInv: this.proxy.matrixWorld.clone().invert(), world: obj.matrixWorld.clone(), local: obj.matrix.clone() };
    if (!this.original.has(this.E)) this.original.set(this.E, obj.matrix.clone());
  }

  follow() {
    if (!this.start0) return;
    const obj = this.E.obj;
    this.proxy.updateMatrixWorld();
    const delta = this.proxy.matrixWorld.clone().multiply(this.start0.proxyInv);
    const world = delta.multiply(this.start0.world);
    const local = obj.parent.matrixWorld.clone().invert().multiply(world);
    setLocal(obj, local);
    this.v.requestRender();
  }

  end() {
    if (!this.start0) return;
    const after = this.E.obj.matrix.clone();
    if (!after.equals(this.start0.local)) this.undoStack.push({ E: this.E, before: this.start0.local, after });
    this.start0 = null;
    this.placeProxy();
    this.v.updateVisibility();
    this.onChange?.();
  }

  undo() {
    const step = this.undoStack.pop();
    if (!step) return;
    setLocal(step.E.obj, step.before);
    if (this.E) this.placeProxy();
    this.v.requestRender();
    this.onChange?.();
  }

  reset(E) {
    const m = this.original.get(E);
    if (!m) return;
    this.undoStack.push({ E, before: E.obj.matrix.clone(), after: m.clone() });
    setLocal(E.obj, m);
    if (this.E) this.placeProxy();
    this.v.requestRender();
    this.onChange?.();
  }

  resetAll() {
    for (const [E, m] of this.original) setLocal(E.obj, m);
    this.original.clear();
    this.undoStack = [];
    if (this.E) this.placeProxy();
    this.v.requestRender();
    this.onChange?.();
  }

  get editedCount() {
    let n = 0;
    for (const [E, m] of this.original) if (!E.obj.matrix.equals(m)) n++;
    return n;
  }
}

function setLocal(obj, m) {
  m.decompose(obj.position, obj.quaternion, obj.scale);
  obj.updateMatrix();
  obj.updateMatrixWorld(true);
}
