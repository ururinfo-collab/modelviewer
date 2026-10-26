// Presentation helpers: pieces that make the model look presented without rendering it.
//  - ContactShadow: a soft shadow on the ground under the model, baked once (re-baked when what is shown changes),
//    so it costs nothing while orbiting (three.js "contact shadows" example).
//  - skyEnvironment: sky light from a blue-to-horizon gradient dome (each side of the house gets its own light,
//    glass reflects the sky).
//  - ProfileShader: SketchUp-style heavy outlines where depth jumps (the silhouette of every shape), from the depth
//    buffer the soft-corner pass already makes.
//  - Vignette: darker frame edges, drawn into the picture so photos and videos keep it.
import * as THREE from 'three';

const BLUR_FS = `uniform sampler2D tDiffuse;
uniform vec2 dir;
varying vec2 vUv;
void main() {
  vec4 s = texture2D(tDiffuse, vUv) * 0.1633;
  s += (texture2D(tDiffuse, vUv - dir) + texture2D(tDiffuse, vUv + dir)) * 0.1531;
  s += (texture2D(tDiffuse, vUv - 2.0 * dir) + texture2D(tDiffuse, vUv + 2.0 * dir)) * 0.12245;
  s += (texture2D(tDiffuse, vUv - 3.0 * dir) + texture2D(tDiffuse, vUv + 3.0 * dir)) * 0.0918;
  s += (texture2D(tDiffuse, vUv - 4.0 * dir) + texture2D(tDiffuse, vUv + 4.0 * dir)) * 0.051;
  gl_FragColor = s;
}`;
const UV_VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

export class ContactShadow {
  constructor(viewer, size = 512) {
    this.v = viewer;
    const opts = { generateMipmaps: false };
    this.rt = new THREE.WebGLRenderTarget(size, size, opts);
    this.rtBlur = new THREE.WebGLRenderTarget(size, size, opts);
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.rt.texture, transparent: true, depthWrite: false, opacity: 0.85 }));
    this.plane.rotation.x = Math.PI / 2;
    this.plane.scale.y = -1;           // the camera looks up from below: flip back
    this.plane.renderOrder = 1;
    this.plane.raycast = () => {};
    this.plane.visible = false;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.cam.rotation.x = Math.PI / 2;  // looking up at the underside of the model
    this.group = new THREE.Group();
    this.group.add(this.plane, this.cam);
    viewer.scene.add(this.group);

    const depth = this.depth = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
    depth.userData.darkness = { value: 1.4 };
    depth.onBeforeCompile = shader => {
      shader.uniforms.darkness = depth.userData.darkness;
      shader.fragmentShader = 'uniform float darkness;\n' + shader.fragmentShader.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );');
    };
    depth.depthTest = depth.depthWrite = false;
    this.blurMat = new THREE.ShaderMaterial({ vertexShader: UV_VS, fragmentShader: BLUR_FS, depthTest: false, depthWrite: false,
      uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2() } } });
    this.blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMat);
    this.blurCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.enabled = false;
  }

  setEnabled(on) {
    this.enabled = on;
    this.plane.visible = on && !!this.v.root;
    if (on) this.bake();
    this.v.requestRender();
  }

  // the shadow of what is shown now, from the ground up to 3 m
  bake() {
    const v = this.v, r = v.renderer;
    if (!this.enabled || !v.root) return;
    const box = v.visibleBox();
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const gy = THREE.MathUtils.clamp(0, box.min.y, box.max.y);
    const w = size.x * 1.35 + 2, d = size.z * 1.35 + 2;
    this.group.position.set(c.x, gy + 0.006, c.z);
    this.plane.scale.set(w, -d, 1);
    Object.assign(this.cam, { left: -w / 2, right: w / 2, top: d / 2, bottom: -d / 2, near: 0, far: 3 });
    this.cam.updateProjectionMatrix();
    this.group.updateMatrixWorld(true);

    const hide = [this.plane, v.ground, v.groundSurface].map(o => [o, o.visible]);
    hide.forEach(([o]) => { o.visible = false; });
    const bg = v.scene.background, fog = v.scene.fog, clear = r.getClearAlpha(), target = r.getRenderTarget();
    const clip = r.clippingPlanes;
    v.scene.background = null;
    v.scene.fog = null;
    r.clippingPlanes = [];
    v.scene.overrideMaterial = this.depth;
    r.setClearAlpha(0);
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(v.scene, this.cam);
    v.scene.overrideMaterial = null;
    // two blur passes, the second finer
    for (const k of [3, 1.2]) {
      this.blurMat.uniforms.tDiffuse.value = this.rt.texture;
      this.blurMat.uniforms.dir.value.set(k / 512, 0);
      r.setRenderTarget(this.rtBlur);
      r.render(this.blurQuad, this.blurCam);
      this.blurMat.uniforms.tDiffuse.value = this.rtBlur.texture;
      this.blurMat.uniforms.dir.value.set(0, k / 512);
      r.setRenderTarget(this.rt);
      r.render(this.blurQuad, this.blurCam);
    }
    r.setRenderTarget(target);
    r.setClearAlpha(clear);
    r.clippingPlanes = clip;
    v.scene.background = bg;
    v.scene.fog = fog;
    hide.forEach(([o, vis]) => { o.visible = vis; });
    this.plane.visible = true;
    v.requestRender();
  }
}

// sky light: zenith blue, bright hazy horizon, warm grey ground bounce
export function skyEnvironment(renderer) {
  const scene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: new THREE.Color(0xb3c6da) }, horizon: { value: new THREE.Color(0xf4f2ec) }, ground: { value: new THREE.Color(0xa19884) } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; varying vec3 vDir;
void main() {
  float h = normalize(vDir).y;
  vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : mix(horizon, ground, pow(-h, 0.35));
  gl_FragColor = vec4(c, 1.0);
}`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), mat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(scene, 0.015).texture;
  pmrem.dispose();
  mat.dispose();
  return tex;
}

// heavy lines where depth jumps: the Laplacian of 1/depth is zero across any flat face, so only silhouettes,
// steps and folds draw. Works in the composer after the soft-corner pass, before tone mapping.
export const ProfileShader = {
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null }, cameraNear: { value: 0.1 }, cameraFar: { value: 1000 },
    resolution: { value: new THREE.Vector2(1, 1) }, width: { value: 1.5 }, color: { value: new THREE.Color(0x1f242a) }, strength: { value: 0.85 },
  },
  vertexShader: UV_VS,
  fragmentShader: `#include <packing>
uniform sampler2D tDiffuse; uniform sampler2D tDepth;
uniform float cameraNear; uniform float cameraFar; uniform vec2 resolution; uniform float width;
uniform vec3 color; uniform float strength;
varying vec2 vUv;
float invDepth(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  return -1.0 / perspectiveDepthToViewZ(d, cameraNear, cameraFar);
}
void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  vec2 px = width / resolution;
  float w = invDepth(vUv);
  float l = invDepth(vUv - vec2(px.x, 0.0)), r = invDepth(vUv + vec2(px.x, 0.0));
  float u = invDepth(vUv + vec2(0.0, px.y)), b = invDepth(vUv - vec2(0.0, px.y));
  float near = max(max(l, r), max(max(u, b), w));
  float e = max(abs(l + r - 2.0 * w), abs(u + b - 2.0 * w)) / max(near, 1e-6);
  float line = smoothstep(0.06, 0.22, e) * strength;
  gl_FragColor = vec4(mix(base.rgb, color, line), base.a);
}`,
};

export class Vignette {
  constructor(strength = 0.22) {
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false, uniforms: { strength: { value: strength } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform float strength; varying vec2 vUv;
void main() {
  float d = length((vUv - 0.5) * vec2(1.0, 0.85)) * 1.6;
  gl_FragColor = vec4(0.0, 0.0, 0.0, smoothstep(0.55, 1.15, d) * strength);
}`,
    });
    this.scene = new THREE.Scene();
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    q.frustumCulled = false;
    this.scene.add(q);
    this.cam = new THREE.Camera();
  }

  draw(renderer) {
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, this.cam);
    renderer.autoClear = ac;
  }
}
