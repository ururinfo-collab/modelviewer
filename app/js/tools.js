// Section cut, measure, and walk (first person).
import * as THREE from 'three';
import { fmt } from './units.js';

// ---- section ---------------------------------------------------------------
// One clipping plane. Back faces seen through the cut are painted the section colour,
// so closed solids (walls, slabs) read as cut.
export class SectionTool {
  constructor(viewer) {
    this.v = viewer;
    this.mode = 'off';
    this.flip = false;
    this.value = 0;         // metres along the axis (plan: height above 0)
    this.range = [0, 1];
    this.normal = new THREE.Vector3();
    this.origin = new THREE.Vector3();
    this.plane = new THREE.Plane();
  }

  // mode: off | plan | x | z | face
  set(mode, hit) {
    const v = this.v, b = v.box;
    this.mode = mode;
    if (mode === 'off') return this.apply();
    if (mode === 'plan') {
      this.normal.set(0, -1, 0);
      this.range = [b.min.y, b.max.y];
      this.value = THREE.MathUtils.clamp(1.2, b.min.y, b.max.y);
    } else if (mode === 'x' || mode === 'z') {
      this.normal.set(mode === 'x' ? -1 : 0, 0, mode === 'z' ? -1 : 0);
      const k = mode;
      this.range = [b.min[k], b.max[k]];
      this.value = (b.min[k] + b.max[k]) / 2;
    } else if (mode === 'face' && hit) {
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (n.dot(v.raycaster.ray.direction) > 0) n.negate();
      this.normal.copy(n).negate();      // keep what is behind the tapped face
      this.origin.copy(hit.point);
      const r = v.sphere.radius;
      this.range = [-r, r];
      this.value = 0;
    }
    this.apply();
  }

  setValue(x) { this.value = x; this.apply(); }
  toggleFlip() { this.flip = !this.flip; this.apply(); }

  apply() {
    const v = this.v;
    if (this.mode === 'off') {
      v.clipPlanes = [];
    } else {
      const n = this.normal.clone();
      let point;
      if (this.mode === 'face') point = this.origin.clone().addScaledVector(n, -this.value);
      else {
        point = new THREE.Vector3();
        const axis = this.mode === 'plan' ? 'y' : this.mode;
        point[axis] = this.value;
      }
      if (this.flip) n.negate();
      this.plane.setFromNormalAndCoplanarPoint(n, point);
      v.clipPlanes = [this.plane];
    }
    v.renderer.clippingPlanes = v.clipPlanes;
    v.secUniforms.uSecOn.value = v.clipPlanes.length ? 1 : 0;
    v.updateVisibility();
  }
}

// ---- measure ---------------------------------------------------------------
export class MeasureTool {
  constructor(viewer, labelLayer) {
    this.v = viewer;
    this.layer = labelLayer;
    this.items = [];          // { a, b, line, label }
    this.pending = null;
    this.group = new THREE.Group();
    this.group.renderOrder = 10;
    viewer.scene.add(this.group);
    this.dotMat = new THREE.PointsMaterial({ color: 0xe8590c, size: 11, sizeAttenuation: false, depthTest: false });
    this.lineMat = new THREE.LineBasicMaterial({ color: 0xe8590c, depthTest: false });
    viewer.afterRender.add(() => this.placeLabels());
  }

  // nearest corner of the tapped triangle when it is within ~22 px of the finger
  snap(hit, x, y) {
    const pos = hit.object.geometry.attributes.position, mw = hit.object.matrixWorld;
    const r = this.v.canvas.getBoundingClientRect();
    let best = hit.point.clone(), bestD = 22, snapped = false;
    for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mw);
      const s = this.v.toScreen(p);
      const d = Math.hypot(s.x + r.left - x, s.y + r.top - y);
      if (d < bestD) { bestD = d; best = p; snapped = true; }
    }
    return { p: best, snapped };
  }

  onTap(x, y) {
    const hit = this.v.pick(x, y);
    if (!hit) return;
    const { p } = this.snap(hit, x, y);
    if (!this.pending) {
      this.pending = { p, dot: this.dot(p) };
    } else {
      const a = this.pending.p;
      this.group.remove(this.pending.dot);
      this.pending = null;
      this.add(a, p);
    }
    this.v.requestRender();
    this.onChange?.();
  }

  dot(p) {
    const g = new THREE.BufferGeometry().setFromPoints([p]);
    const d = new THREE.Points(g, this.dotMat);
    d.renderOrder = 11;
    this.group.add(d);
    return d;
  }

  add(a, b) {
    const g = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.LineSegments(g, this.lineMat);
    line.renderOrder = 10;
    const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints([a, b]), this.dotMat);
    dots.renderOrder = 11;
    this.group.add(line, dots);
    const label = document.createElement('div');
    label.className = 'mlabel';
    const d = a.distanceTo(b), dy = Math.abs(b.y - a.y), dh = Math.hypot(b.x - a.x, b.z - a.z);
    label.innerHTML = `<b>${fmt(d)}</b>` + (dy > 0.005 && dh > 0.005 ? `<small>H ${fmt(dh)} · V ${fmt(dy)}</small>` : '');
    this.layer.appendChild(label);
    this.items.push({ a, b, line, dots, label });
  }

  relabel() {
    const items = this.items.splice(0);
    for (const it of items) { this.group.remove(it.line, it.dots); it.label.remove(); this.add(it.a, it.b); }
    this.v.requestRender();
  }

  placeLabels() {
    for (const it of this.items) {
      const s = this.v.toScreen(it.a.clone().add(it.b).multiplyScalar(0.5));
      it.label.style.display = s.behind ? 'none' : '';
      it.label.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -130%)`;
    }
  }

  undo() {
    if (this.pending) { this.group.remove(this.pending.dot); this.pending = null; }
    else {
      const it = this.items.pop();
      if (it) { this.group.remove(it.line, it.dots); it.label.remove(); }
    }
    this.v.requestRender();
    this.onChange?.();
  }

  clear() {
    while (this.items.length || this.pending) this.undo();
  }
}

// ---- walk ------------------------------------------------------------------
// Left thumb: joystick. Drag anywhere else: look. Floor follows stairs and slabs (step up 0.45 m).
export class WalkTool {
  constructor(viewer) {
    this.v = viewer;
    this.active = false;
    this.eye = 1.6;
    this.fly = false;
    this.collide = true;
    this.move = new THREE.Vector2();     // joystick, x = strafe, y = forward
    this.keys = new Set();
    this.vert = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.feet = new THREE.Vector3();
    this.vy = 0;
    this.tick = dt => this.update(dt);
    this.onKey = e => {
      if (!this.active || e.target.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if ('wasdqe'.includes(k) || k.startsWith('arrow') || k === 'shift') {
        e.type === 'keydown' ? this.keys.add(k) : this.keys.delete(k);
      }
    };
    addEventListener('keydown', this.onKey);
    addEventListener('keyup', this.onKey);
  }

  enter() {
    const v = this.v;
    this.active = true;
    this.placed = false;
    this.saved = { pos: v.camera.position.clone(), target: v.controls.target.clone(), fov: v.camera.fov };
    v.controls.enabled = false;
  }

  // stand on the tapped spot (or in front of the tapped wall)
  place(hit) {
    const v = this.v;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    let p = hit.point.clone();
    if (Math.abs(n.y) < 0.6) p.addScaledVector(v.raycaster.ray.direction, -0.5);
    const floor = this.floorBelow(p.clone().add(new THREE.Vector3(0, 0.3, 0)), 50);
    this.feet.set(p.x, floor ?? p.y, p.z);
    const d = v.camera.getWorldDirection(new THREE.Vector3());
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = 0;
    this.vy = 0;
    this.placed = true;
    v.camera.fov = 60;
    v.camera.updateProjectionMatrix();
    v.tickers.add(this.tick);
    this.updateCamera();
  }

  exit() {
    const v = this.v;
    this.active = false;
    v.tickers.delete(this.tick);
    v.controls.enabled = true;
    if (this.placed) {
      const fwd = v.camera.getWorldDirection(new THREE.Vector3());
      v.controls.target.copy(v.camera.position).addScaledVector(fwd, 4);
    } else if (this.saved) {
      v.camera.position.copy(this.saved.pos);
      v.controls.target.copy(this.saved.target);
    }
    if (this.saved) { v.camera.fov = this.saved.fov; v.camera.updateProjectionMatrix(); }
    v.controls.update();
    v.requestRender();
  }

  look(dx, dy) {
    this.yaw += dx * 0.004;        // the view follows the finger, like Street View
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, -1.45, 1.45);
    this.updateCamera();
  }

  // floors, stairs and the ground carry you; beds and tables do not
  floorBelow(from, far) {
    const h = this.v.ray(from, new THREE.Vector3(0, -1, 0), far, E => E.walkable);
    return h ? h.point.y : null;
  }

  // nothing blocks you in the See inside and X-ray views
  get free() { return this.v.viewMode !== 'solid'; }

  blocked(dir, dist) {
    if (this.free) return false;
    for (const hgt of [0.5, 1.2]) {
      const o = this.feet.clone().add(new THREE.Vector3(0, hgt, 0));
      if (this.v.ray(o, dir, dist + 0.3)) return true;
    }
    return false;
  }

  update(dt) {
    const k = this.keys;
    let mx = this.move.x, my = this.move.y;
    if (k.has('w') || k.has('arrowup')) my += 1;
    if (k.has('s') || k.has('arrowdown')) my -= 1;
    if (k.has('a') || k.has('arrowleft')) mx -= 1;
    if (k.has('d') || k.has('arrowright')) mx += 1;
    const vert = this.vert + (k.has('e') ? 1 : 0) - (k.has('q') ? 1 : 0);
    const speed = (k.has('shift') ? 3 : 1.4) * dt;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const step = fwd.multiplyScalar(my).addScaledVector(right, mx);
    if (step.lengthSq() > 1) step.normalize();
    step.multiplyScalar(speed);
    const len = step.length();
    if (len > 0 && !(this.collide && this.blocked(step.clone().normalize(), len))) this.feet.add(step);

    if (this.fly) {
      this.feet.y += vert * speed;
    } else {
      const floor = this.floorBelow(this.feet.clone().add(new THREE.Vector3(0, 0.45, 0)), 60);
      if (floor !== null && floor >= this.feet.y - 0.02) {
        this.feet.y += (floor - this.feet.y) * Math.min(1, dt * 12);   // step up
        this.vy = 0;
      } else if (floor !== null) {
        this.vy -= 9.8 * dt;
        this.feet.y = Math.max(floor, this.feet.y + this.vy * dt);   // fall
      }
    }
    this.updateCamera();
  }

  updateCamera() {
    const cam = this.v.camera;
    cam.position.set(this.feet.x, this.feet.y + this.eye, this.feet.z);
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    cam.updateMatrixWorld();
    this.v.requestRender();
  }
}
