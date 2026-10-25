// Screenshot and screen recording of the 3D view, then save (download) or share (iPhone: Save to Photos).
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
const safe = s => (s || 'model').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');

export async function screenshot(viewer, scale = 1) {
  const r = viewer.renderer;
  const pr = r.getPixelRatio();
  const w = viewer.canvas.clientWidth, h = viewer.canvas.clientHeight;
  const target = Math.min(pr * scale, 4096 / Math.max(w, h));
  if (target !== pr) r.setPixelRatio(target);
  viewer.render();
  const blob = await new Promise(res => viewer.canvas.toBlob(res, 'image/png'));
  if (target !== pr) { r.setPixelRatio(pr); viewer.resize(); viewer.render(); }
  return { blob, name: `${safe(viewer.modelName)}_${stamp()}.png` };
}

export class Recorder {
  constructor(viewer) {
    this.v = viewer;
    this.rec = null;
  }

  static mime() {
    if (!window.MediaRecorder) return null;
    for (const m of ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4',
                     'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return null;
  }

  get active() { return !!this.rec; }

  // overlay: () => ({ title, line2, progress }) or null, drawn onto every frame (captions survive in the video)
  start(overlay = null) {
    const mime = Recorder.mime();
    const gl = this.v.canvas;
    if (!mime || !gl.captureStream) throw new Error('This browser cannot record video. Use the phone\'s own screen recorder.');
    // compose into a 2D canvas (even size, as video encoders want), right after each render
    const out = this.out = document.createElement('canvas');
    out.width = gl.width & ~1;
    out.height = gl.height & ~1;
    const ctx = out.getContext('2d');
    this.draw = () => {
      ctx.drawImage(gl, 0, 0);
      const o = overlay?.();
      if (o) drawCaption(ctx, out.width, out.height, o);
    };
    this.v.afterRender.add(this.draw);
    const stream = out.captureStream(30);
    this.chunks = [];
    this.mimeType = mime;
    this.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
    this.rec.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
    this.v.continuous++;
    this.t0 = performance.now();
    this.rec.start(1000);
  }

  stop() {
    return new Promise(resolve => {
      const rec = this.rec;
      rec.onstop = () => {
        const type = this.mimeType.split(';')[0];
        const blob = new Blob(this.chunks, { type });
        const ext = type === 'video/mp4' ? 'mp4' : 'webm';
        resolve({ blob, name: `${safe(this.v.modelName)}_${stamp()}.${ext}` });
      };
      rec.stop();
      rec.stream.getTracks().forEach(t => t.stop());
      this.v.afterRender.delete(this.draw);
      this.rec = null;
      this.v.continuous--;
    });
  }

  get seconds() { return this.rec ? (performance.now() - this.t0) / 1000 : 0; }
}

// caption box bottom-left (English + Myanmar line), progress bar along the bottom
export function drawCaption(ctx, w, h, { title, line2, progress }) {
  const s = Math.min(w, h) / 360;
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Myanmar", "Myanmar Text", "Myanmar Sangam MN", sans-serif';
  const pad = 10 * s, x = 14 * s;
  ctx.save();
  ctx.font = `600 ${15 * s}px ${font}`;
  const w1 = title ? ctx.measureText(title).width : 0;
  ctx.font = `400 ${13 * s}px ${font}`;
  const w2 = line2 ? ctx.measureText(line2).width : 0;
  const bw = Math.max(w1, w2) + 2 * pad, bh = (line2 ? 50 : 30) * s;
  const y = h - bh - 22 * s;
  if (title || line2) {
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bh, 8 * s);
    ctx.fill();
    ctx.fillStyle = '#1f262d';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${15 * s}px ${font}`;
    ctx.fillText(title || '', x + pad, y + 15 * s);
    if (line2) {
      ctx.font = `400 ${13 * s}px ${font}`;
      ctx.fillStyle = '#5b6570';
      ctx.fillText(line2, x + pad, y + 35 * s);
    }
  }
  if (progress != null) {
    ctx.fillStyle = 'rgba(31,38,45,0.15)';
    ctx.fillRect(0, h - 5 * s, w, 5 * s);
    ctx.fillStyle = '#e8590c';
    ctx.fillRect(0, h - 5 * s, w * Math.max(0, Math.min(1, progress)), 5 * s);
  }
  ctx.restore();
}

// dialog with preview + Save / Share
export function showSave(dlg, { blob, name }) {
  const isVideo = blob.type.startsWith('video');
  const url = URL.createObjectURL(blob);
  const prev = dlg.querySelector('.preview');
  prev.innerHTML = isVideo ? `<video src="${url}" controls playsinline muted loop autoplay></video>` : `<img src="${url}" alt="">`;
  dlg.querySelector('.fname').textContent = `${name} · ${(blob.size / 1048576).toFixed(1)} MB`;
  const file = new File([blob], name, { type: blob.type });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  const share = dlg.querySelector('[data-act=share]');
  const save = dlg.querySelector('[data-act=save]');
  share.hidden = !canShare;
  share.textContent = IOS ? (isVideo ? 'Save Video / Share' : 'Save to Photos / Share') : 'Share';
  save.textContent = IOS ? 'Save to Files' : 'Save to phone';
  dlg.querySelector('.hint').textContent = IOS && !canShare && !isVideo ? 'Touch and hold the picture, then Save to Photos.' : '';
  share.onclick = async () => {
    try { await navigator.share({ files: [file], title: name }); } catch (e) { if (e.name !== 'AbortError') alert(e.message); }
  };
  save.onclick = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  dlg.querySelector('[data-act=close]').onclick = () => {
    dlg.hidden = true;
    prev.innerHTML = '';
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  dlg.hidden = false;
}
