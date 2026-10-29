// Client links: a view-only copy of the open model for a client, on Lucie's Supabase (private bucket, see
// supabase/functions/mv-share). Lucie proves herself with her owner code (kept on her devices only);
// each link is https://ururinfo-collab.github.io/modelviewer/#view=<id>.<secret> and expires.
// The client gets the model, the notes Lucie chose (read-only) and the build order.

import { getRecent } from './store.js';

const FN = 'https://zjlbcltvpbfzraixlugm.supabase.co/functions/v1/mv-share';
const PUBLIC_URL = 'https://ururinfo-collab.github.io/modelviewer/';
const CODE_KEY = 'mv:share:code', LINKS_KEY = 'mv:share:links';

// the same file-name cleaning the server does
export const safeName = s => String(s).replace(/[^\w.\- ]+/g, '_').slice(0, 120);

async function call(action, body = {}) {
  let r;
  try {
    r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body }) });
  } catch { throw new Error('No connection to the share service. Check the internet connection.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw Object.assign(new Error(j.error || `Share service error ${r.status}`), { status: r.status });
  return j;
}

// PUT a file to a signed upload URL, with progress
function upload(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    x.setRequestHeader('x-upsert', 'true');
    x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded);
    x.onload = () => (x.status < 300 ? resolve() : reject(new Error(`Upload failed (${x.status}): ${x.responseText.slice(0, 200)}`)));
    x.onerror = () => reject(new Error('Upload failed: the connection dropped. Check the internet connection and try again.'));
    x.send(blob);
  });
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

export class Share {
  constructor(app) {
    this.app = app;
    this.claimed = null;      // is an owner code set on the server (null: not asked yet)
    this.shares = null;       // the owner's links, from the server
  }

  get code() { return store.get(CODE_KEY, ''); }
  set code(c) { if (c) store.set(CODE_KEY, c); else { try { localStorage.removeItem(CODE_KEY); } catch { /* */ } } }

  // links made on this device, so they can be copied again (the server keeps only a fingerprint of the secret)
  get links() { return store.get(LINKS_KEY, {}); }

  async status() { this.claimed = (await call('status')).claimed; return this.claimed; }

  // first time: the code becomes the owner code; later: it must match
  async signIn(code) {
    if (this.claimed === null) await this.status();
    if (this.claimed) await call('check', { code });
    else { await call('claim', { code }); this.claimed = true; }
    this.code = code;
  }

  async list() {
    try { this.shares = (await call('list', { code: this.code })).shares; }
    catch (e) { if (e.status === 403) this.code = ''; throw e; }
    return this.shares;
  }

  async revoke(id) {
    await call('revoke', { code: this.code, id });
    const l = this.links; delete l[id]; store.set(LINKS_KEY, l);
  }

  // The model's bytes, read now. A file picked on a phone (Files, WhatsApp, Drive) is often readable only for a
  // while after it was opened; the copy the app keeps of every opened model (recent list) always is.
  async readable(src) {
    const out = [];
    let kept = null;
    for (const f of src) {
      try { out.push({ name: f.name, blob: new Blob([await f.blob.arrayBuffer()], { type: f.blob.type }) }); continue; }
      catch { /* the original cannot be read any more */ }
      if (kept === null) { try { kept = (await getRecent(src[0].name))?.files || []; } catch { kept = []; } }
      const copy = kept.find(k => k.name === f.name);
      if (!copy) throw new Error(`Cannot read ${f.name} any more. Open the model again (Open › On this phone) and share again.`);
      out.push({ name: f.name, blob: new Blob([await copy.blob.arrayBuffer()], { type: copy.blob.type }) });
    }
    return out;
  }

  // the files of a link: the open model, the build order, and share.json (title, notes, colours)
  async pack(opts, onProgress) {
    const app = this.app, src = app.sourceFiles;
    if (!src?.length) throw new Error('Open the model from a file first (a model opened from a link cannot be shared again).');
    onProgress(0, 'Reading the model...');
    const files = (await this.readable(src)).map(f => ({ name: safeName(f.name), blob: f.blob }));
    const model = files[0].name;
    if (opts.order) {
      files.push({ name: `${model.replace(/\.[^.]+$/, '')}.sequence.json`,
        blob: new Blob([JSON.stringify(opts.order)], { type: 'application/json' }) });
    }
    const manifest = { format: 'mv-share/1', title: opts.title, model, created: new Date().toISOString(),
      notes: opts.notes ? app.notes.list : [], colours: app.colours?.data };
    files.push({ name: 'share.json', blob: new Blob([JSON.stringify(manifest)], { type: 'application/json' }) });
    return { files, model };
  }

  async send(files, uploads, onProgress) {
    const total = files.reduce((a, f) => a + f.blob.size, 0);
    let done = 0;
    for (const f of files) {
      const u = uploads.find(x => x.name === f.name);
      // one retry: phone connections drop now and then
      await upload(u.url, f.blob, n => onProgress((done + n) / total, `Uploading ${f.name}...`))
        .catch(() => upload(u.url, f.blob, n => onProgress((done + n) / total, `Uploading ${f.name} (again)...`)));
      done += f.blob.size;
    }
  }

  // opts: { title, days (0 = no expiry), notes (bool), order (sequence or null) }
  async create(opts, onProgress = () => {}) {
    const { files, model } = await this.pack(opts, onProgress);
    onProgress(0, 'Preparing the link...');
    const res = await call('create', { code: this.code, title: opts.title, days: opts.days, model,
      files: files.map(f => ({ name: f.name, size: f.blob.size })) });
    try {
      await this.send(files, res.uploads, onProgress);
      await call('finish', { code: this.code, id: res.id });
    } catch (e) {
      call('discard', { code: this.code, id: res.id }).catch(() => {});   // no half-made link left behind
      throw e;
    }
    const link = `${PUBLIC_URL}#view=${res.id}.${res.token}`;
    store.set(LINKS_KEY, { ...this.links, [res.id]: link });
    onProgress(1, 'Done');
    return { id: res.id, link, expires: res.expires };
  }

  // Put the open model into an existing link: same address (a QR code on the drawings keeps working), same expiry.
  async replace(id, opts, onProgress = () => {}) {
    const { files, model } = await this.pack(opts, onProgress);
    onProgress(0, 'Preparing the update...');
    const res = await call('replace', { code: this.code, id, title: opts.title, model,
      files: files.map(f => ({ name: f.name, size: f.blob.size })) });
    await this.send(files, res.uploads, onProgress);
    await call('finish', { code: this.code, id });
    onProgress(1, 'Done');
  }

  // the client's side
  static fromHash() {
    const m = /[#&]view=([\w-]+)\.([\w-]+)/.exec(location.hash);
    return m ? { id: m[1], token: m[2] } : null;
  }

  async open(id, token, onProgress = () => {}) {
    const s = await call('open', { id, token });
    const total = s.files.reduce((a, f) => a + f.size, 0) || 1;
    let done = 0;
    const files = [];
    for (const f of s.files) {
      const r = await fetch(f.url);
      if (!r.ok) throw new Error(`Download failed (${r.status})`);
      const reader = r.body.getReader(), parts = [];
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        parts.push(value);
        done += value.length;
        onProgress(done / total);
      }
      files.push({ name: f.name, blob: new Blob(parts) });
    }
    const mf = files.find(f => f.name === 'share.json');
    const manifest = mf ? JSON.parse(await mf.blob.text()) : { title: s.title, notes: [] };
    const model = files.find(f => f.name === s.model);
    return { title: s.title, expires: s.expires, manifest,
      files: [model, ...files.filter(f => f !== model && f !== mf)] };
  }
}
