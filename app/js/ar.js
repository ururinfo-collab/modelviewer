// AR (WebXR, Chrome on Android with Google Play Services for AR): the camera picture with the
// model placed on a real surface. A ring shows where the floor / table is; tap to put the model
// there (tap again to move it). Scales 1:200 to 1:1, turn in 15 degree steps.
import * as THREE from 'three';

export async function arSupported() {
  try { return !!navigator.xr && await navigator.xr.isSessionSupported('immersive-ar'); } catch { return false; }
}

export const SCALES = { 200: '1:200', 100: '1:100', 50: '1:50', 1: '1:1' };

export class AR {
  constructor(app, overlay) {
    this.app = app;
    this.v = app.viewer;
    this.overlay = overlay;
    this.scale = 50;
    this.active = false;
  }

  async start() {
    const v = this.v, r = v.renderer;
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay'], domOverlay: { root: this.overlay },
    });
    this.session = session;
    this.active = true;
    this.placed = false;
    // what AR changes, to put back afterwards
    this.saved = { bg: v.scene.background, edges: v.edges, ao: v.ao, shadows: v.shadows, ground: v.ground.visible,
      surface: v.groundSurface.visible, controls: v.controls.enabled, cam: v.camera.position.clone(), target: v.controls.target.clone() };
    v.scene.background = null;
    v.setEdges(false);            // half the drawing work: phones in AR need the headroom
    v.ao = false;
    if (v.shadows) v.setShadows(false);
    v.ground.visible = v.groundSurface.visible = false;
    v.controls.enabled = false;

    // the model hangs from a pivot at its base centre (ground level, middle of what is shown)
    const box = v.visibleBox();
    const base = box.getCenter(new THREE.Vector3());
    base.y = THREE.MathUtils.clamp(0, box.min.y, box.max.y);
    this.pivot = new THREE.Group();
    this.inner = new THREE.Group();
    this.inner.position.copy(base).negate();
    this.pivot.add(this.inner);
    this.inner.add(v.root);           // the root keeps its own transform inside the pivot
    this.pivot.visible = false;
    this.pivot.scale.setScalar(1 / this.scale);
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
    this.onStatus?.('Move the phone slowly over the floor or a table until the ring appears, then tap.');
  }

  frame(frame) {
    if (!frame || !this.hitSource) return;
    const hits = frame.getHitTestResults(this.hitSource);
    const space = this.v.renderer.xr.getReferenceSpace();
    if (hits.length) {
      const pose = hits[0].getPose(space);
      this.reticle.visible = true;
      this.reticle.matrix.fromArray(pose.transform.matrix);
      if (!this.seen) { this.seen = true; this.onStatus?.(this.placed ? '' : 'Tap to place the model on the ring.'); }
    } else this.reticle.visible = false;
  }

  place() {
    if (!this.reticle.visible) return;
    this.pivot.position.setFromMatrixPosition(this.reticle.matrix);
    this.pivot.visible = true;
    this.placed = true;
    this.onStatus?.('Walk around it. Tap the floor again to move it.');
  }

  setScale(s) {
    this.scale = +s;
    if (this.pivot) this.pivot.scale.setScalar(1 / this.scale);
  }

  turn(deg) { if (this.pivot) this.pivot.rotation.y += THREE.MathUtils.degToRad(deg); }

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
