// Model Viewer client links (Supabase Edge Function "mv-share").
// The owner (the architect) proves herself with an owner code she chose in the app: only a PBKDF2 hash is kept.
// A client link carries a share id and a long random token: only its SHA-256 is kept. Files sit in the private
// bucket "mv-shares"; uploads and downloads go through short-lived signed URLs, so no key is ever in the app.
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const BUCKET = "mv-shares";
const MAX_FILE = 50 * 1024 * 1024;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

async function pbkdf2(code: string, salt: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 100_000, hash: "SHA-256" }, key, 256));
}

class Fail extends Error {
  constructor(msg: string, public status = 400) { super(msg); }
}

// at most 10 wrong codes / tokens in 15 minutes, for everyone together
async function guard() {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { count } = await db.from("mv_fails").select("*", { count: "exact", head: true }).gte("at", since);
  if ((count ?? 0) >= 10) throw new Fail("Too many wrong tries. Wait 15 minutes.", 429);
}
async function failed(msg: string, status = 403): Promise<never> {
  await db.from("mv_fails").insert({});
  throw new Fail(msg, status);
}

async function owner(code: unknown) {
  await guard();
  const { data } = await db.from("mv_owner").select("salt, hash").eq("id", 1).maybeSingle();
  if (!data) throw new Fail("No owner code set yet.", 409);
  if (typeof code !== "string" || (await pbkdf2(code, data.salt)) !== data.hash) await failed("Wrong owner code.");
}

const safeName = (s: string) => s.replace(/[^\w.\- ]+/g, "_").slice(0, 120);

// expired or withdrawn links: files go, the row stays (the owner still sees it in the list)
async function sweep() {
  const { data } = await db.from("mv_shares").select("id, files")
    .or(`expires_at.lt.${new Date().toISOString()},revoked.eq.true`).neq("files", "[]");
  for (const s of data ?? []) {
    const paths = (s.files as { name: string }[]).map((f) => `${s.id}/${f.name}`);
    if (paths.length) await db.storage.from(BUCKET).remove(paths);
    await db.from("mv_shares").update({ files: [] }).eq("id", s.id);
  }
}

async function handle(b: Record<string, unknown>) {
  switch (b.action) {
    case "status": {
      const { data } = await db.from("mv_owner").select("id").eq("id", 1).maybeSingle();
      return { claimed: !!data };
    }
    // the very first owner code becomes the owner code
    case "claim": {
      const code = String(b.code ?? "");
      if (code.length < 8) throw new Fail("The owner code needs at least 8 characters.");
      const salt = b64url(random(16));
      const { error } = await db.from("mv_owner").insert({ id: 1, salt, hash: await pbkdf2(code, salt) });
      if (error) throw new Fail("An owner code is already set.", 409);
      return { ok: true };
    }
    case "check":
      await owner(b.code);
      return { ok: true };
    case "create": {
      await owner(b.code);
      await sweep();
      const files = (b.files as { name: string; size: number }[] ?? []).map((f) => ({ name: safeName(String(f.name)), size: +f.size || 0 }));
      if (!files.length || !b.model) throw new Fail("Nothing to share.");
      const big = files.find((f) => f.size > MAX_FILE);
      if (big) throw new Fail(`${big.name} is over 50 MB, the limit for one file.`);
      const days = Math.min(365, Math.max(1, +(b.days ?? 30) || 30));
      const id = b64url(random(9));
      const token = b64url(random(24));
      const row = {
        id, token_hash: await sha256(token), title: String(b.title || b.model).slice(0, 200), model: safeName(String(b.model)),
        files, bytes: files.reduce((a, f) => a + f.size, 0), expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
      };
      const { error } = await db.from("mv_shares").insert(row);
      if (error) throw new Fail(error.message, 500);
      const uploads = [];
      for (const f of files) {
        const { data, error: e } = await db.storage.from(BUCKET).createSignedUploadUrl(`${id}/${f.name}`);
        if (e) throw new Fail(e.message, 500);
        uploads.push({ name: f.name, url: data.signedUrl });
      }
      return { id, token, expires: row.expires_at, uploads };
    }
    case "finish": {
      await owner(b.code);
      const id = String(b.id);
      const { data: s } = await db.from("mv_shares").select("files").eq("id", id).maybeSingle();
      if (!s) throw new Fail("Unknown link.", 404);
      const { data: list } = await db.storage.from(BUCKET).list(id, { limit: 100 });
      const have = new Set((list ?? []).map((o) => o.name));
      const missing = (s.files as { name: string }[]).filter((f) => !have.has(f.name));
      if (missing.length) throw new Fail(`Upload incomplete: ${missing.map((f) => f.name).join(", ")}`);
      await db.from("mv_shares").update({ ready: true }).eq("id", id);
      return { ok: true };
    }
    case "list": {
      await owner(b.code);
      await sweep();
      const { data } = await db.from("mv_shares")
        .select("id, title, model, bytes, ready, revoked, views, last_view, created_at, expires_at")
        .order("created_at", { ascending: false }).limit(100);
      return { shares: data ?? [] };
    }
    case "revoke": {
      await owner(b.code);
      await db.from("mv_shares").update({ revoked: true }).eq("id", String(b.id));
      await sweep();
      return { ok: true };
    }
    // the client's side: id + token in, short-lived download links out
    case "open": {
      await guard();
      const { data: s } = await db.from("mv_shares").select("*").eq("id", String(b.id ?? "")).maybeSingle();
      if (!s || (await sha256(String(b.token ?? ""))) !== s.token_hash) await failed("This link is not valid.", 404);
      if (s.revoked) throw new Fail("This link was withdrawn by the architect.", 410);
      if (new Date(s.expires_at) < new Date()) throw new Fail("This link has expired. Ask the architect for a new one.", 410);
      if (!s.ready) throw new Fail("This link is not finished yet.", 409);
      const files = [];
      for (const f of s.files as { name: string; size: number }[]) {
        const { data, error } = await db.storage.from(BUCKET).createSignedUrl(`${s.id}/${f.name}`, 2 * 3600);
        if (error) throw new Fail(error.message, 500);
        files.push({ name: f.name, size: f.size, url: data.signedUrl });
      }
      await db.from("mv_shares").update({ views: s.views + 1, last_view: new Date().toISOString() }).eq("id", s.id);
      return { title: s.title, model: s.model, expires: s.expires_at, files };
    }
  }
  throw new Fail("Unknown action.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  let status = 200, out: unknown;
  try {
    if (req.method !== "POST") throw new Fail("POST only.", 405);
    out = await handle(await req.json());
  } catch (e) {
    status = e instanceof Fail ? e.status : 500;
    out = { error: e instanceof Error ? e.message : String(e) };
  }
  return new Response(JSON.stringify(out), { status, headers: { ...CORS, "Content-Type": "application/json" } });
});
