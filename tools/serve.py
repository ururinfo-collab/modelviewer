"""Wi-Fi server: the phone opens http://<this PC>:8765 and gets the viewer plus the exported models.

  /                  the app (ModelViewer/app)
  /models/index.json list of models in ModelViewer/exports (newest first)
  /models/<file>     a model

Run:  python tools/serve.py  [--port 8765] [--exports <folder>]
Windows asks once to allow Python on the network: tick Private networks.
"""
import argparse
import functools
import json
import os
import socket
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
MODEL_EXT = {".glb", ".gltf", ".dae", ".bin", ".json", ".png", ".jpg", ".jpeg"}


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
                      ".gltf": "model/gltf+json", ".dae": "model/vnd.collada+xml"}

    def __init__(self, *a, exports=None, **kw):
        self.exports = exports
        super().__init__(*a, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
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
                if (f.name.lower().endswith(kind) if kind else f.suffix.lower() in {".glb", ".gltf", ".dae"}):
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
    a = ap.parse_args()
    exports = Path(a.exports).resolve()
    exports.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(Handler, directory=str(ROOT / "app"), exports=exports)
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
