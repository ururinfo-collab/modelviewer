# Model Viewer

Phone + PC 3D viewer (PWA) for Lucie's SketchUp models, plus SketchUp Ruby tools. Live at
https://ururinfo-collab.github.io/modelviewer/ (pushing main publishes it).

**Read `HANDOVER.md` first** (state, release routine, current SketchUp work, rules), then `README.md` as needed.

- Bump the version in `app/sw.js`, `app/js/panels.js` and `app/index.html` on every app change.
- Never launch SketchUp while Lucie's is open; use the bridge (`sketchup/tools/mv_bridge.rb`, see HANDOVER.md).
- Commit as Lucie (arkarsoe.info@gmail.com) with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
