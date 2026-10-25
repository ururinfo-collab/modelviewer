"""Packs sketchup/src into sketchup/dist/ModelViewer-<version>.rbz (SketchUp: Extension Manager > Install).

Bakes this folder's location and the Python used for the Wi-Fi link into modelviewer/paths.rb.
"""
import re
import sys
import zipfile
from pathlib import Path

here = Path(__file__).resolve().parent
src = here / "src"
root = here.parent
pythonw = Path(sys.executable).with_name("pythonw.exe")
(src / "modelviewer" / "paths.rb").write_text(
    "# Written by build.py: where the Model Viewer folder and Python live on this PC.\n"
    "module ModelViewer\n"
    f"  ROOT = '{root.as_posix()}'.freeze\n"
    f"  PYTHONW = '{pythonw.as_posix()}'.freeze\n"
    "end\n", encoding="utf-8")
version = re.search(r"VERSION = '([^']+)'", (src / "modelviewer.rb").read_text()).group(1)
out = here / "dist" / f"ModelViewer-{version}.rbz"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(src.rglob("*")):
        if f.is_file():
            z.write(f, f.relative_to(src).as_posix())
print(out)
