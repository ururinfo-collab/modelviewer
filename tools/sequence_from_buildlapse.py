"""Turns a BuildLapse job's schedule into a build order the phone viewer can play.

  python tools/sequence_from_buildlapse.py "C:/Users/ARKAR/Desktop/BuildLapse/jobs/dho2_0_rev05"

Writes exports/<job>.sequence.json: the stage list (English + Myanmar) and, per part, its name,
stage, start frame and centre. The viewer matches parts by name (centre breaks ties), so the file
keeps working on later revisions of the model; parts it does not know are placed by their type.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    job = Path(sys.argv[1] if len(sys.argv) > 1 else "C:/Users/ARKAR/Desktop/BuildLapse/jobs/dho2_0_rev05")
    sched = json.loads((job / "schedule.json").read_text(encoding="utf-8"))
    manifest = json.loads((job / sched["manifest"]).read_text(encoding="utf-8"))
    by_id = {p["id"]: p for p in manifest["parts"]}
    stage_index = {s["n"]: i for i, s in enumerate(sched["stages"])}
    parts = []
    for p in sched["parts"]:
        src = by_id.get(p["id"])
        if not src or p["stage"] not in stage_index:
            continue
        b = src["bbox"]                                        # metres, Z up
        cx, cy, cz = (b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2
        # viewer world is Y up: (x, z, -y)
        parts.append([src["name"], stage_index[p["stage"]], p["start"], round(cx, 3), round(cz, 3), round(-cy, 3)])
    out = {
        "format": "mv-sequence/1",
        "model": job.name,
        "source": "BuildLapse " + sched.get("format", ""),
        "stages": [{"en": s["en"], "mm": s.get("mm", "")} for s in sched["stages"]],
        "parts": parts,
    }
    dest = ROOT / "exports" / f"{job.name}.sequence.json"
    dest.parent.mkdir(exist_ok=True)
    dest.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{dest}: {len(out['stages'])} stages, {len(parts)} parts")


if __name__ == "__main__":
    main()
