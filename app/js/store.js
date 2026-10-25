// Recent models (kept on the phone in IndexedDB, so they open offline) and small per-model settings.
const DB = 'modelviewer', STORE = 'recent', KEEP = 6;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

// files: [{ name, blob }]; the first one is the model, the rest are its textures / .bin / sidecar
export async function saveRecent(files) {
  try {
    const db = await open();
    const entry = { name: files[0].name, date: Date.now(), size: files.reduce((s, f) => s + f.blob.size, 0),
                    files: files.map(f => ({ name: f.name, blob: f.blob })) };
    await tx(db, 'readwrite', s => s.put(entry));
    const all = await listRecent();
    for (const old of all.slice(KEEP)) await tx(db, 'readwrite', s => s.delete(old.name));
  } catch (e) { console.warn('Could not keep the model on the phone', e); }
}

export async function listRecent() {
  try {
    const db = await open();
    const all = await tx(db, 'readonly', s => s.getAll());
    return (all || []).sort((a, b) => b.date - a.date);
  } catch { return []; }
}

export async function getRecent(name) {
  const db = await open();
  return tx(db, 'readonly', s => s.get(name));
}

export async function deleteRecent(name) {
  const db = await open();
  return tx(db, 'readwrite', s => s.delete(name));
}

export function getSetting(model, key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(`mv:${model}:${key}`));
    return v ?? fallback;
  } catch { return fallback; }
}

export function setSetting(model, key, value) {
  try { localStorage.setItem(`mv:${model}:${key}`, JSON.stringify(value)); } catch { /* private mode */ }
}
