"""Wi-Fi server: the phone opens http://<this PC>:8765 and gets the viewer plus the exported models.

  /                  the app (ModelViewer/app)
  /models/index.json list of models in ModelViewer/exports (newest first)
  /models/<file>     a model
  /ai/...            AI render on this PC's GPU through SketchRender's local engine (ComfyUI)

Run:  python tools/serve.py  [--port 8765] [--exports <folder>] [--comfy <ComfyUI_windows_portable folder>]
Windows asks once to allow Python on the network: tick Private networks.
"""
import argparse
import base64
import functools
import json
import os
import random
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
MODEL_EXT = {".skp", ".glb", ".gltf", ".dae", ".bin", ".json", ".png", ".jpg", ".jpeg"}


# ---- AI render: SketchRender's local engine (ComfyUI portable, SDXL RealVisXL + ControlNet Union) ----
# Same workflow as SketchRender's comfy.rb: img2img from the view, depth + line ControlNets hold the
# geometry, a change mask from the ground-less depth pass lets sky / ground / void be repainted freely.

COMFY_URL = "http://127.0.0.1:8188"
CHECKPOINT = "RealVisXL_V5.0_fp16.safetensors"
CONTROLNET = "controlnet_union_sdxl_promax.safetensors"
FREEDOM = {"low": 0.62, "medium": 0.75, "high": 0.88}
PASSES = ("view", "depth", "lines", "void")


class Comfy:
    def __init__(self, folder):
        self.dir = Path(folder)
        self.jobs = {}
        self.lock = threading.Lock()

    @property
    def python(self):
        return self.dir / "python_embeded" / "python.exe"

    def installed(self):
        m = self.dir / "ComfyUI" / "models"
        return self.python.is_file() and (m / "checkpoints" / CHECKPOINT).is_file() and (m / "controlnet" / CONTROLNET).is_file()

    def call(self, path, body=None, timeout=10):
        req = urllib.request.Request(COMFY_URL + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"null")

    def running(self):
        try:
            self.call("/system_stats", timeout=2)
            return True
        except (OSError, ValueError):
            return False

    # same minimised window SketchRender opens, so either app reuses the loaded model
    def launch(self):
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 7                                  # minimised, keeps focus where it is
        # one string, as cmd.exe wants it: a list would get \" escapes that cmd does not understand
        cmd = f'cmd /c "title SketchRender local engine && "{self.python}" -s ComfyUI\\main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch"'
        subprocess.Popen(cmd, cwd=str(self.dir), startupinfo=si, creationflags=subprocess.CREATE_NEW_CONSOLE)

    def start(self, data):
        jid = f"{int(time.time() * 1000):x}{random.randrange(1 << 16):04x}"
        self.jobs[jid] = {"state": "queued", "message": "Waiting for the local engine...", "t0": time.time()}
        threading.Thread(target=self.run, args=(jid, data), daemon=True).start()
        return jid

    def set(self, jid, **kw):
        self.jobs[jid].update(kw)

    def run(self, jid, data):
        try:
            with self.lock:                                 # one render at a time on the GPU
                if not self.running():
                    if not self.installed():
                        raise RuntimeError(f"SketchRender's local engine is not installed in {self.dir}.")
                    self.set(jid, state="starting", message="Starting the local engine on the PC (first time about a minute)...")
                    self.launch()
                    t = time.time()
                    while not self.running():
                        if time.time() - t > 240:
                            raise RuntimeError("The local engine did not start within 4 minutes. Run run_nvidia_gpu.bat in the ComfyUI folder to see why.")
                        time.sleep(2)
                names = self.stage(jid, data)
                self.set(jid, state="running", message="Rendering on the PC's graphics card...")
                res = self.call("/prompt", {"prompt": workflow(names, data), "client_id": "modelviewer"}, timeout=30)
                pid = res.get("prompt_id") if isinstance(res, dict) else None
                if not pid:
                    raise RuntimeError(f"The local engine refused the job: {json.dumps(res)[:300]}")
                self.set(jid, prompt=pid)
                while True:
                    time.sleep(1.5)
                    if self.jobs[jid].get("state") == "cancelled":
                        return
                    h = self.call(f"/history/{pid}")
                    if isinstance(h, dict) and pid in h:
                        self.collect(jid, h[pid])
                        return
        except urllib.error.HTTPError as e:
            self.set(jid, state="error", message=f"Local engine error {e.code}: {e.read()[:300].decode('utf-8', 'replace')}")
        except Exception as e:                              # noqa: BLE001 - reported to the phone
            self.set(jid, state="error", message=str(e))
        finally:
            for k in PASSES:
                try:
                    (self.dir / "ComfyUI" / "input" / f"mv_{jid}_{k}.png").unlink()
                except OSError:
                    pass

    # LoadImage only lists files at the top of ComfyUI's input folder
    def stage(self, jid, data):
        inp = self.dir / "ComfyUI" / "input"
        inp.mkdir(parents=True, exist_ok=True)
        names = {}
        for k in PASSES:
            b64 = data[k].split(",", 1)[-1]
            names[k] = f"mv_{jid}_{k}.png"
            (inp / names[k]).write_bytes(base64.b64decode(b64))
        return names

    def collect(self, jid, entry):
        st = entry.get("status") or {}
        if st.get("status_str") == "error":
            msg = next((m[1].get("exception_message") for m in st.get("messages", []) if isinstance(m[1], dict) and m[1].get("exception_message")), None)
            return self.set(jid, state="error", message=f"Local render failed: {msg or 'see the local engine window on the PC'}")
        imgs = ((entry.get("outputs") or {}).get("save") or {}).get("images") or []
        if not imgs:
            return self.set(jid, state="error", message="The local render finished without an image.")
        f = self.dir / "ComfyUI" / "output" / imgs[0].get("subfolder", "") / imgs[0]["filename"]
        self.set(jid, state="done", message="Done", file=str(f), seconds=round(time.time() - self.jobs[jid]["t0"]))

    def cancel(self, jid):
        job = self.jobs.get(jid)
        if job and job.get("state") not in ("done", "error"):
            job["state"] = "cancelled"
            try:
                self.call("/interrupt", {})
            except OSError:
                pass


def node(kind, **inputs):
    return {"class_type": kind, "inputs": inputs}


def workflow(names, d):
    w, h = int(d["width"]), int(d["height"])
    denoise = FREEDOM.get(d.get("freedom"), FREEDOM["medium"])
    seed = random.randrange(2 ** 31)
    scale = lambda img: node("ImageScale", image=img, upscale_method="lanczos", width=w, height=h, crop="disabled")  # noqa: E731
    wf = {
        "ckpt": node("CheckpointLoaderSimple", ckpt_name=CHECKPOINT),
        "pos": node("CLIPTextEncode", text=d["prompt"], clip=["ckpt", 1]),
        "neg": node("CLIPTextEncode", text=d["negative"], clip=["ckpt", 1]),
        "viewL": node("LoadImage", image=names["view"]),
        "depthL": node("LoadImage", image=names["depth"]),
        "linesL": node("LoadImage", image=names["lines"]),
        "view": scale(["viewL", 0]),
        "depthS": scale(["depthL", 0]),
        "linesS": scale(["linesL", 0]),
        "depth": node("ImageInvert", image=["depthS", 0]),       # near = white
        "lines": node("ImageInvert", image=["linesS", 0]),       # white lines on black
        "cn": node("ControlNetLoader", control_net_name=CONTROLNET),
        "cnD": node("SetUnionControlNetType", control_net=["cn", 0], type="depth"),
        "cnL": node("SetUnionControlNetType", control_net=["cn", 0], type="canny/lineart/anime_lineart/mlsd"),
        "applyD": node("ControlNetApplyAdvanced", positive=["pos", 0], negative=["neg", 0], control_net=["cnD", 0],
                       image=["depth", 0], vae=["ckpt", 2], strength=0.65, start_percent=0.0, end_percent=0.9),
        "applyL": node("ControlNetApplyAdvanced", positive=["applyD", 0], negative=["applyD", 1], control_net=["cnL", 0],
                       image=["lines", 0], vae=["ckpt", 2], strength=0.5, start_percent=0.0, end_percent=0.6),
        "voidL": node("LoadImage", image=names["void"]),
        "voidS": scale(["voidL", 0]),
        "bgL": node("ImageToMask", image=["voidS", 0], channel="red"),
        "bg": node("ThresholdMask", mask=["bgL", 0], value=0.985),
        "bgIn": node("GrowMask", mask=["bg", 0], expand=-2, tapered_corners=True),
        "base": node("SolidMask", value=denoise, width=w, height=h),
        "mask": node("MaskComposite", destination=["base", 0], source=["bgIn", 0], x=0, y=0, operation="add"),
        "diff": node("DifferentialDiffusion", model=["ckpt", 0]),
        "enc": node("VAEEncode", pixels=["view", 0], vae=["ckpt", 2]),
        "masked": node("SetLatentNoiseMask", samples=["enc", 0], mask=["mask", 0]),
        "sample": node("KSampler", model=["diff", 0], positive=["applyL", 0], negative=["applyL", 1], latent_image=["masked", 0],
                       seed=seed, steps=30, cfg=5.0, sampler_name="dpmpp_2m", scheduler="karras", denoise=1.0),
    }
    last = ["sample", 0]
    if d.get("detail"):                                       # second pass at 1.5x for fine material detail
        wf["dec1"] = node("VAEDecode", samples=last, vae=["ckpt", 2])
        wf["up"] = node("ImageScaleBy", image=["dec1", 0], upscale_method="lanczos", scale_by=1.5)
        wf["enc2"] = node("VAEEncode", pixels=["up", 0], vae=["ckpt", 2])
        wf["sample2"] = node("KSampler", model=["ckpt", 0], positive=["pos", 0], negative=["neg", 0], latent_image=["enc2", 0],
                             seed=seed, steps=20, cfg=5.0, sampler_name="dpmpp_2m", scheduler="karras", denoise=0.35)
        last = ["sample2", 0]
    wf["dec"] = node("VAEDecode", samples=last, vae=["ckpt", 2])
    wf["save"] = node("SaveImage", images=["dec", 0], filename_prefix="ModelViewer/render")
    return wf


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))            # no packet is sent; picks the outgoing interface
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript",
                      ".webmanifest": "application/manifest+json", ".glb": "model/gltf-binary",
                      ".gltf": "model/gltf+json", ".dae": "model/vnd.collada+xml", ".mjs": "text/javascript",
                      ".skp": "application/vnd.sketchup.skp"}

    def __init__(self, *a, exports=None, comfy=None, **kw):
        self.exports = exports
        self.comfy = comfy
        super().__init__(*a, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        # the app on GitHub Pages may call this PC too (Chrome asks once to allow the local network)
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/ai/render":
            try:
                n = int(self.headers.get("Content-Length", 0))
                if n > 80 << 20:
                    return self.send_json({"error": "Pictures too large"}, 413)
                data = json.loads(self.rfile.read(n))
                if not all(k in data for k in (*PASSES, "prompt", "negative", "width", "height")):
                    return self.send_json({"error": "Incomplete render request"}, 400)
            except (ValueError, OSError) as e:
                return self.send_json({"error": str(e)}, 400)
            return self.send_json({"id": self.comfy.start(data)})
        if u.path == "/ai/cancel":
            self.comfy.cancel(parse_qs(u.query).get("id", [""])[0])
            return self.send_json({"ok": True})
        return self.send_error(404)

    def do_GET(self):
        u = urlparse(self.path)
        path = unquote(u.path)
        if path == "/ai/ping":
            return self.send_json({"ok": True, "installed": self.comfy.installed(), "running": self.comfy.running(),
                                   "ips": lan_ips(), "port": self.server.server_address[1]})
        if path in ("/ai/status", "/ai/image"):
            job = self.comfy.jobs.get(parse_qs(u.query).get("id", [""])[0])
            if not job:
                return self.send_json({"state": "error", "message": "Unknown render (the PC server was restarted?)"}, 404)
            if path == "/ai/status":
                return self.send_json({k: job.get(k) for k in ("state", "message", "seconds")})
            f = Path(job.get("file", ""))
            return self.send_file(f) if f.is_file() else self.send_error(404)
        if path == "/models/index.json":
            return self.send_index()
        if path == "/models/sequences.json":
            return self.send_index(".sequence.json")
        if path.startswith("/models/"):
            f = (self.exports / path[len("/models/"):]).resolve()
            if self.exports in f.parents and f.is_file() and f.suffix.lower() in MODEL_EXT:
                return self.send_file(f)
            return self.send_error(404)
        return super().do_GET()

    def send_index(self, kind=None):
        items = []
        if self.exports.is_dir():
            for f in self.exports.iterdir():
                if (f.name.lower().endswith(kind) if kind else f.suffix.lower() in {".skp", ".glb", ".gltf", ".dae"}):
                    st = f.stat()
                    items.append({"name": f.name, "url": "models/" + quote(f.name), "size": st.st_size, "mtime": st.st_mtime})
        items.sort(key=lambda m: -m["mtime"])
        body = json.dumps(items).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, f):
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(str(f)))
        self.send_header("Content-Length", str(f.stat().st_size))
        self.end_headers()
        with open(f, "rb") as fh:
            while chunk := fh.read(1 << 20):
                self.wfile.write(chunk)

    def log_message(self, fmt, *args):
        if os.environ.get("MV_QUIET") != "1":
            super().log_message(fmt, *args)


def main():
    if sys.stderr is None or sys.stdout is None:          # started hidden by SketchUp (pythonw)
        sys.stdout = sys.stderr = open(os.devnull, "w")
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--exports", default=str(ROOT / "exports"))
    ap.add_argument("--comfy", default=str(Path.home() / "Desktop" / "SketchRender" / "local" / "ComfyUI_windows_portable"))
    a = ap.parse_args()
    exports = Path(a.exports).resolve()
    exports.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(Handler, directory=str(ROOT / "app"), exports=exports, comfy=Comfy(a.comfy))
    try:
        srv = ThreadingHTTPServer(("0.0.0.0", a.port), handler)
    except OSError as e:
        print(f"Port {a.port} is busy ({e}). The server is probably already running.")
        sys.exit(1)
    print("Model Viewer server. On the phone (same Wi-Fi) open:")
    for ip in lan_ips():
        print(f"   http://{ip}:{a.port}/")
    print(f"Models from: {exports}\nClose this window to stop.")
    srv.serve_forever()


if __name__ == "__main__":
    main()
