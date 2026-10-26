// Photoreal still: path tracing on the graphics card (three-gpu-pathtracer). The current view keeps
// refining sample by sample; you can still orbit (it restarts), then save the picture.
// The model is shown in the Realistic look while rendering, lit by a sky dome plus the sun.
import * as THREE from 'three';
import { WebGLPathTracer, GradientEquirectTexture } from 'three-gpu-pathtracer';

export const LIGHTS = {
  day: { label: 'Day', note: 'Sun from the Sun panel, blue sky', top: 0x5e93d6, bottom: 0xe9eef2, env: 1.0, sun: 2.6, sunColor: 0xffffff },
  golden: { label: 'Golden hour', note: 'Low warm sun, soft sky', top: 0x6d86b8, bottom: 0xf3c9a0, env: 0.75, sun: 3.2, sunColor: 0xffb26b, low: true },
  overcast: { label: 'Overcast', note: 'Soft even light, no hard shadows', top: 0xc9d1d9, bottom: 0xeef1f4, env: 1.6, sun: 0, sunColor: 0xffffff },
};
export const QUALITY = { draft: { label: 'Draft', samples: 64 }, good: { label: 'Good', samples: 256 }, best: { label: 'Best', samples: 1024 } };
export const SIZES = { screen: { label: 'Screen', long: 0 }, hd: { label: 'Full HD', long: 1920 }, uhd: { label: '4K', long: 3840 } };

export class PhotoRender {
  constructor(app) {
    this.app = app;
    this.v = app.viewer;
    this.active = false;
    this.light = 'day';
    this.quality = 'good';
    this.size = 'screen';
    this.onCamera = () => { if (this.active && this.ready) { this.pt.updateCamera(); this.done = false; this.pt.pausePathTracing = false; } };
  }

  get samples() { return this.pt ? Math.floor(this.pt.samples) : 0; }
  get target() { return QUALITY[this.quality].samples; }

  async start() {
    const v = this.v, app = this.app;
    if (this.active) return;
    this.active = true;
    this.ready = false;
    this.done = false;
    v.select(null);
    // remember what the render changes
    this.saved = {
      style: v.style, env: v.scene.environment, envI: v.scene.environmentIntensity, bg: v.scene.background,
      sunColor: v.sun.color.clone(), sunI: v.sun.intensity, sunDir: v.sunDir.clone(), pr: v.renderer.getPixelRatio(),
      shadowPlane: v.ground.visible, tone: v.renderer.toneMapping, exposure: v.renderer.toneMappingExposure,
    };
    if (v.style !== 'realistic') v.setStyle('realistic');
    v.ground.visible = false;
    v.renderer.toneMapping = THREE.NeutralToneMapping;
    v.renderer.toneMappingExposure = app.look.state.exposure;
    this.applySize();
    if (!this.pt) {
      const pt = this.pt = new WebGLPathTracer(v.renderer);
      pt.tiles.set(2, 2);                 // keeps the page responsive between samples
      pt.bounces = 6;
      pt.transmissiveBounces = 6;
      pt.filterGlossyFactor = 0.5;
      pt.minSamples = 1;
      pt.renderDelay = 0;
      pt.fadeDuration = 250;
      pt.dynamicLowRes = true;
    }
    this.applyLight(false);
    v.renderOverride = () => this.frame();
    v.continuous++;
    v.controls.addEventListener('change', this.onCamera);
    this.onStatus?.('Preparing the scene for rendering...');
    this.onBusy?.(true);
    await new Promise(r => setTimeout(r, 60));      // let the "preparing" screen paint
    const t0 = performance.now();
    try {
      this.pt.setScene(v.scene, v.camera);           // builds the ray-tracing structure: a few seconds
    } finally { this.onBusy?.(false); }
    this.prepSeconds = (performance.now() - t0) / 1000;
    if (!this.active) return;
    this.ready = true;
    this.onStatus?.(null);
  }

  frame() {
    const pt = this.pt, v = this.v;
    if (!this.ready) { v.renderer.render(v.scene, v.camera); return; }
    if (this.samples >= this.target && !this.done) {
      this.done = true;
      pt.pausePathTracing = true;
      this.onDone?.();
    }
    pt.renderSample();
  }

  // light preset: sky dome colours, sun strength, colour and (golden hour) a low western sun
  applyLight(restart = true) {
    const v = this.v, L = LIGHTS[this.light];
    if (!this.sky) this.sky = new GradientEquirectTexture(64);
    this.sky.topColor.set(L.top);
    this.sky.bottomColor.set(L.bottom);
    this.sky.update();
    v.scene.environment = this.sky;
    v.scene.background = this.sky;
    v.scene.environmentIntensity = L.env;
    v.sun.color.set(L.sunColor);
    if (L.low) {
      const d = this.saved.sunDir.clone();
      d.y = 0;
      if (d.lengthSq() < 1e-6) d.set(1, 0, 0);
      d.normalize().multiplyScalar(Math.cos(0.15)).setY(Math.sin(0.15));   // about 9 degrees up
      v.setSunDir(d);
    } else v.setSunDir(this.saved.sunDir);
    v.sun.intensity = L.sun * (this.saved.sunI > 0 || L.low ? 1 : 0);
    if (restart && this.ready) { this.pt.updateEnvironment(); this.pt.updateLights(); this.restart(); }
  }

  applySize() {
    const v = this.v, w = v.canvas.clientWidth, h = v.canvas.clientHeight;
    const long = SIZES[this.size].long;
    const pr = long ? long / Math.max(w, h) : this.saved.pr;
    if (Math.abs(v.renderer.getPixelRatio() - pr) > 1e-3) v.setPixelRatio(pr);
  }

  setOption(key, value) {
    this[key] = value;
    if (!this.active) return;
    if (key === 'light') this.applyLight();
    if (key === 'size') { this.applySize(); this.restart(); }
    if (key === 'quality' && this.samples < this.target) { this.done = false; this.pt.pausePathTracing = false; }
  }

  restart() {
    this.done = false;
    this.pt.pausePathTracing = false;
    this.pt.reset();
  }

  async save() {
    const v = this.v;
    this.frame();      // draw the latest samples, then read the canvas in the same task
    const blob = await new Promise(r => v.canvas.toBlob(r, 'image/png'));
    const name = `${(v.modelName || 'model').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_')}_render_${this.light}_${this.samples}spp.png`;
    return { blob, name };
  }

  stop() {
    if (!this.active) return;
    const v = this.v, s = this.saved;
    this.active = false;
    this.ready = false;
    v.renderOverride = null;
    v.continuous--;
    v.controls.removeEventListener('change', this.onCamera);
    if (this.pt) { this.pt.pausePathTracing = false; this.pt.reset(); }
    v.scene.environment = s.env;
    v.scene.environmentIntensity = s.envI;
    v.scene.background = s.bg;
    v.sun.color.copy(s.sunColor);
    v.setSunDir(s.sunDir);
    v.ground.visible = s.shadowPlane;
    v.renderer.toneMapping = s.tone;
    v.renderer.toneMappingExposure = s.exposure;
    if (v.style !== s.style) v.setStyle(s.style);
    v.setPixelRatio(s.pr);
    v.requestRender();
  }
}
