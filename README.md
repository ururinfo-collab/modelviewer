# Model Viewer

Phone viewer for Lucie's architecture models. Runs in the phone's browser (Android Chrome, iPhone Safari),
installs to the home screen, works offline. Opens any model you give it, every revision:

| File | How it gets there |
|---|---|
| `.glb` from SketchUp | Model Viewer button in SketchUp 2025 (keeps names, tags, all saved scenes, geo-location) |
| `.dae` (COLLADA) | Straight from your exporter, e.g. `dho2_0_rev05.dae` |
| `.glb` / `.gltf` | Any other glTF (Enscape, Blender...). Pick the `.gltf` with its `.bin` and textures together |

`.skp` itself cannot be read on a phone (closed format), hence the SketchUp export button.

## Folder

| Path | What |
|---|---|
| `app/` | The phone app (HTML + JS, three.js r180 in `app/vendor`). This is what GitHub Pages publishes |
| `sketchup/` | SketchUp extension source; `python sketchup/build.py` makes `sketchup/dist/ModelViewer-1.0.0.rbz` |
| `exports/` | Exported models the Wi-Fi link offers to the phone (not uploaded anywhere) |
| `tools/serve.py` | Wi-Fi link: serves the app and `exports/` on port 8765 |
| `tools/sequence_from_buildlapse.py` | Turns a BuildLapse job into a build order for the time-lapse |
| `Serve to phone.bat` | Starts the Wi-Fi link without SketchUp |

## Install

**1. SketchUp extension (once).** SketchUp 2025 › Extensions › Extension Manager › Install Extension ›
`sketchup/dist/ModelViewer-1.0.0.rbz`. A "Model Viewer" toolbar button appears (also Extensions › Model Viewer).
After moving this folder, run `python sketchup/build.py` and reinstall (the .rbz remembers where the folder is).

**2. The app on the phone.** Two ways, use either or both:

- **GitHub Pages (recommended, HTTPS).** Installs properly, works offline, Photo/Video go straight to Photos.
  One-time setup, see "Publishing" below. Then open `https://<your-github-name>.github.io/modelviewer/`
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
- **Any file route:** send the `.glb` or `.dae` by WhatsApp, Drive, email, USB or AirDrop, save it, then in the app
  tap Open a model file. On Android, after installing the app, you can also Share a file straight to "Viewer".
- The last 6 models stay on the phone (welcome screen, "On this phone") and open offline.

## Using it

**Gestures:** one finger orbits, two fingers pinch-zoom and pan, double-tap a point to orbit around it.
Tap an object to select it; tap it again to go one level deeper (chair › chair leg); ↑ selects the group it sits in.
Parts exported loose (each chair leg its own group, as in Rev05) are grouped back by name: "Dining chair 1 seat",
"Dining chair 1 leg"... become "Dining chair 1".

**Top row:** Home, Top, Front, Back, Left, Right, then every SketchUp scene (camera, hidden tags, hidden objects,
shadow time), then your own saved views (+ View saves, press and hold one to delete).

**Selected object:** Info (name, tag, category, size, levels, volume, IFC / component attributes), Zoom, Hide,
Isolate, See-thru, Move.

**Tools (bottom bar, left bar in landscape):**

| Tool | What |
|---|---|
| Layers | Show / hide / isolate by **Tags** (SketchUp tags or COLLADA categories) or by **Categories** (walls, doors, windows, furniture, plumbing..., guessed from names; rules in `app/js/categories.js`) |
| Tree | Model tree with search, eye toggles, zoom to |
| Section | Plan cut (height slider), across, along, or parallel to a tapped face; flip; cut solids show red |
| Measure | Tap two points, corners snap; shows length plus horizontal / vertical parts; units m, mm, ft-in |
| Walk | Tap where to stand. Left thumb joystick walks, drag elsewhere looks. Follows floors and stairs, walls block (toggle). Fly mode for up / down. Keyboard: WASD, Q/E, Shift |
| Build | Construction time-lapse, see below |
| X-ray | Everything see-through; the selection stays solid |
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

## Build (construction time-lapse)

Build bar: Play / Pause, slider, previous / next stage, Show rest (unbuilt parts see-through), Orbit (camera turns
during the build), speed (20 to 120 s), Record (plays from the start and saves a video with the stage caption in
English and Myanmar and a progress bar), Order.

- **Automatic order** works on any model: foundations, columns, beams, slabs, walls, stairs, roof, doors, windows,
  services, finishes, railings, furniture, site; bottom up within each stage, every stage the same time.
- **BuildLapse order** (the 28-stage Rev05 site sequence with BuildLapse's timing): make it from a BuildLapse job
  ```bash
  python tools/sequence_from_buildlapse.py "C:/Users/ARKAR/Desktop/BuildLapse/jobs/dho2_0_rev05"
  ```
  This writes `exports/dho2_0_rev05.sequence.json`. Over Wi-Fi the app picks it up by itself (same name as the
  model, or the only one in `exports/`). From phone storage, select it together with the model, or tap Order in
  the Build bar and pick it. Parts are matched by name, so the file keeps working as the model changes: parts it
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

- three.js lives in `app/vendor/three` (r180, from jsDelivr). The app has no build step: edit, reload.
- Test on the PC: `python tools/serve.py`, open `http://localhost:8765/?model=models/<file>`.
