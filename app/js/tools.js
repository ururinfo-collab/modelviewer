// Section cut, measure, and walk (first person).
import * as THREE from 'three';
import { fmt, fmtArea } from './units.js';

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
    // section box: six planes facing inwards; what is inside all of them stays
    this.box = new THREE.Box3();
    this.boxPlanes = Array.from({ length: 6 }, () => new THREE.Plane());
    this.helperBox = new THREE.Box3();        // drawn a hair inside, so the cut never hides the outline
    this.boxHelper = new THREE.Box3Helper(this.helperBox, 0xd23c2c);
    this.boxHelper.visible = false;
    this.boxHelper.raycast = () => {};
    viewer.scene.add(this.boxHelper);
  }

  // mode: off | plan | x | z | face | box
  set(mode, hit) {
    const v = this.v, b = v.box;
    this.mode = mode;
    if (mode === 'off') return this.apply();
    if (mode === 'box') return this.fitBox(v.selected ? v.entityBox(v.selected) : v.visibleBox(), !!v.selected);
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

  // box around an object (a room: its floor, a piece of furniture in it...) or around everything.
  // Around a flat object (a floor) the box rises to just under the ceiling: a dollhouse view
  // into the room (raise Top to include the ceiling).
  fitBox(b, around) {
    this.mode = 'box';
    this.box.copy(b);
    if (around) {
      this.box.expandByScalar(0.25);
      if (this.box.max.y - this.box.min.y < 2.4) this.box.max.y = this.box.min.y + 2.3;
    }
    this.apply();
  }

  // side: minX maxX minY maxY minZ maxZ (x = red axis, z = green, y = up)
  moveSide(side, delta) {
    const k = side.slice(3).toLowerCase(), end = side.slice(0, 3);
    this.box[end][k] += delta;
    if (this.box.min[k] > this.box.max[k] - 0.05) this.box[end][k] = end === 'min' ? this.box.max[k] - 0.05 : this.box.min[k] + 0.05;
    this.apply();
  }

  setSide(side, value) {
    const k = side.slice(3).toLowerCase(), end = side.slice(0, 3);
    this.box[end][k] = value;
    this.moveSide(side, 0);
  }

  apply() {
    const v = this.v;
    this.boxHelper.visible = this.mode === 'box';
    if (this.mode === 'off') {
      v.clipPlanes = [];
    } else if (this.mode === 'box') {
      const { min, max } = this.box, P = this.boxPlanes;
      P[0].set(new THREE.Vector3(1, 0, 0), -min.x);
      P[1].set(new THREE.Vector3(-1, 0, 0), max.x);
      P[2].set(new THREE.Vector3(0, 1, 0), -min.y);
      P[3].set(new THREE.Vector3(0, -1, 0), max.y);
      P[4].set(new THREE.Vector3(0, 0, 1), -min.z);
      P[5].set(new THREE.Vector3(0, 0, -1), max.z);
      v.clipPlanes = P;
      this.helperBox.copy(this.box).expandByScalar(-0.005);
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
    this.items = [];          // { kind, pts, objs, label, at }
    this.pending = null;      // { pts, objs } while tapping
    this.mode = 'dist';
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

  // mode: dist (2 taps) | angle (3 taps: end, corner, end) | area (tap the corners, tap the first again or Finish)
  setMode(mode) {
    this.cancelPending();
    this.mode = mode;
    this.onChange?.();
  }

  get needed() { return this.mode === 'angle' ? 3 : this.mode === 'area' ? Infinity : 2; }

  onTap(x, y) {
    const hit = this.v.pick(x, y);
    if (!hit) return;
    const { p } = this.snap(hit, x, y);
    const pts = this.pending ? this.pending.pts : [];
    // area: closing on the first corner finishes the shape
    if (this.mode === 'area' && pts.length >= 3) {
      const s = this.v.toScreen(pts[0]), r = this.v.canvas.getBoundingClientRect();
      if (Math.hypot(s.x + r.left - x, s.y + r.top - y) < 24) return this.finish();
    }
    pts.push(p);
    this.drawPending(pts);
    if (pts.length >= this.needed) this.finish();
    this.v.requestRender();
    this.onChange?.();
  }

  drawPending(pts) {
    this.cancelPending(false);
    const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), this.dotMat);
    dots.renderOrder = 11;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.lineMat);
    line.renderOrder = 10;
    this.group.add(dots, line);
    this.pending = { pts, objs: [dots, line] };
  }

  cancelPending(clearPts = true) {
    if (this.pending) {
      this.group.remove(...this.pending.objs);
      if (clearPts) this.pending = null;
      this.v.requestRender();
    }
  }

  // complete the current measurement (Finish button for areas)
  finish() {
    const pts = this.pending?.pts || [];
    const mode = this.mode || 'dist';
    if ((mode === 'area' && pts.length < 3) || (mode !== 'area' && pts.length < this.needed)) return;
    this.cancelPending();
    this.add(mode, pts);
    this.v.requestRender();
    this.onChange?.();
  }

  add(kind, pts) {
    const objs = [];
    const linePts = kind === 'area' ? [...pts, pts[0]] : pts;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePts), this.lineMat);
    line.renderOrder = 10;
    const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), this.dotMat);
    dots.renderOrder = 11;
    objs.push(line, dots);
    const label = document.createElement('div');
    label.className = 'mlabel';
    let at;
    if (kind === 'dist') {
      const [a, b] = pts, d = a.distanceTo(b), dy = Math.abs(b.y - a.y), dh = Math.hypot(b.x - a.x, b.z - a.z);
      label.innerHTML = `<b>${fmt(d)}</b>` + (dy > 0.005 && dh > 0.005 ? `<small>H ${fmt(dh)} · V ${fmt(dy)}</small>` : '');
      at = a.clone().add(b).multiplyScalar(0.5);
    } else if (kind === 'angle') {
      const [a, o, b] = pts;
      const deg = THREE.MathUtils.radToDeg(a.clone().sub(o).angleTo(b.clone().sub(o)));
      label.innerHTML = `<b>${deg.toFixed(1)}°</b>`;
      at = o.clone();
    } else {
      // vector area of the polygon (works on any plane: floors, walls, sloped roofs)
      const sum = new THREE.Vector3();
      let perim = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        sum.add(p.clone().cross(q));
        perim += p.distanceTo(q);
      }
      const area = sum.length() / 2;
      const fill = new THREE.Mesh(fanGeometry(pts),
        new THREE.MeshBasicMaterial({ color: 0xe8590c, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthTest: false }));
      fill.renderOrder = 9;
      objs.push(fill);
      label.innerHTML = `<b>${fmtArea(area)}</b><small>perimeter ${fmt(perim)}</small>`;
      at = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    }
    this.group.add(...objs);
    this.layer.appendChild(label);
    this.items.push({ kind, pts, objs, label, at });
  }

  relabel() {
    const items = this.items.splice(0);
    for (const it of items) { this.group.remove(...it.objs); it.label.remove(); this.add(it.kind, it.pts); }
    this.v.requestRender();
  }

  placeLabels() {
    for (const it of this.items) {
      const s = this.v.toScreen(it.at);
      it.label.style.display = s.behind ? 'none' : '';
      it.label.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -130%)`;
    }
  }

  undo() {
    if (this.pending && this.pending.pts.length > 1) {
      const pts = this.pending.pts.slice(0, -1);
      this.drawPending(pts);
    } else if (this.pending) this.cancelPending();
    else {
      const it = this.items.pop();
      if (it) { this.group.remove(...it.objs); it.label.remove(); }
    }
    this.v.requestRender();
    this.onChange?.();
  }

  clear() {
    this.cancelPending();
    while (this.items.length) this.undo();
  }
}

// fan of triangles from the first corner (good for the convex and L-shaped rooms one measures)
function fanGeometry(pts) {
  const pos = [];
  for (let i = 1; i < pts.length - 1; i++) pos.push(...pts[0].toArray(), ...pts[i].toArray(), ...pts[i + 1].toArray());
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
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
      if (!this.active || ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
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
