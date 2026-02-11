#!/usr/bin/env python3
"""Write Autocut V1 delivery manifest + Premiere import guide."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def reel_from_path(path_value: str, fallback: str) -> str:
    stem = Path(path_value).stem.strip() if path_value else ""
    if not stem:
        stem = fallback
    return stem.upper()[:8].ljust(8)


def resolve_optional(path_value: str | None) -> Path | None:
    if not path_value:
        return None
    return Path(path_value).expanduser().resolve()


def artifact_record(path_value: Path | None) -> dict[str, object]:
    if path_value is None:
        return {"path": None, "exists": False, "size_bytes": None}
    exists = path_value.exists()
    return {
        "path": str(path_value),
        "exists": exists,
        "size_bytes": path_value.stat().st_size if exists else None,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Write delivery manifest for Autocut artifacts.")
    parser.add_argument("--plan", required=True, help="Path to edit_plan.json")
    parser.add_argument("--project-dir", help="Project output folder (defaults to plan parent)")
    parser.add_argument("--main-video", help="Main/on-cam source video")
    parser.add_argument("--slides-video", help="Timed slides MOV source")
    parser.add_argument("--xml", help="Premiere XML output path")
    parser.add_argument("--main-edl", help="Intercut EDL path")
    parser.add_argument("--oncam-edl", help="On-cam-only EDL path")
    parser.add_argument("--slides-edl", help="Slides-overlay EDL path")
    parser.add_argument("--manifest-json", help="Manifest JSON output path")
    parser.add_argument("--import-guide", help="Premiere import guide markdown output path")
    return parser.parse_args()


def build_import_steps(payload: dict[str, object]) -> list[str]:
    artifacts = payload["artifacts"]
    reels = payload["reels"]
    steps: list[str] = []

    oncam = artifacts["oncam_edl"]
    slides = artifacts["slides_overlay_edl"]
    intercut = artifacts["main_intercut_edl"]
    xml = artifacts["premiere_xml"]
    main_reel = reels["main"]["reel"]
    slides_reel = reels["slides"]["reel"] if reels["slides"] else None

    if oncam["exists"] and slides["exists"] and reels["slides"]:
        steps.append(f"Import `{oncam['path']}`.")
        steps.append(
            f"Relink reel `{main_reel}` to `{reels['main']['source_path']}`."
        )
        steps.append(f"Import `{slides['path']}`.")
        steps.append(
            f"Relink reel `{slides_reel}` to `{reels['slides']['source_path']}`."
        )
        steps.append(
            "Use the on-cam sequence as the base timeline and stack the slides sequence above it."
        )
        steps.append("Adjust PiP framing and branding overlays in your finishing pass.")
        return steps

    if intercut["exists"]:
        steps.append(f"Import `{intercut['path']}`.")
        steps.append(
            f"Relink reel `{main_reel}` to `{reels['main']['source_path']}`."
        )
        if reels["slides"]:
            steps.append(
                f"Relink reel `{slides_reel}` to `{reels['slides']['source_path']}`."
            )
        steps.append("This intercut EDL is single-track; layer graphics/PiP in a finishing pass.")
        return steps

    if xml["exists"]:
        steps.append(f"Import `{xml['path']}`.")
        steps.append("Relink media if prompted.")
        steps.append("If import fails in your Premiere version, switch to EDL fallback exports.")
        return steps

    steps.append("No importable XML/EDL artifact was detected. Re-run with export options enabled.")
    return steps


def build_markdown(payload: dict[str, object], steps: list[str]) -> str:
    artifacts = payload["artifacts"]
    reels = payload["reels"]

    lines: list[str] = []
    lines.append(f"# {payload['project_name']} Delivery Manifest")
    lines.append("")
    lines.append(f"- Generated: {payload['generated_at_utc']}")
    lines.append("")
    lines.append("## Reel Mapping")
    lines.append("")
    lines.append(
        f"- Main reel `{reels['main']['reel']}` -> `{reels['main']['source_path']}`"
    )
    if reels["slides"]:
        lines.append(
            f"- Slides reel `{reels['slides']['reel']}` -> `{reels['slides']['source_path']}`"
        )
    else:
        lines.append("- Slides reel: not available (no timed slides MOV supplied)")
    lines.append("")
    lines.append("## Artifacts")
    lines.append("")
    for key in (
        "edit_plan",
        "premiere_xml",
        "main_intercut_edl",
        "oncam_edl",
        "slides_overlay_edl",
        "slides_timed_mov",
    ):
        item = artifacts[key]
        status = "yes" if item["exists"] else "no"
        lines.append(f"- `{key}`: exists={status}, path=`{item['path']}`")
    lines.append("")
    lines.append("## Premiere Import Order")
    lines.append("")
    for idx, step in enumerate(steps, start=1):
        lines.append(f"{idx}. {step}")
    lines.append("")
    lines.append("## Notes")
    lines.append("")
    lines.append("- CMX3600 EDL is single-track by design.")
    lines.append("- Use split EDLs (`oncam` + `slides_overlay`) when you need layered assembly.")
    lines.append("- Keep the timed slides MOV and source on-cam video in a stable path before relinking.")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    args = parse_args()

    plan_path = Path(args.plan).expanduser().resolve()
    if not plan_path.exists():
        fail(f"plan JSON not found: {plan_path}")

    payload = json.loads(plan_path.read_text(encoding="utf-8"))
    project_name = str(payload.get("project_name") or plan_path.stem).upper()
    project_dir = (
        Path(args.project_dir).expanduser().resolve()
        if args.project_dir
        else plan_path.parent.resolve()
    )
    project_dir.mkdir(parents=True, exist_ok=True)

    main_video_input = str(args.main_video or payload.get("inputs", {}).get("video") or project_name)
    slides_video_input = str(args.slides_video or "")

    main_reel = reel_from_path(main_video_input, fallback=project_name).rstrip()
    slides_reel: str | None = None
    if slides_video_input:
        raw_slides_reel = reel_from_path(slides_video_input, fallback=f"{project_name[:6]}SL")
        if raw_slides_reel.strip() == main_reel:
            raw_slides_reel = f"SLD{project_name}"[:8].ljust(8)
        slides_reel = raw_slides_reel.rstrip()

    xml_path = resolve_optional(args.xml)
    main_edl_path = resolve_optional(args.main_edl)
    oncam_edl_path = resolve_optional(args.oncam_edl)
    slides_edl_path = resolve_optional(args.slides_edl)
    slides_mov_path = resolve_optional(args.slides_video)

    manifest_json_path = (
        resolve_optional(args.manifest_json)
        if args.manifest_json
        else project_dir / f"{project_name}_delivery_manifest.json"
    )
    import_guide_path = (
        resolve_optional(args.import_guide)
        if args.import_guide
        else project_dir / f"{project_name}_premiere_import.md"
    )
    if manifest_json_path is None or import_guide_path is None:
        fail("failed to resolve manifest output paths")

    manifest_payload: dict[str, object] = {
        "project_name": project_name,
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "project_dir": str(project_dir),
        "reels": {
            "main": {
                "reel": main_reel,
                "source_path": main_video_input,
            },
            "slides": (
                {
                    "reel": slides_reel,
                    "source_path": slides_video_input,
                }
                if slides_reel
                else None
            ),
        },
        "artifacts": {
            "edit_plan": artifact_record(plan_path),
            "premiere_xml": artifact_record(xml_path),
            "main_intercut_edl": artifact_record(main_edl_path),
            "oncam_edl": artifact_record(oncam_edl_path),
            "slides_overlay_edl": artifact_record(slides_edl_path),
            "slides_timed_mov": artifact_record(slides_mov_path),
        },
        "notes": {
            "edl_is_single_track": True,
            "recommended_premiere_mode": "split_edl_overlay",
        },
    }

    steps = build_import_steps(manifest_payload)
    manifest_payload["premiere_import_steps"] = steps

    manifest_json_path.parent.mkdir(parents=True, exist_ok=True)
    import_guide_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_json_path.write_text(json.dumps(manifest_payload, indent=2) + "\n", encoding="utf-8")
    import_guide_path.write_text(build_markdown(manifest_payload, steps), encoding="utf-8")

    print(f"Wrote manifest JSON: {manifest_json_path}")
    print(f"Wrote import guide: {import_guide_path}")


if __name__ == "__main__":
    main()
