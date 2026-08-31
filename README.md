# WhittleGuide

**Turn museum 3D models into practical wood-carving guides — entirely in your browser.**

Browse real Open Access 3D scans (or upload your own model), drop the object into a
rectangular wooden blank, and WhittleGuide works out the templates, depth maps,
topographic contour maps and a safe, progressive roughing sequence you can print
and take to the bench.

Think of it as an early **"slicer" for subtractive hand carving**: instead of
generating layers to *add* material, it helps you progressively *remove* material
from a blank until the object emerges.

> **Live site:** https://jfriedli.com/whittle-guide/
> (`https://jfriedli.github.io/whittle-guide/` redirects here — the account uses a
> custom domain for its user Pages site.)

---

## 1. What WhittleGuide is

A static, client-side web app (Vite + TypeScript + three.js). Given a 3D mesh and
the dimensions of a wooden blank it produces:

- true **orthographic templates** for all six faces, at 1:1 print scale;
- **orthographic depth maps** (how deep to carve at each point, from each face);
- **contour maps** (a topographic map of the sculpture from each side, 2 / 5 / 10 mm);
- a sequence of **carving stages** — nested solid envelopes that always contain
  the finished object, so the guide can never tell you to cut into the final form;
- a heuristic **carvability score** with warnings for models that carve badly;
- a single **printable guide** with a print-calibration square.

Everything runs in the browser. Museum meshes are fetched directly from the
Smithsonian; **uploaded files never leave your device**.

## 2. Current features

| Area | Status |
| --- | --- |
| Smithsonian 3D museum browser (live search + 16 curated CC0 objects) | ✅ |
| Upload `.glb` / `.gltf` (incl. Draco) / `.obj` / `.stl` | ✅ |
| Interactive 3D workspace: orbit/pan/zoom, translucent blank, labelled axes | ✅ |
| Editable blank dimensions (mm / cm), auto-fit with margin, orientation, scale | ✅ |
| Visualisation modes: model, blank+model, current stage, material-to-remove, wireframe, section | ✅ |
| 6 orthographic silhouette templates with real dimensions, centre lines, tick marks | ✅ |
| Depth maps (front/back/left/right) with hover read-out and legend | ✅ |
| Contour maps at 2 / 5 / 10 mm | ✅ |
| 9 progressive carving stages with geometry-derived instructions | ✅ |
| Stage timeline + material-removed visualisation | ✅ |
| Carvability analysis + unsuitable-model warnings | ✅ |
| Printable guide (A4 CSS) + per-template SVG export + calibration square | ✅ |
| Web Worker for the heavy geometry so the UI stays responsive | ✅ |
| Europeana provider | ⚙️ scaffolded, opt-in via API key (see §5) |
| PDF export | ➖ use the browser's "Save as PDF" from the guide (deliberately not a fake button) |
| Knife/tool-path planning, grain awareness | ❌ future work (see §12) |

## 3. Architecture

```
src/
  app/            UI shell, screen routing, DOM helpers
  components/     library browser, workspace, tab panels, depth raster
  museum/
    types.ts              provider abstraction
    library.ts            aggregates providers, merges curated + live
    providers/
      smithsonian.ts       Smithsonian 3D API + curated catalogue
      europeana.ts         optional, config-gated
    catalogue.generated.json   committed CC0 catalogue (see scripts/build-catalogue.mjs)
  viewer/         three.js scene, model loaders, voxel→mesh, demo models
  geometry/       PURE, three.js-free, unit-tested pipeline
    mesh.ts normalize.ts blank.ts voxelize.ts distance.ts
    projection.ts depthMap.ts contours.ts marchingSquares.ts
    carvingStages.ts carvability.ts roughCuts.ts analysis.ts
  workers/        analysis.worker.ts + main-thread client
  export/         SVG templates, printable guide
```

The **geometry subsystem is deliberately decoupled from the UI and from three.js**.
It operates on a plain triangle soup (`Float32Array`, 9 floats per triangle) and
returns plain data, so it can be unit-tested in Node and later ported to
Rust/WASM behind the same interface. The worker is a thin wrapper around
`geometry/analysis.ts::analyse()`.

## 4. Supported model types

`.glb`, `.gltf` (including Draco-compressed), `.obj`, `.stl`. Textures are not
required for analysis. Broken or empty files produce a readable error.

For large museum scans the mesh is cleaned (degenerate triangles dropped) and
**simplified by vertex clustering** to ≤ 40 000 triangles for interactive
analysis; the original is still shown in the viewer.

## 5. Museum integration

### Smithsonian (primary)

- **API:** `GET https://3d-api.si.edu/api/v1.0/content/file/search`
  (`q`, `model_type`, `file_quality`, `owning_unit`, `rows`, …). No key required;
  responds with `Access-Control-Allow-Origin: *`, so the browser calls it directly.
- The search response gives title + a browser-ready GLB URL + a preview JPG, but
  **not** reuse terms, so:
  - **Curated catalogue** (`src/museum/catalogue.generated.json`, 16 objects) is
    generated at build time by `npm run catalogue`, which resolves current GLB /
    thumbnail URLs for a hand-picked, carving-oriented seed list. Every seed is
    published on [3d.si.edu](https://3d.si.edu) as Open Access / **CC0**;
    `npm run catalogue -- --enrich` additionally cross-checks
    `metadata_usage.access` against the Smithsonian Open Access API (needs a free
    `api.data.gov` key in `SI_API_KEY`). Each entry keeps a `sourceUrl` to the
    authoritative record.
  - **Live search** results are shown too, but labelled *"verify reuse terms at
    si.edu"* and linked to their record, because their licence can't be confirmed
    from a static site.
- The deployed site therefore **always shows real museum objects**, even if the
  API is unreachable — the curated CC0 catalogue is bundled.

### Europeana (optional)

Europeana's Search/Record APIs require a personal `wskey`, which must not be
embedded in a public static site. The provider is implemented but **disabled
unless** `VITE_EUROPEANA_KEY` is set at build time:

1. Request a free key: https://pro.europeana.eu/pages/get-api-keys
2. Local: add `VITE_EUROPEANA_KEY=…` to `.env.local`.
3. Production: add it as a GitHub Actions **repository secret**; the deploy
   workflow already forwards `secrets.VITE_EUROPEANA_KEY` to the build.
4. Rebuild — the provider appears in the library automatically.

The app is fully functional without Europeana.

## 6. Geometry pipeline

```
placed mesh (blank space)
  → solid voxelisation        3-axis parity fill, majority vote (robust to holes)
  → orthographic projections  6 silhouettes + marching-squares outlines
  → depth maps                first solid voxel from each face, quantised to 1 mm
  → contour maps              marching squares on the depth field, 2/5/10 mm
  → carving stages            nested envelopes (see §7)
  → carvability report        undercuts, thin features, symmetry, recesses, …
  → experimental rough cuts    safe whole-slab straight cuts
```

Voxel resolution is bounded (~60 cells on the longest blank axis). A
40-million-triangle scan is never analysed at full resolution.

## 7. Carving-stage algorithm

Each stage is a solid region `S_k` with the guaranteed invariant

```
blank = S₀ ⊇ S₁ ⊇ S₂ ⊇ … ⊇ S₈ = final model      and every  S_k ⊇ final
```

It is achieved **by construction**: `S_k = S_{k-1} ∩ C_k`, where every constraint
region `C_k` is itself a superset of the final model:

| k | constraint `C_k` | meaning | safety margin |
| --- | --- | --- | --- |
| 1 | padded bounding box of the model | saw to a coarse block | coarse (≤ 5 mm, adaptive) |
| 2 | front silhouette back-extruded through the blank | establish front/back outline | coarse |
| 3 | side silhouette back-extruded | establish left/right outline | coarse |
| 4 | top silhouette back-extruded | knock off the four long corners | coarse |
| 5 | `dilate(final, 5 mm)` | coarse 3-D envelope | ~5 mm |
| 6 | `dilate(final, 2 mm)` | medium detail | ~2 mm |
| 7 | `dilate(final, 1 mm)` | near-final, no undercuts | ~1 mm |
| 8 | `final` | final surface | 0 |

Because every `C_k ⊇ final`, intersecting them can only shrink toward — never
inside — the finished carving. Margins shrink automatically for small models.
`verifyStageInvariant()` re-checks containment on every result; a violation is
surfaced in the UI. Dilation uses a 3-D chamfer distance transform.

Per-stage instructions are generated from *which* constraint was applied and the
*measured* volume removed — not canned text.

**This is geometry-based staging, not tool-path planning.**

## 8. Limitations

- Analysis runs on a **voxel grid** (~60³–60×150×60). Fine surface detail below
  the voxel size is lost; depth values are quantised (default 1 mm) on purpose.
- Silhouette outlines are traced from the voxel mask, so they're faceted at grid
  resolution, not vector-exact.
- Mesh simplification is **vertex clustering**, not quadric decimation — good
  enough for silhouettes/depth/voxels, not for display-quality reduction.
- "Up axis" detection is a heuristic; use the orientation buttons if it guesses
  wrong.
- Rough-cut suggestions are conservative (whole-slab, axis-aligned only) and
  explicitly **experimental**.
- Carvability scoring is a heuristic, not a simulation.
- The sandbox used to develop this couldn't reach `3d-api.si.edu` from a browser
  (a proxy stripped CORS headers); the curated catalogue path and the whole
  geometry pipeline are verified end-to-end in a headless browser, and the API's
  CORS headers are verified independently with `curl`.
- No PDF library is bundled — the guide is designed for the browser's print /
  "Save as PDF".

## 9. Development

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # typecheck + production build to dist/
npm run preview      # serve the production build
npm run catalogue    # regenerate the Smithsonian CC0 catalogue
npm run catalogue -- --enrich   # + verify CC0 via Open Access API (needs SI_API_KEY)
```

Node 20+. The Draco decoder lives in `public/draco/` and is served as a static
asset; `DRACOLoader` is pointed at `${BASE_URL}draco/`.

## 10. Testing

```bash
npm test             # vitest — geometry unit tests
npm run smoke        # headless-browser smoke test of the built app (needs chromium + `npm run preview`)
```

`tests/` covers the geometry algorithms against synthetic meshes with known
results:

- normalised dimensions, degenerate-triangle removal, simplification;
- auto-fit (fits inside blank, preserves aspect ratio, respects margin);
- voxel volume vs analytic volume for cube / sphere;
- projection extents, depth values, contour nesting;
- **`blank ⊇ stage₁ ⊇ … ⊇ final` for cube / sphere / cone / pawn**;
- safety-margin monotonicity;
- disconnected-part detection.

CI (`.github/workflows/deploy.yml`) runs `npm test` before every deploy.

## 11. GitHub Pages deployment

Pushing to `main` triggers the workflow: `npm ci` → `npm test` →
`npm run build` (with `BASE_PATH=/<repo>/` so Vite emits correct subpath URLs) →
upload `dist/` → `actions/deploy-pages`. A `404.html` copy of `index.html` is
included as an SPA fallback. Enable once under **Settings → Pages → Source:
GitHub Actions** (the workflow also self-configures via `actions/configure-pages`).

## 12. Future roadmap

### Geometry engine → Rust / WASM
Voxel ops, signed distance fields, contour extraction, mesh intersection, cut
planning and the expensive scoring are all pure functions behind
`geometry/analysis.ts` — prime candidates for a WASM core with the same interface.

### Physical carving intelligence
Grain direction, fragile-feature planning, clamping surfaces, knife/gouge/saw
accessibility, undercut planning, minimum safe thickness, grain-aware order of
operations.

### AR mode
The carving-stage representation (nested voxel envelopes + final mesh) is designed
to support later AR/VR: register the real block, overlay the target stage,
highlight excess material, compare progress. Not attempted here.

## 13. Attribution

3D models are surfaced from **[Smithsonian Open Access](https://www.si.edu/openaccess)**
and the **[Smithsonian 3D program](https://3d.si.edu)**, released under
**Creative Commons Zero (CC0)**. Individual object records are linked from each
card and in exported guides. WhittleGuide is not affiliated with the Smithsonian.

three.js (MIT). Draco decoder © The Draco Authors (Apache-2.0).

## 14. Screenshots

| Museum library | Workspace | Carving analysis |
| --- | --- | --- |
| ![home](docs/home.png) | ![workspace](docs/workspace.png) | ![guide](docs/guide.png) |

The workspace puts a translucent wooden blank around the model with labelled axes
and centre lines; the bottom tabs are Silhouette · Depth · Contours · Roughing ·
Guide/Print. (Screenshots captured on the deployed site; museum thumbnails are
blank here only because the capture environment couldn't reach `si.edu`.)

---

### Geometry-based assistance vs. intelligent carving planning

WhittleGuide today gives you **geometry-based carving assistance**: orthographic
templates, depth fields, contour maps and provably-safe removal envelopes.

It does **not** do **true tool-path / human-carving planning** — choosing knives
and gouges, planning cuts stroke by stroke, reasoning about wood grain, or
sequencing operations to protect fragile features. That is the long-term goal,
not the current state. Treat every generated cut and stage as guidance, subject
to your own judgement about the wood in front of you.
