// Notes pinned to the model: text and an optional photo at a spot, saved on this device per model,
// with the view they were made from. Export / import as a small .json file to move them between
// phone and computer.
import * as THREE from 'three';

const PREFIX = 'mv:notes:';

export class Notes {
  constructor(app, layer) {
    this.app = app;
    this.v = app.viewer;
    this.layer = layer;
    this.list = [];
    this.visible = true;
    this.pins = new Map();
    this.v.afterRender.add(() => this.place());
  }

  get key() { return PREFIX + (this.v.meta?.title || this.v.modelName || 'model'); }

  load() {
    for (const el of this.pins.values()) el.remove();
    this.pins.clear();
    try { this.list = JSON.parse(localStorage.getItem(this.key)) || []; } catch { this.list = []; }
    this.list.forEach(n => this.pin(n));
    this.onChange?.();
  }

  save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.list)); return true; } catch { return false; }
  }

  add(point, text, photo) {
    const cam = this.v.camera, t = this.v.controls.target;
    const n = {
      id: Date.now().toString(36), at: point.toArray().map(x => +x.toFixed(3)), text, photo: photo || null,
      date: new Date().toISOString().slice(0, 16).replace('T', ' '),
      view: { pos: cam.position.toArray(), target: t.toArray(), fov: cam.fov },
    };
    this.list.push(n);
    this.pin(n);
    const ok = this.save();
    this.onChange?.();
    return ok;
  }

  update(id, text, photo) {
    const n = this.list.find(x => x.id === id);
    if (!n) return;
    n.text = text;
    if (photo !== undefined) n.photo = photo;
    this.pin(n);
    this.save();
    this.onChange?.();
  }

  remove(id) {
    this.list = this.list.filter(x => x.id !== id);
    this.pins.get(id)?.remove();
    this.pins.delete(id);
    this.renumber();
    this.save();
    this.onChange?.();
  }

  pin(n) {
    let el = this.pins.get(n.id);
    if (!el) {
      el = document.createElement('button');
      el.className = 'pin';
      el.onclick = e => { e.stopPropagation(); this.onOpen?.(n.id); };
      this.layer.appendChild(el);
      this.pins.set(n.id, el);
    }
    el.title = n.text;
    el.classList.toggle('photo', !!n.photo);
    this.renumber();
    this.v.requestRender();
  }

  renumber() {
    this.list.forEach((n, i) => { const el = this.pins.get(n.id); if (el) el.textContent = i + 1; });
  }

  place() {
    for (const n of this.list) {
      const el = this.pins.get(n.id);
      if (!el) continue;
      const s = this.v.toScreen(new THREE.Vector3().fromArray(n.at));
      el.style.display = this.visible && !s.behind ? '' : 'none';
      el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%)`;
    }
  }

  setVisible(on) { this.visible = on; this.v.requestRender(); }

  go(id) {
    const n = this.list.find(x => x.id === id);
    if (n) this.v.flyTo(new THREE.Vector3().fromArray(n.view.pos), new THREE.Vector3().fromArray(n.view.target), n.view.fov);
  }

  exportFile() {
    const data = { format: 'mv-notes/1', model: this.v.meta?.title || this.v.modelName, notes: this.list };
    return { blob: new Blob([JSON.stringify(data)], { type: 'application/json' }),
             name: `${String(data.model).replace(/\.(skp|glb|gltf|dae)$/i, '').replace(/[^\w.-]+/g, '_')}_notes.json` };
  }

  // merge notes from a file (same ids are replaced)
  importData(data) {
    if (data?.format !== 'mv-notes/1') throw new Error('Not a notes file');
    for (const n of data.notes) {
      const i = this.list.findIndex(x => x.id === n.id);
      if (i >= 0) this.list[i] = n; else this.list.push(n);
      this.pin(n);
    }
    this.save();
    this.onChange?.();
    return data.notes.length;
  }
}

// a photo made small enough to keep many on the device (long side 900 px, JPEG)
export function shrinkPhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 900 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.78));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
