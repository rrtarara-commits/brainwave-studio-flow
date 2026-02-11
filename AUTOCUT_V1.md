# Autocut V1

V1 generates a first-pass `edit_plan.json` from:
- Keynote deck (`.key`) as the timing backbone
- Optional script PDF cue extraction
- Optional presenter video duration check

## What It Produces

- `timeline.slide_timeline`
  - every slide/build stage segment with absolute time ranges
  - defaults: build hold `1s`, final slide hold `6s`
- `timeline.main_sequence`
  - intelligent source switching among:
    - `wide`
    - `punch`
    - `pip_slides`
- `premiere_blueprint`
  - track layout and clip objects to simplify FCPXML/Premiere conversion
- `script.cues` and `script.beats` (if PDF parsing available)

## Requirements

- macOS with Keynote installed
- `python3`
- optional for video duration: `ffprobe`
- optional for script parsing: `pypdf`

Install `pypdf` (recommended):

```bash
python3 -m venv .venv-autocut
source .venv-autocut/bin/activate
pip install pypdf
```

## Run

```bash
npm run autocut:v1 -- \
  --keynote "/Users/ray/Downloads/FVC25007-Keynote-V5.key" \
  --script-pdf "/Users/ray/Downloads/[DMS002] Script.pdf" \
  --video "/Users/ray/Downloads/FVC25007-Keynote-V5.mov" \
  --video-fit-mode append-oncam-tail \
  --output "./autocut_output/FVC25007_edit_plan.json"
```

If `pypdf` is not installed, the run still completes and emits a warning in `warnings`.

## Basic UI Launcher

Open a desktop UI for selecting assets and running batch builds:

```bash
npm run autocut:ui
```

UI supports:
- local file/folder selection for Keynote, Keynote animation MOV, video, and script PDF
- folder batch processing (multiple projects)
- optional Dropbox shared URL ingest via Dropbox API

Dropbox API notes:
- provide a Dropbox shared file or folder URL
- provide a Dropbox API access token
- assets are downloaded to a staging folder under your output root before processing

## Export To Premiere XML

Generate Premiere-importable XML (FCP7 `xmeml`) plus stage PNG assets:

```bash
npm run autocut:xml -- \
  --plan "./autocut_output/FVC25007_edit_plan.json" \
  --output "./autocut_output/FVC25007_premiere.xml"
```

This writes:
- XML timeline at the `--output` path
- stage assets at `./autocut_output/FVC25007_stages/` by default
- two sequences in the XML:
  - `*_MAIN` (delivery timeline)
  - `*_PIP_NEST` (nested PiP source used by `pip_slides` cuts)
- injected sequence markers for finishing:
  - intro/outro MOGRT markers
  - section/topic markers
  - cue markers (`GFX`, `MUSIC`, `BROLL`, `PIP`, `SLIDE`)

Import in Premiere:
1. `File -> Import...`
2. Select `FVC25007_premiere.xml`
3. Relink if prompted

## Export EDL Fallback

If Premiere XML import is unreliable on your version, export CMX3600 EDL:

```bash
npm run autocut:edl -- \
  --plan "./autocut_output/FVC25007_edit_plan.json" \
  --output "./autocut_output/FVC25007_main.edl"
```

EDL mode options:
- `--mode intercut` (default): one single-track cut list alternating on-cam and slides source
- `--mode oncam`: only wide/punch source events
- `--mode slides`: only `pip_slides` events (requires `--slides-video`)

Example split exports:

```bash
npm run autocut:edl -- --plan "./autocut_output/FVC25007_edit_plan.json" --output "./autocut_output/FVC25007_oncam.edl" --main-video "/Users/ray/Downloads/FVC25007-Keynote-V5.mov" --mode oncam
npm run autocut:edl -- --plan "./autocut_output/FVC25007_edit_plan.json" --output "./autocut_output/FVC25007_slides_overlay.edl" --main-video "/Users/ray/Downloads/FVC25007-Keynote-V5.mov" --slides-video "./autocut_output/FVC25007_slides_timed.mov" --mode slides
```

Important:
- CMX3600 EDL is inherently single video track.
- For layered workflows in Premiere, import split EDLs and combine them in a master sequence (on-cam base + slides overlay above).

## Render Timed Keynote MOV (Builds + Hold Frames)

Render a timed slide overlay MOV directly from a Keynote animation MOV:

```bash
npm run autocut:slidesmov -- \
  --plan "./autocut_output/FVC25007_edit_plan.json" \
  --keynote-mov "/Users/ray/Downloads/FVC25007-Keynote-V5.mov" \
  --output "./autocut_output/FVC25007_slides_timed.mov"
```

How this works:
- source stage playback uses `build_seconds` for `build_hold` stages
- source stage playback uses `slide_seconds` for `slide_hold` stages
- when target stage duration exceeds source stage playback, a freeze-hold is baked in

## Notes

- V1 is rule-based and deterministic.
- It does not yet use transcript alignment.
- If video is longer than slide timeline, V1 can append on-cam tail coverage (`--video-fit-mode append-oncam-tail`).
- For best results, V2 should align script/transcript semantics to slide stages and refine PiP/MOGRT automation.
