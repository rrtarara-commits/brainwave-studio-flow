#!/usr/bin/env python3
"""Autocut V1: build a first-pass edit plan from Keynote + optional script + video.

This V1 is intentionally rule-based:
- Keynote is the timing backbone (slide/build stage sequence)
- Script cues (if available) influence camera source preference
- Main sequence switches among wide / punch / pip_slides
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any


CUE_PATTERN = re.compile(r"(?i)\b(ON-?CAM|SLIDE|PIP|B-?ROLL|GFX|MUSIC)\b")
SECTION_PATTERN = re.compile(r"^\[.+\]$")
IMAGE_NUM_PATTERN = re.compile(r"\.(\d+)\.png$", re.IGNORECASE)


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def run_command(
    command: list[str],
    *,
    capture_output: bool = True,
    check: bool = True,
    text: bool = True,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=check,
        capture_output=capture_output,
        text=text,
        input=input_text,
    )


def seconds_to_timecode(seconds: float, fps: int) -> str:
    total_frames = max(0, int(round(seconds * fps)))
    frames = total_frames % fps
    total_seconds = total_frames // fps
    secs = total_seconds % 60
    total_minutes = total_seconds // 60
    minutes = total_minutes % 60
    hours = total_minutes // 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d}:{frames:02d}"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sorted_exported_images(directory: Path) -> list[Path]:
    candidates = [p for p in directory.glob("*.png") if p.is_file()]

    def image_sort_key(path: Path) -> tuple[int, str]:
        match = IMAGE_NUM_PATTERN.search(path.name)
        if not match:
            return (10**9, path.name)
        return (int(match.group(1)), path.name)

    return sorted(candidates, key=image_sort_key)


def export_keynote_images(keynote_path: Path, output_dir: Path, all_stages: bool) -> int:
    if shutil.which("osascript") is None:
        fail("osascript is required for Keynote automation on macOS.")

    export_mode = "all" if all_stages else "final"
    applescript = """
on run argv
  set keynotePosixPath to item 1 of argv
  set outputPosixDir to item 2 of argv
  set exportMode to item 3 of argv
  tell application "Keynote"
    set d to open POSIX file keynotePosixPath
    if exportMode is "all" then
      export d to (POSIX file outputPosixDir as alias) as slide images with properties {all stages:true}
    else
      export d to (POSIX file outputPosixDir as alias) as slide images
    end if
    set slideCount to count of slides of d
    close d saving no
    return slideCount as string
  end tell
end run
""".strip()

    result = run_command(
        [
            "osascript",
            "-e",
            applescript,
            str(keynote_path),
            str(output_dir),
            export_mode,
        ]
    )
    output = (result.stdout or "").strip()
    try:
        return int(output)
    except ValueError:
        fail(f"unexpected Keynote export output: {output}")
    return 0


def parse_script_pdf(script_pdf: Path) -> dict[str, Any]:
    try:
        from pypdf import PdfReader  # type: ignore
    except Exception:
        return {
            "available": False,
            "warning": "pypdf not installed; skipping PDF cue extraction.",
            "cue_counts": {},
            "cue_lines": [],
            "section_tags": [],
        }

    reader = PdfReader(str(script_pdf))
    all_lines: list[str] = []
    for page in reader.pages:
        text = (page.extract_text() or "").replace("\r", "\n")
        for line in text.splitlines():
            clean = " ".join(line.split())
            if clean:
                all_lines.append(clean)

    section_tags = [line for line in all_lines if SECTION_PATTERN.match(line)]

    cue_lines: list[dict[str, Any]] = []
    cue_counts: Counter[str] = Counter()
    seen_line: set[str] = set()
    for line in all_lines:
        match = CUE_PATTERN.search(line)
        if not match:
            continue
        cue = match.group(1).upper().replace("-", "")
        cue_counts[cue] += 1
        if line in seen_line:
            continue
        seen_line.add(line)
        cue_lines.append({"cue": cue, "text": line})

    return {
        "available": True,
        "warning": None,
        "cue_counts": dict(cue_counts),
        "cue_lines": cue_lines,
        "section_tags": section_tags,
    }


def cue_to_preference(cue: str) -> str | None:
    if cue in {"SLIDE", "PIP"}:
        return "pip_slides"
    if cue == "ONCAM":
        return "oncam"
    if cue == "BROLL":
        return "broll"
    return None


def ffprobe_duration(video_path: Path) -> float | None:
    if shutil.which("ffprobe") is None:
        return None
    try:
        result = run_command(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(video_path),
            ]
        )
        return float((result.stdout or "").strip())
    except Exception:
        return None


def build_script_beats(cue_lines: list[dict[str, Any]], timeline_duration: float) -> list[dict[str, Any]]:
    if not cue_lines or timeline_duration <= 0:
        return []
    slot = timeline_duration / len(cue_lines)
    beats: list[dict[str, Any]] = []
    for index, cue_line in enumerate(cue_lines):
        start = index * slot
        end = (index + 1) * slot
        beats.append(
            {
                "index": index + 1,
                "start_sec": round(start, 3),
                "end_sec": round(end, 3),
                "cue": cue_line["cue"],
                "text": cue_line["text"],
                "preferred_source": cue_to_preference(cue_line["cue"]),
            }
        )
    return beats


def preference_at_time(script_beats: list[dict[str, Any]], when_sec: float) -> str | None:
    for beat in script_beats:
        if beat["start_sec"] <= when_sec < beat["end_sec"]:
            return beat.get("preferred_source")
    return None


def merge_adjacent_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not segments:
        return []

    merged: list[dict[str, Any]] = []
    for segment in segments:
        if not merged:
            merged.append(dict(segment))
            merged[-1]["reasons"] = [segment["reason"]]
            continue

        previous = merged[-1]
        contiguous = math.isclose(previous["end_sec"], segment["start_sec"], abs_tol=1e-6)
        if contiguous and previous["source"] == segment["source"]:
            previous["end_sec"] = segment["end_sec"]
            previous["duration_sec"] = round(previous["end_sec"] - previous["start_sec"], 3)
            previous["reasons"].append(segment["reason"])
            continue

        merged.append(dict(segment))
        merged[-1]["reasons"] = [segment["reason"]]
    return merged


def segment_end(segments: list[dict[str, Any]]) -> float:
    if not segments:
        return 0.0
    return max(float(s["end_sec"]) for s in segments)


def duration_to_frames(seconds: float, fps: int, *, min_frames: int = 1) -> int:
    return max(min_frames, int(round(seconds * fps)))


def retime_slide_timeline_to_target(
    *,
    slide_timeline: list[dict[str, Any]],
    target_duration_sec: float,
    fps: int,
    min_build_seconds: float,
    min_slide_seconds: float,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not slide_timeline:
        return slide_timeline, {"retimed": False}

    frame_counts = [duration_to_frames(float(seg["duration_sec"]), fps) for seg in slide_timeline]
    base_total = sum(frame_counts)
    target_total = max(len(frame_counts), int(round(target_duration_sec * fps)))

    build_indices = [i for i, seg in enumerate(slide_timeline) if seg.get("kind") == "build_hold"]
    slide_indices = [i for i, seg in enumerate(slide_timeline) if seg.get("kind") == "slide_hold"]

    build_min_frames = duration_to_frames(min_build_seconds, fps)
    slide_min_frames = duration_to_frames(min_slide_seconds, fps)
    min_frames_by_index = {
        i: (build_min_frames if i in build_indices else slide_min_frames) for i in range(len(frame_counts))
    }

    def add_frames(indices: list[int], frames_to_add: int) -> None:
        if frames_to_add <= 0 or not indices:
            return
        weights: dict[int, int] = {}
        for idx in indices:
            seg = slide_timeline[idx]
            weight = 1
            if seg.get("kind") == "slide_hold":
                weight = 2 + max(0, int(seg.get("stage_count_for_slide", 1)) - 1)
            weights[idx] = max(1, weight)

        total_weight = sum(weights.values()) or 1
        allocated = 0
        for idx in indices:
            share = int((frames_to_add * weights[idx]) / total_weight)
            if share > 0:
                frame_counts[idx] += share
                allocated += share

        remainder = frames_to_add - allocated
        if remainder <= 0:
            return
        order = sorted(indices, key=lambda i: (weights[i], -i), reverse=True)
        cursor = 0
        while remainder > 0 and order:
            frame_counts[order[cursor]] += 1
            remainder -= 1
            cursor = (cursor + 1) % len(order)

    def remove_frames(indices: list[int], frames_to_remove: int) -> int:
        if frames_to_remove <= 0 or not indices:
            return frames_to_remove
        remainder = frames_to_remove
        while remainder > 0:
            candidates = sorted(
                indices,
                key=lambda idx: frame_counts[idx] - min_frames_by_index[idx],
                reverse=True,
            )
            progressed = False
            for idx in candidates:
                if frame_counts[idx] <= min_frames_by_index[idx]:
                    continue
                frame_counts[idx] -= 1
                remainder -= 1
                progressed = True
                if remainder <= 0:
                    break
            if not progressed:
                break
        return remainder

    if target_total > base_total:
        extra = target_total - base_total
        if slide_indices:
            add_frames(slide_indices, extra)
        else:
            add_frames(list(range(len(frame_counts))), extra)
    elif target_total < base_total:
        deficit = base_total - target_total
        remainder = remove_frames(slide_indices, deficit)
        if remainder > 0:
            remainder = remove_frames(build_indices, remainder)
        if remainder > 0:
            remove_frames(list(range(len(frame_counts))), remainder)

    retimed: list[dict[str, Any]] = []
    cursor_frames = 0
    for seg, frames in zip(slide_timeline, frame_counts):
        start_frames = cursor_frames
        end_frames = start_frames + max(1, frames)
        cursor_frames = end_frames
        new_seg = dict(seg)
        new_seg["start_sec"] = round(start_frames / fps, 3)
        new_seg["end_sec"] = round(end_frames / fps, 3)
        new_seg["duration_sec"] = round((end_frames - start_frames) / fps, 3)
        retimed.append(new_seg)

    return retimed, {
        "retimed": True,
        "base_duration_sec": round(base_total / fps, 3),
        "target_duration_sec": round(target_total / fps, 3),
        "result_duration_sec": round(cursor_frames / fps, 3),
        "build_min_seconds": min_build_seconds,
        "slide_min_seconds": min_slide_seconds,
    }


def build_oncam_tail_segments(
    *,
    start_sec: float,
    end_sec: float,
    shot_clock_seconds: float,
    oncam_toggle_start: int,
) -> tuple[list[dict[str, Any]], int]:
    segments: list[dict[str, Any]] = []
    cursor = start_sec
    oncam_toggle = oncam_toggle_start
    while cursor < end_sec - 1e-6:
        remaining = end_sec - cursor
        take = min(shot_clock_seconds, remaining)
        source = "wide" if oncam_toggle % 2 == 0 else "punch"
        oncam_toggle += 1
        segments.append(
            {
                "start_sec": round(cursor, 3),
                "end_sec": round(cursor + take, 3),
                "duration_sec": round(take, 3),
                "source": source,
                "reason": "video_tail_no_slides",
                "linked_slide_index": None,
                "linked_stage_index": None,
            }
        )
        cursor += take
    return segments, oncam_toggle


def build_premiere_blueprint(
    *,
    project_name: str,
    fps: int,
    video_path: Path | None,
    main_sequence: list[dict[str, Any]],
    slide_timeline: list[dict[str, Any]],
) -> dict[str, Any]:
    main_clips: list[dict[str, Any]] = []
    for idx, seg in enumerate(main_sequence, start=1):
        main_clips.append(
            {
                "clip_id": f"main_{idx:04d}",
                "source_id": seg["source"],
                "track": "V1",
                "start_sec": seg["start_sec"],
                "end_sec": seg["end_sec"],
                "duration_sec": seg["duration_sec"],
                "start_tc": seconds_to_timecode(seg["start_sec"], fps),
                "end_tc": seconds_to_timecode(seg["end_sec"], fps),
                "reason": seg.get("reason"),
                "reasons": seg.get("reasons", []),
                "linked_slide_index": seg.get("linked_slide_index"),
                "linked_stage_index": seg.get("linked_stage_index"),
            }
        )

    slide_clips: list[dict[str, Any]] = []
    for idx, seg in enumerate(slide_timeline, start=1):
        slide_clips.append(
            {
                "clip_id": f"slide_stage_{idx:04d}",
                "stage_asset_id": f"stage_{seg['global_stage_index']:04d}",
                "track": "V3",
                "start_sec": seg["start_sec"],
                "end_sec": seg["end_sec"],
                "duration_sec": seg["duration_sec"],
                "start_tc": seconds_to_timecode(seg["start_sec"], fps),
                "end_tc": seconds_to_timecode(seg["end_sec"], fps),
                "slide_index": seg["slide_index"],
                "stage_index": seg["stage_index"],
                "kind": seg["kind"],
            }
        )

    return {
        "sequence_name": f"{project_name}_MAIN",
        "timebase_fps": fps,
        "track_layout": [
            {"track": "V6", "role": "alpha_wipes"},
            {"track": "V5", "role": "branding_intros_endcards"},
            {"track": "V4", "role": "pip_overlay"},
            {"track": "V3", "role": "slides_stage_timeline"},
            {"track": "V2", "role": "oncam_punch"},
            {"track": "V1", "role": "main_program_switch"},
        ],
        "source_assignments": {
            "wide": {
                "type": "video_file",
                "path": str(video_path) if video_path else None,
                "note": "Primary on-cam wide shot source.",
            },
            "punch": {
                "type": "derived_crop",
                "from": "wide",
                "note": "Simulated close-up from wide source.",
            },
            "pip_slides": {
                "type": "nested_sequence",
                "sequence_name": f"{project_name}_PIP_SLIDES",
                "note": "Render from slide_timeline in V3 with speaker PiP on V4.",
            },
        },
        "main_sequence_clips": main_clips,
        "pip_slides_sequence_clips": slide_clips,
    }


def determine_stage_groups(final_images: list[Path], staged_images: list[Path]) -> list[tuple[int, int]]:
    if not final_images:
        fail("Keynote final slide export produced zero images.")
    if not staged_images:
        fail("Keynote all-stages export produced zero images.")

    final_hashes = [sha256_file(path) for path in final_images]
    stage_hashes = [sha256_file(path) for path in staged_images]

    groups: list[tuple[int, int]] = []
    cursor = 0
    for final_hash in final_hashes:
        match_index = None
        for stage_index in range(cursor, len(stage_hashes)):
            if stage_hashes[stage_index] == final_hash:
                match_index = stage_index
                break

        if match_index is None:
            # Fallback: if no hash match is found, assign one stage and continue.
            fallback_index = min(cursor, len(stage_hashes) - 1)
            groups.append((fallback_index, fallback_index))
            cursor = fallback_index + 1
            continue

        start_index = cursor
        end_index = match_index
        if end_index < start_index:
            end_index = start_index
        groups.append((start_index, end_index))
        cursor = match_index + 1

    if groups and cursor < len(stage_hashes):
        last_start, _last_end = groups[-1]
        groups[-1] = (last_start, len(stage_hashes) - 1)

    return groups


def build_plan(args: argparse.Namespace) -> dict[str, Any]:
    keynote_path = Path(args.keynote).expanduser().resolve()
    if not keynote_path.exists():
        fail(f"keynote file not found: {keynote_path}")
    if keynote_path.suffix.lower() != ".key":
        fail("keynote input must be a .key file")

    script_pdf_path: Path | None = None
    if args.script_pdf:
        script_pdf_path = Path(args.script_pdf).expanduser().resolve()
        if not script_pdf_path.exists():
            fail(f"script PDF not found: {script_pdf_path}")

    video_path: Path | None = None
    if args.video:
        video_path = Path(args.video).expanduser().resolve()
        if not video_path.exists():
            fail(f"video file not found: {video_path}")

    with tempfile.TemporaryDirectory(prefix="autocut-v1-") as temp_dir:
        temp_root = Path(temp_dir)
        final_export_dir = temp_root / "final_slides"
        staged_export_dir = temp_root / "all_stages"
        final_export_dir.mkdir(parents=True, exist_ok=True)
        staged_export_dir.mkdir(parents=True, exist_ok=True)

        slide_count = export_keynote_images(keynote_path, final_export_dir, all_stages=False)
        _slide_count_again = export_keynote_images(keynote_path, staged_export_dir, all_stages=True)

        final_images = sorted_exported_images(final_export_dir)
        staged_images = sorted_exported_images(staged_export_dir)
        groups = determine_stage_groups(final_images, staged_images)

        if len(groups) != len(final_images):
            fail(
                "stage-group reconstruction failed; final slide count and grouped slides differ "
                f"({len(final_images)} vs {len(groups)})."
            )

        slide_timeline: list[dict[str, Any]] = []
        current_time = 0.0
        for slide_index, (start_stage_idx, end_stage_idx) in enumerate(groups, start=1):
            stage_count = max(1, (end_stage_idx - start_stage_idx + 1))
            for stage_offset in range(stage_count):
                stage_index = stage_offset + 1
                global_stage_index = start_stage_idx + stage_offset + 1
                is_final_stage = stage_index == stage_count
                duration = args.slide_seconds if is_final_stage else args.build_seconds
                start_sec = current_time
                end_sec = start_sec + duration
                slide_timeline.append(
                    {
                        "slide_index": slide_index,
                        "stage_index": stage_index,
                        "stage_count_for_slide": stage_count,
                        "global_stage_index": global_stage_index,
                        "start_sec": round(start_sec, 3),
                        "end_sec": round(end_sec, 3),
                        "duration_sec": round(duration, 3),
                        "kind": "slide_hold" if is_final_stage else "build_hold",
                        "source": "pip_slides",
                    }
                )
                current_time = end_sec

        timeline_duration = round(current_time, 3)
        video_duration = ffprobe_duration(video_path) if video_path is not None else None
        warnings: list[str] = []
        timing_adjustment: dict[str, Any] = {"retimed": False}

        if args.timing_mode == "auto-fit" and video_duration is not None and video_duration > 0:
            retimed_timeline, timing_adjustment = retime_slide_timeline_to_target(
                slide_timeline=slide_timeline,
                target_duration_sec=video_duration,
                fps=args.fps,
                min_build_seconds=args.min_build_seconds,
                min_slide_seconds=args.min_slide_seconds,
            )
            if timing_adjustment.get("retimed"):
                slide_timeline = retimed_timeline
                timeline_duration = round(segment_end(slide_timeline), 3)
                warnings.append(
                    "Auto-fit timing adjusted slide/build durations to better match source video runtime."
                )

        script_details = {
            "available": False,
            "warning": "no script PDF provided",
            "cue_counts": {},
            "cue_lines": [],
            "section_tags": [],
        }
        if script_pdf_path is not None:
            script_details = parse_script_pdf(script_pdf_path)

        cue_lines = script_details.get("cue_lines", [])
        script_beats = build_script_beats(cue_lines, timeline_duration)

        # Main sequence switching policy:
        # - Always show PiP during build transitions.
        # - For each final slide hold, lead with PiP, then alternate wide/punch.
        # - If script beat explicitly requests ONCAM or PIP/SLIDE, prefer it.
        oncam_toggle = 0
        rough_main_sequence: list[dict[str, Any]] = []
        for segment in slide_timeline:
            start_sec = segment["start_sec"]
            end_sec = segment["end_sec"]
            duration_sec = end_sec - start_sec
            midpoint = start_sec + (duration_sec / 2.0)
            preferred = preference_at_time(script_beats, midpoint)

            if segment["kind"] == "build_hold":
                rough_main_sequence.append(
                    {
                        "start_sec": start_sec,
                        "end_sec": end_sec,
                        "duration_sec": round(duration_sec, 3),
                        "source": "pip_slides",
                        "reason": "build_transition",
                        "linked_slide_index": segment["slide_index"],
                        "linked_stage_index": segment["stage_index"],
                    }
                )
                continue

            if preferred == "pip_slides":
                rough_main_sequence.append(
                    {
                        "start_sec": start_sec,
                        "end_sec": end_sec,
                        "duration_sec": round(duration_sec, 3),
                        "source": "pip_slides",
                        "reason": "script_prefers_slides",
                        "linked_slide_index": segment["slide_index"],
                        "linked_stage_index": segment["stage_index"],
                    }
                )
                continue

            pip_lead = min(args.pip_lead_seconds, duration_sec)
            if pip_lead > 0:
                rough_main_sequence.append(
                    {
                        "start_sec": start_sec,
                        "end_sec": round(start_sec + pip_lead, 3),
                        "duration_sec": round(pip_lead, 3),
                        "source": "pip_slides",
                        "reason": "slide_intro",
                        "linked_slide_index": segment["slide_index"],
                        "linked_stage_index": segment["stage_index"],
                    }
                )

            cursor = start_sec + pip_lead
            while cursor < end_sec - 1e-6:
                remaining = end_sec - cursor
                take = min(args.shot_clock_seconds, remaining)

                if preferred == "oncam":
                    source = "wide" if oncam_toggle % 2 == 0 else "punch"
                    reason = "script_prefers_oncam"
                else:
                    source = "wide" if oncam_toggle % 2 == 0 else "punch"
                    reason = "shot_clock_rotation"
                oncam_toggle += 1

                rough_main_sequence.append(
                    {
                        "start_sec": round(cursor, 3),
                        "end_sec": round(cursor + take, 3),
                        "duration_sec": round(take, 3),
                        "source": source,
                        "reason": reason,
                        "linked_slide_index": segment["slide_index"],
                        "linked_stage_index": segment["stage_index"],
                    }
                )
                cursor += take

        main_sequence = merge_adjacent_segments(rough_main_sequence)

        main_sequence_duration = round(segment_end(main_sequence), 3)
        if script_details.get("warning"):
            warnings.append(str(script_details["warning"]))

        if (
            video_duration is not None
            and args.video_fit_mode == "append-oncam-tail"
            and video_duration > main_sequence_duration + 1e-6
        ):
            tail_segments, oncam_toggle = build_oncam_tail_segments(
                start_sec=main_sequence_duration,
                end_sec=video_duration,
                shot_clock_seconds=args.shot_clock_seconds,
                oncam_toggle_start=oncam_toggle,
            )
            if tail_segments:
                main_sequence = merge_adjacent_segments(main_sequence + tail_segments)
                main_sequence_duration = round(segment_end(main_sequence), 3)
                warnings.append(
                    "Appended on-cam tail segments to match video duration where no slides were scheduled."
                )

        duration_delta = (
            round(video_duration - main_sequence_duration, 3)
            if video_duration is not None
            else None
        )
        if video_duration is not None and abs(duration_delta or 0) > 5:
            warnings.append(
                "video and main sequence differ by more than 5s; "
                "use transcript alignment in V2 for tighter timing."
            )

        project_name = args.project_name or keynote_path.stem
        premiere_blueprint = build_premiere_blueprint(
            project_name=project_name,
            fps=args.fps,
            video_path=video_path,
            main_sequence=main_sequence,
            slide_timeline=slide_timeline,
        )

        return {
            "version": "autocut-v1",
            "project_name": project_name,
            "inputs": {
                "keynote": str(keynote_path),
                "script_pdf": str(script_pdf_path) if script_pdf_path else None,
                "video": str(video_path) if video_path else None,
            },
            "timing_defaults": {
                "build_seconds": args.build_seconds,
                "slide_seconds": args.slide_seconds,
                "pip_lead_seconds": args.pip_lead_seconds,
                "shot_clock_seconds": args.shot_clock_seconds,
                "fps": args.fps,
                "timing_mode": args.timing_mode,
                "min_build_seconds": args.min_build_seconds,
                "min_slide_seconds": args.min_slide_seconds,
            },
            "summary": {
                "keynote_reported_slide_count": slide_count,
                "final_export_image_count": len(final_images),
                "all_stage_export_image_count": len(staged_images),
                "timeline_duration_sec": timeline_duration,
                "timeline_duration_tc": seconds_to_timecode(timeline_duration, args.fps),
                "main_sequence_duration_sec": main_sequence_duration,
                "main_sequence_duration_tc": seconds_to_timecode(main_sequence_duration, args.fps),
                "video_duration_sec": round(video_duration, 3) if video_duration is not None else None,
                "duration_delta_sec": duration_delta,
                "main_sequence_cut_count": len(main_sequence),
                "script_cue_count": len(cue_lines),
                "timing_adjustment": timing_adjustment,
            },
            "assets": {
                "main_sources": ["wide", "punch", "pip_slides"],
                "optional_sources": ["broll"],
            },
            "script": {
                "available": script_details["available"],
                "warning": script_details["warning"],
                "cue_counts": script_details["cue_counts"],
                "section_tags": script_details["section_tags"],
                "cues": cue_lines,
                "beats": script_beats,
            },
            "timeline": {
                "slide_timeline": slide_timeline,
                "main_sequence": main_sequence,
            },
            "premiere_blueprint": premiere_blueprint,
            "warnings": warnings,
            "next_steps": [
                "Convert this plan into Premiere XML/FCP7 XML.",
                "Relink media and map source IDs to real bins/sequences.",
                "Use transcript alignment to replace static timing defaults.",
            ],
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build an Autocut V1 edit plan JSON.")
    parser.add_argument("--keynote", required=True, help="Path to a .key file")
    parser.add_argument("--script-pdf", help="Path to script PDF (optional)")
    parser.add_argument("--video", help="Path to presenter video (optional)")
    parser.add_argument(
        "--output",
        default="autocut_output/edit_plan.json",
        help="Output JSON path (default: autocut_output/edit_plan.json)",
    )
    parser.add_argument("--project-name", help="Optional project name override")
    parser.add_argument("--build-seconds", type=float, default=1.0)
    parser.add_argument("--slide-seconds", type=float, default=6.0)
    parser.add_argument("--pip-lead-seconds", type=float, default=2.0)
    parser.add_argument("--shot-clock-seconds", type=float, default=12.0)
    parser.add_argument(
        "--timing-mode",
        choices=["fixed", "auto-fit"],
        default="auto-fit",
        help="Slide/build duration strategy. auto-fit matches total slide timeline to video duration.",
    )
    parser.add_argument(
        "--min-build-seconds",
        type=float,
        default=0.25,
        help="Minimum duration for build_hold stages when timing-mode=auto-fit.",
    )
    parser.add_argument(
        "--min-slide-seconds",
        type=float,
        default=1.0,
        help="Minimum duration for slide_hold stages when timing-mode=auto-fit.",
    )
    parser.add_argument(
        "--video-fit-mode",
        choices=["none", "append-oncam-tail"],
        default="append-oncam-tail",
        help="How to reconcile planned timeline vs video duration.",
    )
    parser.add_argument("--fps", type=int, default=30)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    plan = build_plan(args)
    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(plan, indent=2), encoding="utf-8")
    print(f"Wrote: {output_path}")
    print(
        "Summary:",
        json.dumps(plan["summary"], indent=2),
    )


if __name__ == "__main__":
    main()
