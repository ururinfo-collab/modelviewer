// AR (WebXR, Chrome on Android with Google Play Services for AR): the camera picture with the model
// on a real surface.
//  - Table model: a white ring shows the table / floor; tap to put the house there (tap again to move).
//    Scales 1:200 to 1:10, zoom in / out, turn. Centred on the house, not the whole site.
//  - Full size (1:1): before starting you tap the spot in the model where you want to stand; in AR
//    that spot is put at your feet, facing the way you looked in the model. Then raise / lower,
//    slide and turn the model until it sits right; tap the floor to put it back at your feet.
import * as THREE from 'three';

export async function arSupported() {
  try { return !!navigator.xr && await navigator.xr.isSessionSupported('immersive-ar'); } catch { return false; }
}

export const SCALES = { 200: '1:200', 100: '1:100', 50: '1:50', 20: '1:20', 10: '1:10' };

const yawOf = q => { const e = new THREE.Euler().setFromQuaternion(q, 'YXZ'); return e.y; };

export class AR {
  constructor(app, overlay) {
    this.app = app;
    this.v = app.viewer;
    this.overlay = overlay;
    this.scale = 20;
    this.mode = 'table';       // table | full
    this.active = false;
  }

  // the house without its site context: what the table model is centred on
  houseBox() {
    const v = this.v, b = new THREE.Box3();
    for (const E of v.ents) {
      if (!E.meshes.length || !E.shown || /context|indicative|neighbo/i.test(`${E.tag} ${E.name}`)) continue;
      for (const m of E.meshes) b.expandByObject(m);
    }
    return b.isEmpty() ? v.visibleBox() : b;
  }

  // mode 'full' needs stand = { point (world, on the floor), yaw (viewer heading) }
  async start(mode = 'table', stand = null) {
    const v = this.v, r = v.renderer;
    this.mode = mode;
    this.stand = stand;
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay'], domOverlay: { root: this.overlay },
    });
    this.session = session;
    this.active = true;
    this.placed = false;
    this.seen = false;
    this.saved = { bg: v.scene.background, edges: v.edges, ao: v.ao, shadows: v.shadows, ground: v.ground.visible,
      surface: v.groundSurface.visible, controls: v.controls.enabled, cam: v.camera.position.clone(), target: v.controls.target.clone() };
    v.scene.background = null;
    v.setEdges(false);            // half the drawing work: phones in AR need the headroom
    v.ao = false;
    if (v.shadows) v.setShadows(false);
    v.ground.visible = v.groundSurface.visible = false;
    v.controls.enabled = false;

    // the model hangs from a pivot: at the house's base centre (table) or at your standing spot (full)
    let origin;
    if (mode === 'full') origin = stand.point.clone();
    else {
      const box = this.houseBox();
      origin = box.getCenter(new THREE.Vector3());
      origin.y = THREE.MathUtils.clamp(0, box.min.y, box.max.y);
    }
    this.pivot = new THREE.Group();
    this.inner = new THREE.Group();
    this.inner.position.copy(origin).negate();
    this.pivot.add(this.inner);
    this.inner.add(v.root);           // the root keeps its own transform inside the pivot
    this.pivot.visible = false;
    this.pivot.scale.setScalar(mode === 'full' ? 1 : 1 / this.scale);
    v.scene.add(this.pivot);

    this.reticle = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.065, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    v.scene.add(this.reticle);

    r.xr.enabled = true;
    r.xr.setReferenceSpaceType('local');
    await r.xr.setSession(session);
    const viewerSpace = await session.requestReferenceSpace('viewer');
    this.hitSource = await session.requestHitTestSource({ space: viewerSpace });
    v.onXRFrame = frame => this.frame(frame);
    session.addEventListener('select', () => this.place());
    session.addEventListener('end', () => this.cleanup());
    this.onStatus?.(mode === 'full'
      ? 'Point the phone at the floor near your feet until the ring appears, then tap.'
      : 'Move the phone slowly over a table or the floor until the ring appears, then tap.');
  }

  frame(frame) {
    if (!frame || !this.hitSource) return;
    const space = this.v.renderer.xr.getReferenceSpace();
    const pose = frame.getViewerPose(space);
    if (pose) {
      const p = pose.transform.position, o = pose.transform.orientation;
      this.phonePos = new THREE.Vector3(p.x, p.y, p.z);
      this.phoneYaw = yawOf(new THREE.Quaternion(o.x, o.y, o.z, o.w));
    }
    const hits = frame.getHitTestResults(this.hitSource);
    if (hits.length) {
      this.reticle.visible = !(this.mode === 'full' && this.placed);
      this.reticle.matrix.fromArray(hits[0].getPose(space).transform.matrix);
      this.floorY = new THREE.Vector3().setFromMatrixPosition(this.reticle.matrix).y;
      if (!this.seen) { this.seen = true; this.onStatus?.(this.placed ? '' : 'Tap to place the model.'); }
    } else this.reticle.visible = false;
    if (this.mode === 'full' && this.placed) this.onEye?.(this.eyeLevel());
  }

  // table: on the ring. Full size: your standing spot at your feet, facing where you looked in the model
  place() {
    if (this.mode === 'full') {
      if (this.floorY == null || !this.phonePos) return;
      this.pivot.position.set(this.phonePos.x, this.floorY, this.phonePos.z);
      this.pivot.rotation.y = this.phoneYaw - this.stand.yaw;
      this.onStatus?.('You are standing at your chosen spot. Raise / lower, slide or turn the model to line it up.');
    } else {
      if (!this.reticle.visible) return;
      this.pivot.position.setFromMatrixPosition(this.reticle.matrix);
      this.onStatus?.('Walk around it. Tap the table again to move it.');
    }
    this.pivot.visible = true;
    this.placed = true;
  }

  // phone height above the model's floor at the standing spot
  eyeLevel() { return this.phonePos ? this.phonePos.y - this.pivot.position.y : 0; }

  setScale(s) {
    this.scale = +s;
    if (this.pivot && this.mode === 'table') this.pivot.scale.setScalar(1 / this.scale);
  }

  zoom(f) {
    this.scale = THREE.MathUtils.clamp(this.scale / f, 2, 500);
    if (this.pivot && this.mode === 'table') this.pivot.scale.setScalar(1 / this.scale);
  }

  turn(deg) { if (this.pivot) this.pivot.rotation.y += THREE.MathUtils.degToRad(deg); }

  // full size: up / down, and slide along the way the phone faces (forward) or across it (right)
  raise(dy) { if (this.pivot) this.pivot.position.y += dy; }
  slide(forward, right) {
    if (!this.pivot) return;
    const yaw = this.phoneYaw ?? 0;
    const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    this.pivot.position.addScaledVector(f, forward).addScaledVector(r, right);
  }

  stop() { this.session?.end(); }

  cleanup() {
    const v = this.v, r = v.renderer, s = this.saved;
    if (!this.active) return;
    this.active = false;
    this.hitSource?.cancel?.();
    this.hitSource = null;
    v.onXRFrame = null;
    v.scene.add(v.root);              // back to the scene with its own transform
    v.scene.remove(this.pivot, this.reticle);
    this.reticle.geometry.dispose();
    r.xr.enabled = false;
    v.scene.background = s.bg;
    v.setEdges(s.edges);
    v.ao = s.ao;
    if (s.shadows) v.setShadows(true);
    v.ground.visible = s.ground;
    v.groundSurface.visible = s.surface;
    v.controls.enabled = s.controls;
    v.camera.position.copy(s.cam);
    v.controls.target.copy(s.target);
    v.controls.update();
    v.resize();
    v.requestRender();
    this.session = null;
    this.onEnd?.();
  }
}
