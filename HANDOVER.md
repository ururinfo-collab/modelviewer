# Model Viewer: hand-over (28.10.2026)

Read this first, then README.md (every feature, every command, how things work).

## What this is
A 3D viewer for Lucie's SketchUp house models (DHO 2.0, Rev05), as a phone and PC app (PWA). Plus a Ruby script
that applies the viewer's "one plastered surface" look and flicker fix to the .skp itself.

- Folder: `C:\Users\ARKAR\Desktop\ModelViewer` (git, branch main)
- Live: https://ururinfo-collab.github.io/modelviewer/ (repo ururinfo-collab/modelviewer, GitHub Pages via Actions,
  publishes `app/` on every push to main; git credential is stored on the PC)
- Live app version: **1.25.0** (Save: .glb and look file for SketchUp).

## Release routine (app)
- No build step: three.js r180 and openskp are vendored in `app/vendor`. Edit, reload.
- Bump the version in three places: `app/sw.js` VERSION, `app/js/panels.js` APP_VERSION, `app/index.html` "Version".
- Test locally: `python tools/serve.py` → http://localhost:8765/ (also the Wi-Fi link for the phone; serve.py
  also runs the PC AI-render engine).
- Commit as Lucie (`arkarsoe.info@gmail.com`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  No double quotes in commit messages when committing through PowerShell here-strings. Push = goes live.
- Write files with UTF-8 without BOM (PowerShell Set-Content mangles the Myanmar / special characters).

## Done and confirmed by Lucie (1.17 → 1.24)
Notes deletable · AI render (SketchRender ComfyUI on the PC, or Gemini) · client view-only links on Supabase
(project zjlbcltvpbfzraixlugm, Edge Function mv-share; Lucie sets her own owner code) · Presentation look ·
colour contrast · flicker fix (near plane + polygon offset) · joint-free plastered walls · Colour wheel ·
Floors panel: levels + per-level layered explode · AR on her Samsung (near 0.01 during AR, anchors).

## SketchUp script (current work): `sketchup/tools/flush_joints.rb`
In SketchUp 2025: Window › Ruby Console, `load 'C:/Users/ARKAR/Desktop/ModelViewer/sketchup/tools/flush_joints.rb'`
(also adds Extensions › Flush joints). Order for a new file: `MVJoints.apply`, `MVJoints.flicker_apply`,
`MVJoints.apply`. `MVJoints.restore` / `flicker_restore` undo everything; `MVJoints.why` explains one selected line.

State on 28.10: run on `D_HO\...\261024\DHO2.0_Rev05_IFC_26.10.2026_copy.skp` (open in Lucie's SketchUp,
NOT saved yet). Facades look clean in one run: 22,021 lines hidden, 1,053 pieces of long lines, 1,706 gap strips
(group "MV joint seals"), 251 faces painted. Only faint SketchUp hairlines where separate parts touch remain at
very close zoom (not edges; would need merging parts).

Lessons from this model:
- Her style has Profiles on: SketchUp draws soft corner edges as thick profile lines, so soft edges at a
  corner (`corner?`) must be treated like normal edges.
- Wall paint only goes to `PAINT` parts (columns, beams, slabs, panels) minus `NO_PAINT`; reruns restore faces
  that no longer qualify.
- Gap strips only where the partner edge lies on the open side (off < 0); overlap is not a gap.
- The flicker fix pushes faces 1 mm forward, so "covered" checks project the point onto the face, but also
  require the part's side face to run into the other part's box (keeps the house corners).
- Check covered along the whole line (beam edges are covered only where they pass columns).

1.25.0 (28.10): **Save** panel in the viewer (`app/js/export.js`): .glb of what is shown (GLTFExporter vendored,
part nodes carry `extras.mv`, geometry nodes `extras.mvMesh` so the loader folds them into their part) and a
`.mvlook.json` look file. SketchUp `MVJoints.export` / Extensions › Flush joints › Save a clean copy: needs the
model saved; applies look file + joints + flicker + joints (one operation, committed), `save_copy`, then saves the
worked model to a temp file and opens the original again, camera restored. Tested through the bridge on copies of
Rev05 (28.10): copy correct (wall paint, door by path, 22,755 lines, seals, flicker), original reopened unchanged.
Why not abort: joints + flicker + joints + save_copy in one operation leaves the changes in place after
`abort_operation` and `Sketchup.undo` (each smaller combination aborts fine). Viewer paths contain levels SketchUp
lacks (ROOT, name groups like "D1 GF"): `by_path` steps over names it cannot find.

Open offer to Lucie: keep slab edges (the floor band) out of the wall paint if she wants the band grey.
Possible later: install the script permanently in SketchUp's Plugins folder (only with her OK).

## Looking into Lucie's open SketchUp: `sketchup/tools/mv_bridge.rb`
Never start a second SketchUp: it closes hers (check `Get-Process SketchUp`). Instead she loads
`load 'C:/Users/ARKAR/Desktop/ModelViewer/sketchup/tools/mv_bridge.rb'` once; it prints "Bridge on" and writes
`sketchup/bridge/alive.txt`. Then drop Ruby in `sketchup/bridge/cmd_<name>.rb` (write `.part`, rename); the answer
appears in `out_<name>.txt` (stdout + `=> result`). Pictures: `view.write_image(filename:, width:, height:)`, save and
restore the camera around it. Never call code that opens `UI.messagebox` without stubbing it (blocks SketchUp):
alias `UI.messagebox` to a stub, call, alias back. `MVBridge.stop` ends it; it stops itself after 2 h idle.

## Rules from Lucie's brief
Ask before downloading anything. Never enter passwords or tokens. Use her email only for commit authorship.
Answers short and plain; she tests on a Samsung phone and in SketchUp 2025 on this PC.
