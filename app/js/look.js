// Looks: render style + lighting, background, ground, ambient occlusion, exposure.
// Each style brings sensible defaults; changes you make on top are remembered on this device.
export const STYLES = {
  presentation: {
    label: 'Presentation', note: 'Sky light, reflective glass, soft ground shadow, outlines, straight verticals',
    edges: [0x4a5058, 0.32], light: { hemi: 0.5, sun: 2.3 }, env: 0.8, envKind: 'sky', tone: true, bg: 'gradient', ground: 'none',
    ao: 'always', shadows: true, contact: true, profile: true, fog: true, vignette: true, twoPoint: true,
  },
  technical: {
    label: 'Technical', note: 'Model colours with crisp edge lines (BuildLapse look)',
    edges: [0x2c3238, 0.6], light: { hemi: 1.9, sun: 1.5 }, env: 0, tone: false, bg: 'light', ground: 'none', ao: false,
  },
  shaded: {
    label: 'Shaded', note: 'Model colours, no lines, soft corners',
    edges: null, light: { hemi: 1.8, sun: 1.6 }, env: 0, tone: false, bg: 'light', ground: 'none', ao: true,
  },
  clay: {
    label: 'White model', note: 'Architectural white model with soft shadows in the corners',
    edges: [0x6b7076, 0.35], light: { hemi: 1.6, sun: 1.5 }, env: 0, tone: false, bg: 'white', ground: 'none', ao: true,
  },
  sketch: {
    label: 'Sketch', note: 'Black lines on white paper, like a drawing',
    edges: [0x111418, 0.9], light: { hemi: 1.9, sun: 1.5 }, env: 0, tone: false, bg: 'white', ground: 'none', ao: false,
  },
  realistic: {
    label: 'Realistic', note: 'Materials and textures, sky light, sun shadows, grass',
    edges: null, light: { hemi: 0.45, sun: 2.6 }, env: 0.85, tone: true, bg: 'sky', ground: 'grass', ao: true, shadows: true,
  },
};
// colour strength on top of any style: saturation of the model colours, and the balance between the even sky
// light (flat) and the sun (light and shade, so faces stand apart)
export const COLOURS = {
  soft: { label: 'Soft', sat: 0.85, hemi: 1.1, sun: 0.8 },
  natural: { label: 'Natural', sat: 1, hemi: 1, sun: 1 },
  vivid: { label: 'Vivid', sat: 1.35, hemi: 0.6, sun: 1.5 },
};
export const BACKGROUNDS = { gradient: 'Soft', light: 'Light grey', white: 'White', sky: 'Sky', dark: 'Dark' };
export const GROUNDS = { none: 'None', grass: 'Grass', paving: 'Paving' };

const KEY = 'mv:look';
const DESKTOP = matchMedia('(hover: hover) and (pointer: fine)').matches;

export class Look {
  constructor(app) {
    this.app = app;
    this.v = app.viewer;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* private mode */ }
    // own choices on top of the style: null = the style's default
    this.state = { style: 'technical', bg: null, ground: null, ao: null, edges: null, exposure: 1, colours: 'vivid',
      contact: null, twoPoint: null, joints: false, ...saved };
    if (!STYLES[this.state.style]) this.state.style = 'technical';
    if (!COLOURS[this.state.colours]) this.state.colours = 'vivid';
  }

  get colours() { return COLOURS[this.state.colours]; }

  // the style's light levels with the colour strength on top
  lightLevels() {
    const l = this.style.light, c = this.colours;
    return { hemi: l.hemi * c.hemi, sun: l.sun * c.sun };
  }

  get style() { return STYLES[this.state.style]; }
  // ambient occlusion costs a lot on phones: on by default only on computers
  // (Presentation: on phones too, since there it is drawn only when the view rests)
  get ao() { return this.state.ao ?? (this.style.ao === 'always' || (this.style.ao && DESKTOP)); }
  get contact() { return this.state.contact ?? !!this.style.contact; }
  get twoPoint() { return this.state.twoPoint ?? !!this.style.twoPoint; }
  get bg() { return this.state.bg ?? this.style.bg; }
  get ground() { return this.state.ground ?? this.style.ground; }
  get edges() { return this.state.edges ?? !!this.style.edges; }

  save() { try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch { /* private mode */ } }

  // full apply (start-up, style change)
  apply() {
    const v = this.v, s = this.style;
    v.saturation = this.colours.sat;
    v.setStyle(this.state.style);
    if (s.edges) v.setEdgeLook(s.edges[0], s.edges[1]);
    v.setEdges(this.edges);
    v.setLightLevels(this.lightLevels());
    v.setEnvironment(s.env, s.envKind);
    v.setToneMapping(s.tone, this.state.exposure);
    v.setBackground(this.bg);
    v.setGround(this.ground);
    v.setAO(this.ao);
    v.setProfile(!!s.profile);
    v.setPresentation({ contact: this.contact, fog: !!s.fog, vignette: !!s.vignette });
    v.setTwoPoint(this.twoPoint);
    v.setJoints(!!this.state.joints);
    document.body.classList.toggle('dark', this.bg === 'dark');
  }

  setStyle(name) {
    this.state = { ...this.state, style: name, bg: null, ground: null, ao: null, edges: null, contact: null, twoPoint: null };
    this.apply();
    // Realistic comes with sun shadows; the others keep what the Sun panel has
    if (STYLES[name].shadows) {
      const S = this.app.panels.sunState;
      if (S && !S.shadows) { S.shadows = true; this.v.setShadows(true); this.app.panels.applySun(); }
    }
    this.save();
  }

  set(key, value) {
    this.state[key] = value;
    const v = this.v;
    if (key === 'bg') { v.setBackground(value); document.body.classList.toggle('dark', value === 'dark'); }
    if (key === 'ground') v.setGround(value);
    if (key === 'ao') v.setAO(value);
    if (key === 'edges') v.setEdges(value);
    if (key === 'exposure') v.setToneMapping(this.style.tone, value);
    if (key === 'contact') v.contact.setEnabled(value);
    if (key === 'twoPoint') v.setTwoPoint(value);
    if (key === 'joints') v.setJoints(value);
    if (key === 'colours') {
      v.saturation = this.colours.sat;
      v.setStyle(this.state.style);        // rebuilds the materials with the new saturation
      v.setLightLevels(this.lightLevels());
    }
    this.save();
  }
}
