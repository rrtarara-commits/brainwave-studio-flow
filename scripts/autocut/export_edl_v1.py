#!/usr/bin/env python3
"""Export Autocut V1 JSON into a CMX3600 EDL (main cut track).

This is a compatibility fallback for NLEs when XML import is unreliable.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def seconds_to_frames(seconds: float, fps: int) -> int:
    return max(0, int(round(seconds * fps)))


def frames_to_tc(frames: int, fps: int) -> str:
    hours = frames // (fps * 3600)
    frames -= hours * fps * 3600
    minutes = frames // (fps * 60)
    frames -= minutes * fps * 60
    seconds = frames // fps
    frame_num = frames - seconds * fps
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}:{frame_num:02d}"


def reel_from_path(path_value: str, fallback: str) -> str:
    stem = Path(path_value).stem.strip() if path_value else ""
    if not stem:
        stem = fallback
    return stem.upper()[:8].ljust(8)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export Autocut V1 edit plan JSON to CMX3600 EDL (main cut track)."
    )
    parser.add_argument("--plan", required=True, help="Path to edit_plan.json")
    parser.add_argument("--output", help="Output EDL path")
    parser.add_argument("--fps", type=int, help="Override fps")
    parser.add_argument("--main-video", help="Main/on-cam source file path (for reel naming)")
    parser.add_argument(
        "--slides-video",
        help=(
            "Optional timed slides MOV source. "
            "When provided, pip_slides events use this reel/time source."
        ),
    )
    parser.add_argument(
        "--include-comments",
        action="store_true",
        help="Include FROM CLIP NAME / COMMENT lines in EDL.",
    )
    parser.add_argument(
        "--mode",
        choices=["intercut", "oncam", "slides"],
        default="intercut",
        help=(
            "EDL mode: "
            "intercut=alternating main + pip_slides (single-track), "
            "oncam=wide/punch only, "
            "slides=pip_slides only."
        ),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    plan_path = Path(args.plan).expanduser().resolve()
    if not plan_path.exists():
        fail(f"plan JSON not found: {plan_path}")

    payload = json.loads(plan_path.read_text(encoding="utf-8"))
    timeline = payload.get("timeline", {})
    main_sequence = list(timeline.get("main_sequence", []))
    if not main_sequence:
        fail("plan has no timeline.main_sequence entries")
    if args.mode == "slides" and not args.slides_video:
        fail("--mode slides requires --slides-video")

    project_name = str(payload.get("project_name") or plan_path.stem).upper()
    main_video_input = str(args.main_video or payload.get("inputs", {}).get("video") or project_name)
    source_reel_main = reel_from_path(main_video_input, fallback=project_name)
    source_reel_slides = reel_from_path(args.slides_video or "", fallback=f"{project_name[:6]}SL")
    if args.slides_video and source_reel_slides.strip() == source_reel_main.strip():
        source_reel_slides = f"SLD{project_name}"[:8].ljust(8)

    fps = int(args.fps or payload.get("timing_defaults", {}).get("fps") or 30)

    if args.output:
        output_path = Path(args.output).expanduser().resolve()
    else:
        output_path = plan_path.with_suffix(".edl")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    filtered_sequence: list[dict] = []
    for clip in main_sequence:
        source = str(clip.get("source", "")).lower()
        if args.mode == "oncam" and source == "pip_slides":
            continue
        if args.mode == "slides" and source != "pip_slides":
            continue
        filtered_sequence.append(clip)
    if not filtered_sequence:
        fail(f"no events matched mode={args.mode}")

    lines: list[str] = []
    lines.append(f"TITLE: {project_name}_AUTOCUT_{args.mode.upper()}")
    lines.append("FCM: NON-DROP FRAME")
    lines.append("")

    pip_events = 0
    for idx, clip in enumerate(filtered_sequence, start=1):
        rec_in = seconds_to_frames(float(clip.get("start_sec", 0.0)), fps)
        rec_out = seconds_to_frames(float(clip.get("end_sec", 0.0)), fps)
        duration = max(1, rec_out - rec_in)
        source = str(clip.get("source", "")).lower()
        use_slides_source = bool(args.slides_video and source == "pip_slides")
        source_reel = source_reel_slides if use_slides_source else source_reel_main
        if use_slides_source:
            pip_events += 1

        # Both source files are expected to be timeline-aligned from 00:00:00:00.
        src_in = rec_in
        src_out = rec_in + duration

        event = (
            f"{idx:03d}  {source_reel} V     C        "
            f"{frames_to_tc(src_in, fps)} {frames_to_tc(src_out, fps)} "
            f"{frames_to_tc(rec_in, fps)} {frames_to_tc(rec_out, fps)}"
        )
        lines.append(event)

        if args.include_comments:
            source_upper = str(clip.get("source", "clip")).upper()
            reason = str(clip.get("reason") or "").strip()
            lines.append(f"* FROM CLIP NAME: {source_upper}_{idx:04d}")
            if reason:
                lines.append(f"* COMMENT: {reason[:220]}")

    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote EDL: {output_path}")
    print(
        json.dumps(
            {
                "project_name": project_name,
                "mode": args.mode,
                "fps": fps,
                "events_total": len(main_sequence),
                "events_exported": len(filtered_sequence),
                "main_reel": source_reel_main.rstrip(),
                "slides_reel": source_reel_slides.rstrip() if args.slides_video else None,
                "pip_events_using_slides_reel": pip_events,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
