# Model Viewer

Phone viewer for Lucie's architecture models. Runs in the phone's browser (Android Chrome, iPhone Safari),
installs to the home screen, works offline. Opens any model you give it, every revision:

| File | How it gets there |
|---|---|
| `.skp` | Straight from SketchUp's save folder (WhatsApp, Drive, USB...). Read on the phone by [openskp](https://github.com/iamahsanmehmood/openskp) (MIT, open-source, reverse-engineered). Keeps names, tags, groups, materials, textures, scenes (camera + hidden tags) |
| `.glb` from SketchUp | Model Viewer button in SketchUp 2025. Everything `.skp` has, plus geo-location, hidden objects and shadow time per scene, IFC / component attributes, solid volumes |
| `.dae` (COLLADA) | Straight from your exporter, e.g. `dho2_0_rev05.dae` |
| `.glb` / `.gltf` | Any other glTF (Enscape, Blender...). Pick the `.gltf` with its `.bin` and textures together |

Rev05 `.skp` (8.9 MB) reads in about 3 s on the PC; expect 10 to 20 s on a phone. If a `.skp` ever fails to open
(the reader is unofficial), use the export button.

## Folder

| Path | What |
|---|---|
| `app/` | The phone app (HTML + JS, three.js r180 in `app/vendor`). This is what GitHub Pages publishes |
| `sketchup/` | SketchUp extension source; `python sketchup/build.py` makes `sketchup/dist/ModelViewer-1.0.0.rbz` |
| `exports/` | Exported models the Wi-Fi link offers to the phone (not uploaded anywhere) |
| `tools/serve.py` | Wi-Fi link: serves the app and `exports/` on port 8765, and runs AI renders on the PC (`/ai/...`) |
| `tools/sequence_from_buildlapse.py` | Turns a BuildLapse job into a build order for the time-lapse |
| `Serve to phone.bat` | Starts the Wi-Fi link without SketchUp |

## Install

**1. SketchUp extension (once).** SketchUp 2025 › Extensions › Extension Manager › Install Extension ›
`sketchup/dist/ModelViewer-1.0.0.rbz`. A "Model Viewer" toolbar button appears (also Extensions › Model Viewer).
After moving this folder, run `python sketchup/build.py` and reinstall (the .rbz remembers where the folder is).

**2. The app on the phone.** Two ways, use either or both:

- **GitHub Pages (recommended, HTTPS).** Installs properly, works offline, Photo/Video go straight to Photos.
  Published at **https://ururinfo-collab.github.io/modelviewer/** (repo `ururinfo-collab/modelviewer`, setup in "Publishing" below)
  - iPhone: Safari › Share › Add to Home Screen
  - Android: Chrome › ⋮ › Install app
- **Wi-Fi link from the PC.** Phone on the same Wi-Fi opens `http://<PC address>:8765/` (the SketchUp dialog
  shows the address). Nothing online. Without HTTPS the browser does not allow offline install or direct
  Share-to-Photos (the app falls back to Save, see below). First time, Windows asks to let Python through
  the firewall: allow **Private networks**.

## Getting a model onto the phone

- **From SketchUp over Wi-Fi:** Model Viewer button › Export (leave "Start the Wi-Fi link" ticked). On the phone open
  the Wi-Fi address and tap the model under "From the PC". Each export overwrites `exports/<model>.glb`, so after
  a change: Export, then tap it again on the phone. "Selection only" exports just what is selected.
- **Any file route:** send the `.skp`, `.glb` or `.dae` by WhatsApp, Drive, email, USB or AirDrop, save it, then in the app
  tap Open a model file.
  - Android (Samsung): install the app from **Chrome** (not Samsung Internet), then in WhatsApp / My Files
    long-press the file › Share › **Viewer**. Recent Chrome versions also list Viewer under "Open with".
  - iPhone: always through Open a model file; iOS does not let web apps appear in "Open with".
- The last 6 models stay on the phone (welcome screen, "On this phone") and open offline.

## Using it

**On a computer:** hovering shows the object's name with a blue box; right-click opens its menu (info, zoom, hide,
isolate, see-through, move, select group, fit, top view); a right-drag still pans. The north arrow by the title
turns with the view; click it for the top view.

**Gestures:** one finger orbits, two fingers pinch-zoom and pan, double-tap a point to orbit around it.
Tap an object to select it; tap it again to go one level deeper (chair › chair leg); ↑ selects the group it sits in.
Parts exported loose (each chair leg its own group, as in Rev05) are grouped back by name: "Dining chair 1 seat",
"Dining chair 1 leg"... become "Dining chair 1".

**Top row:** Home, Top, Front, Back, Left, Right, then every SketchUp scene (camera, hidden tags, hidden objects,
shadow time), then your own saved views (+ View saves, press and hold one to delete). On a computer: arrows at the
ends, mouse wheel, or drag. An orange **Hidden (n)** button appears while objects are hidden: it opens
Layers › Hidden, where each one comes back with its eye (or zoom) button, or all at once.

**Undo / Redo** (top bar, Ctrl+Z / Ctrl+Y): steps back and forward through hide, see-through, isolate, tags,
categories, scene visibility, moves, rotations and resets (last 60 steps; a new model starts a fresh history).

**Selected object:** Info (name, tag, category, size, levels, volume, IFC / component attributes), Zoom, Hide,
Isolate, See-thru, Move.

**Tools (bottom bar, left bar in landscape):**

| Tool | What |
|---|---|
| Layers | Show / hide / isolate by **Tags** (SketchUp tags or COLLADA categories) or by **Categories** (walls, doors, windows, furniture, plumbing..., guessed from names; rules in `app/js/categories.js`) |
| Tree | Model tree with search, eye toggles, zoom to |
| Section | Plan cut (height slider), across, along, or parallel to a tapped face; flip; cut solids show red. **Box**: six cuts around the selection (select a room's floor: a dollhouse view into that room) or around everything; each side has a slider and -/+ 10 cm |
| Measure | **Distance** (two taps, corners snap; with horizontal / vertical parts), **Area** (tap the corners, then the first corner again or Finish; works on floors, walls and sloped roofs; shows perimeter too) and **Angle** (end, corner, end); units m, mm, ft-in |
| Walk | Tap where to stand. Left thumb joystick walks, drag elsewhere looks. Follows floors and stairs, walls block (toggle). Fly mode for up / down. Keyboard: WASD, Q/E, Shift |
| Build | Construction time-lapse, see below |
| See-thru | Choose **Solid**, **See inside** (walls, roof, ceilings, floors, doors, windows, railings and boundary see-through; furniture, fittings, pipes, AC and stairs solid, so you look in from outside; taps go through the shell) or **X-ray** (everything see-through, selection solid). Calibrated on BuildLapse: 16 % opacity, faces tinted toward glass, faint grey edge lines. Also clears objects made see-through one by one. In See inside and X-ray nothing blocks you: zooming keeps flying forward through walls and furniture, and Walk passes through them (you still follow floors and stairs, never furniture) |
| Look | Render style: **Technical** (colours + edge lines), **Shaded** (no lines, soft corners), **White model** (architectural white), **Sketch** (black lines on white), **Realistic** (materials, textures, studio sky light, sun shadows, grass). **Colours**: Soft, Natural or **Vivid** (default: stronger colours and more light-and-shade between faces). Background (light grey, white, sky, dark), ground (none, grass, paving), soft corner shadows (ambient occlusion; on by default on computers only), sun shadows, edge lines, brightness (Realistic). Remembered on each device |
| AI render | Photoreal picture of the current view through SketchRender's engines, see below |
| Client link | A private, expiring view-only link to the model for a client, see below |
| Quantities | Count, solid volume, surface area and length per tag, category or object name; only what is shown or everything; isolate a group; **Export CSV** (one line per object with sizes, plus totals) for Excel / Google Sheets |
| Compare | Pick another revision (.skp, .glb or .dae): parts are matched by name and place; added (green), moved or resized more than 2 cm (orange) and removed (red, drawn where they were) are listed and coloured, the rest fades. Tap a list line to zoom to it |
| Notes | Add a note, tap the spot: text plus an optional photo (camera or gallery, shrunk to keep many). Numbered pins on the model; the list jumps back to the view each note was made from. Kept on the device per model; Export / Import a small .json to move them between phone and computer. Delete one with its bin in the list (or Delete in the note), or Delete all notes |
| AR | Android (Samsung) with Chrome, from the https address, with **Google Play Services for AR**. Two ways: **Table model**: point at a table or the floor until a white ring shows, tap to place (tap again to move); scales 1:200 to 1:10 (default 1:20), Bigger / Smaller, turn; centred on the house. **Full size: stand inside**: first tap the floor in the model where you want to stand, facing the way you want to look; in AR point at the floor near your feet and tap: that spot is put at your feet. Then Model up / down (10 cm), Forward / Back / Left / Right (25 cm), Turn, At my feet (put it back); your eye level above that floor is shown. Edge lines and shadows pause in AR. Not on iPhone (no web AR in Safari) |
| Sun | Shadows on/off, time of day, date, Play the day, **Record the day**, site location (Yangon / Mandalay buttons) |
| Photo | Screenshot (size 1x / 2x / 3x in More) |
| Record | Records the 3D view to video (MP4 on iPhone and recent Android Chrome, else WebM) |
| More | Edge lines, units, sharpness (battery), walk eye height, reset moved objects, clear stored models |

**Move / rotate:** select, Move, drag the arrows. Rotate switches to the turn ring. Up/down allows vertical moves
and tilting. Snap = 5 cm and 15°. Undo steps back; Reset puts the object back. Changes live only in the viewer
(the model file is never changed).

**Saving photos and videos:** after Photo or Record a preview opens.
- iPhone (GitHub Pages): "Save to Photos / Share" › Save Image / Save Video.
- iPhone (Wi-Fi link): touch and hold the picture › Save to Photos; videos go to Files first.
- Android: "Save to phone" puts it in Downloads (shows in Gallery / Photos); "Share" sends it anywhere.
- The phone's own screen recorder also works and includes the buttons.

## Client link (view only)

**Client link** in the toolbar makes a private link to the open model for a client.
1. First time: choose an **owner code** (8+ characters). Only a fingerprint of it is stored online; on each other device
   you share from, type it once. Keep it safe: it is what lets you make and withdraw links.
2. Title, how long the link works (1 week to 1 year), include your notes or not, **Create client link**. The model
   uploads and the phone's Share sheet opens (WhatsApp, mail...); Copy also works.
3. **Your links** shows each link: valid until, how often it was opened, size. The bin withdraws a link at once and
   deletes its files. Links made on this device can be copied again (the share icon).

The client opens `https://ururinfo-collab.github.io/modelviewer/#view=...` on any phone or computer, no install or
account: the model, your scenes, layers, section, measure, walk, See-thru, Look, Sun, photo, record, AR and the
Build time-lapse with your build order; your notes show as read-only pins. No moving objects, compare, quantities,
AI render or opening other files. An expired or withdrawn link shows a short message.

Behind it (Lucie's Supabase project "ururinfo-collab's Project", Singapore, free plan): private bucket `mv-shares`
(50 MB per file), tables `mv_owner`, `mv_shares`, `mv_fails` (server-only), and the Edge Function `mv-share`
(source in `supabase/functions/mv-share/index.ts`). Files go up and down through signed links valid for minutes to
hours; the link's secret is stored only as a SHA-256 fingerprint. Ten wrong codes or links in 15 minutes pause it.
Forgot the owner code: delete the one row in `mv_owner` (Supabase › Table editor) and choose a new one in the app.

## AI render (SketchRender)

Frame the view, tap **AI render**, pick a style (Daylight, Myanmar tropical, Dusk, Overcast, Interior warm,
Interior bright, White clay model), optionally type extras, **Render this view**. The result opens beside the
model view: drag across it to compare, then Save / Share or Render again. Hidden parts and section cuts carry
into the picture; See inside / X-ray are rendered as Solid. Results of the session show as thumbnails in the panel.

The viewer makes the same four pictures SketchRender takes in SketchUp (view without edge lines, black line
drawing, depth map, depth map without the ground) and uses the same prompts. Two engines:

| Engine | How | Cost / time |
|---|---|---|
| **PC** | The Wi-Fi server (`tools/serve.py`) hands the pictures to SketchRender's local engine (ComfyUI, RealVisXL + ControlNet Union) in `Desktop\SketchRender\local\` on the RTX 3070, same workflow as SketchRender (Freedom Low / Medium / High, Extra detail). The engine starts on the first render in a minimised "SketchRender local engine" window (about a minute) and stays loaded; close that window to free the graphics card | free; about 30 s once loaded |
| **Gemini** | Google's Nano Banana (Standard or Best/Pro, 1K / 2K / 4K), called straight from the device with your Google API key (AI render settings › Gemini key; kept on that device only) | about $0.03 to $0.24 per picture; 10 to 30 s; works anywhere |

**Auto** uses the PC when it answers, else Gemini when a key is saved.
Reaching the PC: opened from the PC link (`http://<PC>:8765`) it is found by itself. From the GitHub Pages app,
type the PC address (shown when the server starts, e.g. `192.168.80.14:8765`) in AI render settings; Chrome asks
once to allow devices on the local network. On the PC itself `localhost:8765` is tried. PC pictures are also kept
in `SketchRender\local\ComfyUI_windows_portable\ComfyUI\output\ModelViewer\`.

## Build (construction time-lapse)

Build bar: Play / Pause, slider, previous / next stage, Show rest (unbuilt parts see-through), Orbit (camera turns
during the build), speed (20 to 120 s), Record (plays from the start and saves a video with the stage caption in
English and Myanmar and a progress bar), Order.

- **Automatic order** works on any model. Each part's stage comes from its **tag** (CAD codes such as S-FDN, S-COL,
  A-WALL, A-OPEN, P-WATER, M-ACMV, E-ELEC, I-FURN, or words like "foundation", "roof"), from its name only when the
  tag says nothing. Stages: excavation and foundations, underground services (services that stay below ground),
  columns, beams, slabs, staircase, roof structure, roofing, walls, doors and windows, plumbing, air-conditioning,
  electrical, finishes, railings, interior, solar, boundary, site. Bottom up within each stage, every stage the same
  time. Context tags (X-CTX, "indicative") stay in view throughout.
- **BuildLapse order** (the 28-stage Rev05 site sequence with BuildLapse's timing): make it from a BuildLapse job
  ```bash
  python tools/sequence_from_buildlapse.py "C:/Users/ARKAR/Desktop/BuildLapse/jobs/dho2_0_rev05"
  ```
  This writes `exports/dho2_0_rev05.sequence.json`. Over Wi-Fi the app picks it up by itself (same name as the
  model, or the only one in `exports/`). On the phone: send that file to yourself once (WhatsApp, Drive), then in
  Build tap Order › Load an order file. The phone keeps it: later revisions of the model (any file name) use it
  by themselves when at least a third of the part names match; Order › Automatic switches back per model. Parts are matched by name, so the file keeps working as the model changes: parts it
  does not know are put in the stage where most of their tag (else category) went; site context
  ("indicative" / Context tags) stays visible throughout.

## Publishing (GitHub Pages, one time)

The repository holds only the app; `exports/` and the .rbz are ignored, so no model goes online.

1. On github.com: New repository, name `modelviewer`, Public (Pages is free for public repos), no README.
2. Here (the folder is already a git repository with everything committed), replacing `<your-github-name>`:
   ```bash
   git -C "C:/Users/ARKAR/Desktop/ModelViewer" remote add origin https://github.com/<your-github-name>/modelviewer.git
   ```
   ```bash
   git -C "C:/Users/ARKAR/Desktop/ModelViewer" push -u origin main
   ```
   Windows asks you to sign in to GitHub the first time.
3. On github.com › the repo › Settings › Pages › Source: **GitHub Actions**. The included workflow publishes `app/`
   on every push; the address appears there after a minute.
4. After changing the app later: bump `VERSION` in `app/sw.js`, commit, push. Phones pick it up on the next launch.

## Limits

- Edge lines are worked out from the faces (40°), not SketchUp's own edges; hidden / soft edges are not used.
- Section cut colour shows only on closed solids; single faces look hollow.
- SketchUp section planes, styles and per-scene section cuts are not exported; scenes carry camera, tags, hidden
  objects and shadow time.
- Faces with their own tag inside a group follow the group's tag.
- Textures: SketchUp textures export as PNG / JPEG; projected (photo-matched) textures may sit differently.
- Rev05's geo-location is still SketchUp's default (Boulder, USA); the Sun panel warns and has Yangon / Mandalay buttons.
  Set it in SketchUp (Window › Model Info › Geo-location) and the export carries it.
- Very large models: Rev05 (2,866 objects, 166k triangles, 4.3 MB) runs fine; past ~1M triangles phones slow down.

## For later changes

- three.js lives in `app/vendor/three` (r180), openskp 1.3.0 + earcut 3.2.4, fflate 0.8.3, flatbuffers 25.9.23 in
  `app/vendor/openskp` (all from jsDelivr). The app has no build step: edit, reload.
- Test on the PC: `python tools/serve.py`, open `http://localhost:8765/?model=models/<file>`.
