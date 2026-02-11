#!/usr/bin/env python3
"""Render a timed Keynote overlay MOV using stage timing + hold frames.

Input:
- Autocut V1 edit plan JSON (slide_timeline + timing_defaults)
- Keynote animation MOV (source stages/builds in order)

Output:
- A single MOV where each stage is timed to slide_timeline.
- If target stage duration exceeds source play duration, frame holds are baked in.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def run_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, capture_output=True, check=True)


def ffprobe_video_info(path: Path) -> dict[str, Any]:
    if shutil.which("ffprobe") is None:
        fail("ffprobe is required (install ffmpeg).")

    try:
        result = run_command(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,r_frame_rate,width,height",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                str(path),
            ]
        )
        payload = json.loads(result.stdout)
    except Exception as exc:
        fail(f"ffprobe failed for {path}: {exc}")
        return {}

    duration_sec = None
    try:
        duration_sec = float(payload.get("format", {}).get("duration"))
    except Exception:
        duration_sec = None

    fps = None
    width = None
    height = None
    for stream in payload.get("streams", []):
        if stream.get("codec_type") != "video":
            continue
        width = stream.get("width")
        height = stream.get("height")
        rate = str(stream.get("r_frame_rate") or "")
        if "/" in rate:
            num, den = rate.split("/", 1)
            try:
                num_i = int(num)
                den_i = int(den)
                if den_i > 0:
                    fps = float(num_i) / float(den_i)
            except Exception:
                fps = None
        break

    return {
        "duration_sec": duration_sec,
        "fps": fps,
        "width": width,
        "height": height,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render timed Keynote overlay MOV with baked hold frames."
    )
    parser.add_argument("--plan", required=True, help="Path to edit_plan.json")
    parser.add_argument("--keynote-mov", required=True, help="Source Keynote animation MOV path")
    parser.add_argument("--output", required=True, help="Output timed MOV path")
    parser.add_argument(
        "--source-build-seconds",
        type=float,
        help="Source build-stage play duration (defaults to plan timing_defaults.build_seconds)",
    )
    parser.add_argument(
        "--source-slide-seconds",
        type=float,
        help="Source final-stage play duration (defaults to plan timing_defaults.slide_seconds)",
    )
    parser.add_argument(
        "--fps",
        type=int,
        help="Output fps (defaults to plan timing_defaults.fps, then source fps, then 30)",
    )
    parser.add_argument(
        "--codec",
        choices=["prores", "h264"],
        default="prores",
        help="Output codec (prores recommended for editing).",
    )
    return parser.parse_args()


def fmt(value: float) -> str:
    return f"{value:.6f}".rstrip("0").rstrip(".")


def main() -> None:
    args = parse_args()
    plan_path = Path(args.plan).expanduser().resolve()
    source_mov_path = Path(args.keynote_mov).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()

    if not plan_path.exists():
        fail(f"plan JSON not found: {plan_path}")
    if not source_mov_path.exists():
        fail(f"keynote MOV not found: {source_mov_path}")
    if shutil.which("ffmpeg") is None:
        fail("ffmpeg is required (install ffmpeg).")

    payload = json.loads(plan_path.read_text(encoding="utf-8"))
    slide_timeline = list(payload.get("timeline", {}).get("slide_timeline", []))
    if not slide_timeline:
        fail("plan has no timeline.slide_timeline entries")

    defaults = payload.get("timing_defaults", {})
    source_build_seconds = float(
        args.source_build_seconds
        if args.source_build_seconds is not None
        else defaults.get("build_seconds", 1.0)
    )
    source_slide_seconds = float(
        args.source_slide_seconds
        if args.source_slide_seconds is not None
        else defaults.get("slide_seconds", 6.0)
    )

    info = ffprobe_video_info(source_mov_path)
    source_duration = float(info.get("duration_sec") or 0.0)
    if source_duration <= 0:
        fail(f"could not read source MOV duration: {source_mov_path}")

    fps = int(args.fps or defaults.get("fps") or round(float(info.get("fps") or 30.0)) or 30)
    fps = max(1, fps)
    frame_sec = 1.0 / float(fps)

    # Build source-play / hold render segments.
    source_cursor = 0.0
    segments: list[dict[str, Any]] = []
    hold_count = 0

    for idx, stage in enumerate(slide_timeline, start=1):
        kind = str(stage.get("kind") or "slide_hold")
        target_duration = float(stage.get("duration_sec") or 0.0)
        if target_duration <= 0:
            continue

        stage_source_play = source_build_seconds if kind == "build_hold" else source_slide_seconds
        stage_source_play = max(frame_sec, stage_source_play)
        stage_source_start = source_cursor
        stage_source_end = stage_source_start + stage_source_play

        available_from_start = max(0.0, source_duration - stage_source_start)
        play_duration = min(target_duration, stage_source_play, available_from_start)
        play_duration = max(0.0, play_duration)

        if play_duration >= (frame_sec * 0.5):
            play_start = min(stage_source_start, max(0.0, source_duration - frame_sec))
            play_end = min(play_start + play_duration, source_duration)
            if play_end - play_start >= (frame_sec * 0.5):
                segments.append(
                    {
                        "type": "play",
                        "segment_index": idx,
                        "src_start": play_start,
                        "src_end": play_end,
                        "duration": play_end - play_start,
                    }
                )
                target_duration -= (play_end - play_start)

        # Any remaining target duration becomes a hold on the stage's final frame.
        if target_duration >= (frame_sec * 0.5):
            freeze_at = min(stage_source_end, source_duration) - frame_sec
            freeze_at = max(0.0, freeze_at)
            freeze_end = min(source_duration, freeze_at + frame_sec)
            if freeze_end - freeze_at < (frame_sec * 0.5):
                freeze_at = max(0.0, source_duration - frame_sec)
                freeze_end = source_duration
            hold_duration = max(frame_sec, target_duration)
            segments.append(
                {
                    "type": "hold",
                    "segment_index": idx,
                    "src_start": freeze_at,
                    "src_end": freeze_end,
                    "duration": hold_duration,
                }
            )
            hold_count += 1

        source_cursor = stage_source_end

    if not segments:
        fail("no renderable segments could be built from slide_timeline")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Build ffmpeg filter_complex.
    filter_parts: list[str] = []
    concat_inputs: list[str] = []
    for index, segment in enumerate(segments):
        label = f"seg{index}"
        src_start = fmt(float(segment["src_start"]))
        src_end = fmt(float(segment["src_end"]))
        duration = fmt(float(segment["duration"]))
        if segment["type"] == "hold":
            part = (
                f"[0:v]trim=start={src_start}:end={src_end},"
                f"setpts=PTS-STARTPTS,"
                f"tpad=stop_mode=clone:stop_duration={duration}"
                f"[{label}]"
            )
        else:
            part = f"[0:v]trim=start={src_start}:end={src_end},setpts=PTS-STARTPTS[{label}]"
        filter_parts.append(part)
        concat_inputs.append(f"[{label}]")

    concat_chain = "".join(concat_inputs) + f"concat=n={len(segments)}:v=1:a=0[vcat]"
    format_chain = f"[vcat]fps={fps},setsar=1[vout]"
    filter_parts.append(concat_chain)
    filter_parts.append(format_chain)
    filter_complex = ";".join(filter_parts)

    command = [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-i",
        str(source_mov_path),
        "-filter_complex",
        filter_complex,
        "-map",
        "[vout]",
        "-an",
    ]

    if args.codec == "h264":
        command.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium"])
        command.extend(["-movflags", "+faststart"])
    else:
        command.extend(["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"])

    command.append(str(output_path))

    try:
        run_command(command)
    except subprocess.CalledProcessError as exc:
        fail(f"ffmpeg render failed: {exc.stderr.strip() or exc.stdout.strip() or exc}")

    total_output_duration = sum(float(s["duration"]) for s in segments)
    print(f"Wrote timed overlay MOV: {output_path}")
    print(
        json.dumps(
            {
                "source_keynote_mov": str(source_mov_path),
                "source_duration_sec": round(source_duration, 3),
                "output_duration_sec": round(total_output_duration, 3),
                "fps": fps,
                "segments": len(segments),
                "hold_segments": hold_count,
                "source_build_seconds": source_build_seconds,
                "source_slide_seconds": source_slide_seconds,
                "codec": args.codec,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

