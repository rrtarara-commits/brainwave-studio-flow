#!/usr/bin/env python3
"""Export Autocut V1 JSON into Premiere-importable XML (FCP7 xmeml).

Design goals:
- Keep this deterministic and transparent.
- Prefer compatibility with Premiere's FCP XML importer.
- Preserve your V-track intent:
  - V1: wide / PiP backplate coverage
  - V2: punch-in coverage
  - V3: timed slide-stage stills
  - V4-V6: reserved placeholders
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def run_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, capture_output=True, text=True)


def seconds_to_frames(seconds: float, fps: int) -> int:
    return max(0, int(round(seconds * fps)))


def path_to_pathurl(path: Path) -> str:
    # Premiere/FCP XML expects URL form.
    # Path.as_uri() is strict about absolute paths and handles escaping safely.
    resolved = path.expanduser().resolve()
    return resolved.as_uri()


def add_text(parent: ET.Element, tag: str, value: str | int | float) -> ET.Element:
    child = ET.SubElement(parent, tag)
    child.text = str(value)
    return child


def add_rate(parent: ET.Element, fps: int) -> ET.Element:
    rate = ET.SubElement(parent, "rate")
    add_text(rate, "timebase", fps)
    add_text(rate, "ntsc", "FALSE")
    return rate


def add_sample_characteristics(
    parent: ET.Element, *, fps: int, width: int, height: int
) -> ET.Element:
    sample = ET.SubElement(parent, "samplecharacteristics")
    add_rate(sample, fps)
    add_text(sample, "width", width)
    add_text(sample, "height", height)
    add_text(sample, "anamorphic", "FALSE")
    add_text(sample, "pixelaspectratio", "square")
    add_text(sample, "fielddominance", "none")
    return sample


def add_marker(
    parent: ET.Element,
    *,
    name: str,
    in_frame: int,
    out_frame: int,
    comment: str | None = None,
) -> ET.Element:
    marker = ET.SubElement(parent, "marker")
    add_text(marker, "name", name)
    add_text(marker, "in", in_frame)
    add_text(marker, "out", max(in_frame + 1, out_frame))
    if comment:
        add_text(marker, "comment", comment)
    return marker


def ffprobe_video_info(video_path: Path) -> dict[str, Any]:
    if shutil.which("ffprobe") is None:
        return {}

    try:
        result = run_command(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,width,height,r_frame_rate",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                str(video_path),
            ]
        )
        payload = json.loads(result.stdout)
    except Exception:
        return {}

    width = None
    height = None
    fps = None
    for stream in payload.get("streams", []):
        if stream.get("codec_type") != "video":
            continue
        width = stream.get("width")
        height = stream.get("height")
        rate = stream.get("r_frame_rate")
        if isinstance(rate, str) and "/" in rate:
            num, den = rate.split("/", 1)
            try:
                num_i = int(num)
                den_i = int(den)
                if den_i > 0:
                    fps = round(num_i / den_i)
            except Exception:
                fps = None
        break

    duration = None
    try:
        duration = float(payload.get("format", {}).get("duration"))
    except Exception:
        duration = None

    return {
        "width": width,
        "height": height,
        "fps": fps,
        "duration_sec": duration,
    }


def sorted_exported_images(directory: Path) -> list[Path]:
    images = [p for p in directory.glob("*.png") if p.is_file()]

    def key(path: Path) -> tuple[int, str]:
        name = path.name
        # Keynote export names usually end with .###.png
        number = 10**9
        parts = name.split(".")
        if len(parts) >= 3 and parts[-1].lower() == "png":
            try:
                number = int(parts[-2])
            except ValueError:
                number = 10**9
        return (number, name)

    return sorted(images, key=key)


def export_keynote_all_stages(keynote_path: Path, output_dir: Path) -> int:
    if shutil.which("osascript") is None:
        fail("osascript is required for Keynote automation on macOS.")

    output_dir.mkdir(parents=True, exist_ok=True)
    for existing in output_dir.glob("*.png"):
        existing.unlink()

    applescript = """
on run argv
  set keynotePosixPath to item 1 of argv
  set outputPosixDir to item 2 of argv
  tell application "Keynote"
    set d to open POSIX file keynotePosixPath
    export d to (POSIX file outputPosixDir as alias) as slide images with properties {all stages:true}
    set slideCount to count of slides of d
    close d saving no
    return slideCount as string
  end tell
end run
""".strip()

    run_command(
        ["osascript", "-e", applescript, str(keynote_path), str(output_dir)]
    )
    return len(sorted_exported_images(output_dir))


def xml_clipitem_video(
    *,
    track: ET.Element,
    clip_id: str,
    name: str,
    start: int,
    end: int,
    in_frame: int,
    out_frame: int,
    file_id: str,
    file_path: Path,
    file_duration: int,
    fps: int,
    width: int,
    height: int,
) -> None:
    clip = ET.SubElement(track, "clipitem", id=clip_id)
    add_text(clip, "name", name)
    add_text(clip, "duration", file_duration)
    add_rate(clip, fps)
    add_text(clip, "enabled", "TRUE")
    add_text(clip, "start", start)
    add_text(clip, "end", end)
    add_text(clip, "in", in_frame)
    add_text(clip, "out", out_frame)

    file_el = ET.SubElement(clip, "file", id=file_id)
    add_text(file_el, "name", file_path.name)
    add_text(file_el, "pathurl", path_to_pathurl(file_path))
    add_rate(file_el, fps)
    add_text(file_el, "duration", file_duration)
    media = ET.SubElement(file_el, "media")
    video = ET.SubElement(media, "video")
    add_sample_characteristics(video, fps=fps, width=width, height=height)

    source_track = ET.SubElement(clip, "sourcetrack")
    add_text(source_track, "mediatype", "video")


def xml_clipitem_image(
    *,
    track: ET.Element,
    clip_id: str,
    name: str,
    start: int,
    end: int,
    duration: int,
    file_id: str,
    image_path: Path,
    fps: int,
    width: int,
    height: int,
) -> None:
    clip = ET.SubElement(track, "clipitem", id=clip_id)
    add_text(clip, "name", name)
    add_text(clip, "duration", duration)
    add_rate(clip, fps)
    add_text(clip, "enabled", "TRUE")
    add_text(clip, "start", start)
    add_text(clip, "end", end)
    add_text(clip, "in", 0)
    add_text(clip, "out", duration)

    file_el = ET.SubElement(clip, "file", id=file_id)
    add_text(file_el, "name", image_path.name)
    add_text(file_el, "pathurl", path_to_pathurl(image_path))
    add_rate(file_el, fps)
    add_text(file_el, "duration", duration)
    media = ET.SubElement(file_el, "media")
    video = ET.SubElement(media, "video")
    add_sample_characteristics(video, fps=fps, width=width, height=height)

    source_track = ET.SubElement(clip, "sourcetrack")
    add_text(source_track, "mediatype", "video")


def xml_clipitem_nested_sequence(
    *,
    track: ET.Element,
    clip_id: str,
    name: str,
    start: int,
    end: int,
    in_frame: int,
    out_frame: int,
    nested_sequence_id: str,
    nested_sequence_name: str,
    nested_sequence_duration: int,
    fps: int,
) -> None:
    clip = ET.SubElement(track, "clipitem", id=clip_id)
    add_text(clip, "name", name)
    add_text(clip, "duration", nested_sequence_duration)
    add_rate(clip, fps)
    add_text(clip, "enabled", "TRUE")
    add_text(clip, "start", start)
    add_text(clip, "end", end)
    add_text(clip, "in", in_frame)
    add_text(clip, "out", out_frame)

    nested = ET.SubElement(clip, "sequence", id=nested_sequence_id)
    add_text(nested, "name", nested_sequence_name)
    add_text(nested, "duration", nested_sequence_duration)
    add_rate(nested, fps)

    source_track = ET.SubElement(clip, "sourcetrack")
    add_text(source_track, "mediatype", "video")


def xml_audio_track_full_length(
    *,
    audio_parent: ET.Element,
    video_path: Path,
    fps: int,
    sequence_duration: int,
) -> None:
    track = ET.SubElement(audio_parent, "track")
    clip = ET.SubElement(track, "clipitem", id="audio-1")
    add_text(clip, "name", f"{video_path.stem}_audio")
    add_text(clip, "enabled", "TRUE")
    add_text(clip, "start", 0)
    add_text(clip, "end", sequence_duration)
    add_text(clip, "in", 0)
    add_text(clip, "out", sequence_duration)

    file_el = ET.SubElement(clip, "file", id="file-video-audio")
    add_text(file_el, "name", video_path.name)
    add_text(file_el, "pathurl", path_to_pathurl(video_path))
    add_rate(file_el, fps)
    add_text(file_el, "duration", sequence_duration)

    source_track = ET.SubElement(clip, "sourcetrack")
    add_text(source_track, "mediatype", "audio")
    add_text(source_track, "trackindex", 1)


def pretty_xml(root: ET.Element) -> str:
    xml_bytes = ET.tostring(root, encoding="utf-8")
    try:
        from xml.dom import minidom

        parsed = minidom.parseString(xml_bytes)
        body = parsed.toprettyxml(indent="  ", encoding="utf-8").decode("utf-8")
    except Exception:
        body = xml_bytes.decode("utf-8")

    if body.startswith("<?xml"):
        lines = body.splitlines()
        header = lines[0]
        rest = "\n".join(lines[1:])
        return f"{header}\n<!DOCTYPE xmeml>\n{rest}\n"
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + body


def build_ultra_compat_xml(
    *,
    project_name: str,
    fps: int,
    width: int,
    height: int,
    sequence_duration_frames: int,
    video_duration_frames: int,
    video_path: Path,
    main_sequence: list[dict[str, Any]],
    slide_timeline: list[dict[str, Any]],
    stage_images: list[Path],
) -> tuple[ET.Element, dict[str, int]]:
    # Premiere compatibility-first: one sequence at xmeml root, no nested sequence refs,
    # minimal marker/metadata complexity.
    xmeml = ET.Element("xmeml", version="4")
    sequence = ET.SubElement(xmeml, "sequence", id="sequence-1")
    add_text(sequence, "name", f"{project_name}_MAIN")
    add_rate(sequence, fps)
    add_text(sequence, "duration", sequence_duration_frames)

    timecode = ET.SubElement(sequence, "timecode")
    add_rate(timecode, fps)
    add_text(timecode, "string", "00:00:00:00")
    add_text(timecode, "frame", 0)
    add_text(timecode, "displayformat", "NDF")

    media = ET.SubElement(sequence, "media")
    video = ET.SubElement(media, "video")
    fmt = ET.SubElement(video, "format")
    add_sample_characteristics(fmt, fps=fps, width=width, height=height)

    track_main = ET.SubElement(video, "track")
    track_slides = ET.SubElement(video, "track")

    main_clip_count = 0
    for idx, clip in enumerate(main_sequence, start=1):
        start = seconds_to_frames(float(clip["start_sec"]), fps)
        end = seconds_to_frames(float(clip["end_sec"]), fps)
        duration = max(1, end - start)
        in_frame = start
        out_frame = start + duration
        source = str(clip.get("source", "wide"))
        xml_clipitem_video(
            track=track_main,
            clip_id=f"clipitem-main-{idx}",
            name=f"{source}_{idx:04d}",
            start=start,
            end=end,
            in_frame=in_frame,
            out_frame=out_frame,
            file_id=f"file-main-video-{idx}",
            file_path=video_path,
            file_duration=max(video_duration_frames, out_frame),
            fps=fps,
            width=width,
            height=height,
        )
        main_clip_count += 1

    slide_clip_count = 0
    for idx, stage in enumerate(slide_timeline, start=1):
        global_stage_index = int(stage.get("global_stage_index", 0))
        if global_stage_index < 1 or global_stage_index > len(stage_images):
            continue
        image_path = stage_images[global_stage_index - 1]
        start = seconds_to_frames(float(stage["start_sec"]), fps)
        end = seconds_to_frames(float(stage["end_sec"]), fps)
        duration = max(1, end - start)
        slide_index = int(stage.get("slide_index", idx))
        stage_index = int(stage.get("stage_index", 1))
        xml_clipitem_image(
            track=track_slides,
            clip_id=f"clipitem-slide-{idx}",
            name=f"slide_{slide_index:03d}_stage_{stage_index:02d}",
            start=start,
            end=end,
            duration=duration,
            file_id=f"file-slide-{idx}",
            image_path=image_path,
            fps=fps,
            width=width,
            height=height,
        )
        slide_clip_count += 1

    audio = ET.SubElement(media, "audio")
    xml_audio_track_full_length(
        audio_parent=audio,
        video_path=video_path,
        fps=fps,
        sequence_duration=sequence_duration_frames,
    )

    return xmeml, {
        "main_clips": main_clip_count,
        "slide_clips": slide_clip_count,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export Autocut V1 edit plan JSON to Premiere XML (FCP7 xmeml)."
    )
    parser.add_argument("--plan", required=True, help="Path to edit_plan.json")
    parser.add_argument("--output", help="Output XML path")
    parser.add_argument(
        "--stage-export-dir",
        help="Directory where all-stage Keynote PNG exports will be written",
    )
    parser.add_argument("--keynote", help="Override keynote path (optional)")
    parser.add_argument("--video", help="Override video path (optional)")
    parser.add_argument("--fps", type=int, help="Override fps (optional)")
    parser.add_argument("--width", type=int, help="Override sequence width (optional)")
    parser.add_argument("--height", type=int, help="Override sequence height (optional)")
    parser.add_argument(
        "--pip-mode",
        choices=["flat", "nested"],
        default="flat",
        help=(
            "How to represent pip_slides segments. "
            "'flat' avoids nested-sequence clip refs for higher Premiere import reliability."
        ),
    )
    parser.add_argument(
        "--xml-profile",
        choices=["standard", "ultra"],
        default="standard",
        help="XML shape profile. 'ultra' uses a minimal compatibility-first structure.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    plan_path = Path(args.plan).expanduser().resolve()
    if not plan_path.exists():
        fail(f"plan JSON not found: {plan_path}")

    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    project_name = str(plan.get("project_name", "autocut_project"))
    timing_defaults = plan.get("timing_defaults", {})
    summary = plan.get("summary", {})
    timeline = plan.get("timeline", {})
    main_sequence = list(timeline.get("main_sequence", []))
    slide_timeline = list(timeline.get("slide_timeline", []))
    script_data = plan.get("script", {})
    script_beats = list(script_data.get("beats", []))
    section_tags = list(script_data.get("section_tags", []))
    inputs = plan.get("inputs", {})

    if not main_sequence:
        fail("plan has no timeline.main_sequence entries")

    keynote_path = (
        Path(args.keynote).expanduser().resolve()
        if args.keynote
        else (Path(inputs["keynote"]).expanduser().resolve() if inputs.get("keynote") else None)
    )
    video_path = (
        Path(args.video).expanduser().resolve()
        if args.video
        else (Path(inputs["video"]).expanduser().resolve() if inputs.get("video") else None)
    )

    fps = int(args.fps or timing_defaults.get("fps") or 30)

    if video_path is None or not video_path.exists():
        fail("video path is required and must exist (from plan inputs.video or --video).")

    video_info = ffprobe_video_info(video_path)
    width = int(args.width or video_info.get("width") or 1920)
    height = int(args.height or video_info.get("height") or 1080)
    if args.fps is None and video_info.get("fps"):
        fps = int(video_info["fps"])

    if args.output:
        output_path = Path(args.output).expanduser().resolve()
    else:
        output_path = plan_path.with_suffix(".xml")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if args.stage_export_dir:
        stage_export_dir = Path(args.stage_export_dir).expanduser().resolve()
    else:
        stage_export_dir = output_path.parent / f"{project_name}_stages"

    stage_images: list[Path] = []
    if keynote_path and keynote_path.exists():
        exported = export_keynote_all_stages(keynote_path, stage_export_dir)
        stage_images = sorted_exported_images(stage_export_dir)
        if exported == 0 or not stage_images:
            fail("Keynote stage export produced no images.")
    else:
        fail("keynote path is required and must exist (from plan inputs.keynote or --keynote).")

    sequence_duration_sec = float(
        summary.get("main_sequence_duration_sec")
        or summary.get("timeline_duration_sec")
        or max(float(item["end_sec"]) for item in main_sequence)
    )
    sequence_duration_frames = seconds_to_frames(sequence_duration_sec, fps)
    video_duration_frames = seconds_to_frames(
        float(video_info.get("duration_sec") or sequence_duration_sec), fps
    )

    if args.xml_profile == "ultra":
        xmeml, counts = build_ultra_compat_xml(
            project_name=project_name,
            fps=fps,
            width=width,
            height=height,
            sequence_duration_frames=sequence_duration_frames,
            video_duration_frames=video_duration_frames,
            video_path=video_path,
            main_sequence=main_sequence,
            slide_timeline=slide_timeline,
            stage_images=stage_images,
        )
        xml_text = pretty_xml(xmeml)
        output_path.write_text(xml_text, encoding="utf-8")
        print(f"Wrote XML: {output_path}")
        print(f"Stage images: {stage_export_dir}")
        print(
            json.dumps(
                {
                    "project_name": project_name,
                    "xml_profile": args.xml_profile,
                    "fps": fps,
                    "width": width,
                    "height": height,
                    "sequence_duration_frames": sequence_duration_frames,
                    "main_clips": counts["main_clips"],
                    "slide_clips": counts["slide_clips"],
                    "exported_stage_images": len(stage_images),
                },
                indent=2,
            )
        )
        return

    xmeml = ET.Element("xmeml", version="5")
    project = ET.SubElement(xmeml, "project")
    add_text(project, "name", f"{project_name}_AUTOCUT")
    children = ET.SubElement(project, "children")

    main_sequence_id = "sequence-main-1"
    pip_sequence_id = "sequence-pip-1"
    main_sequence_name = f"{project_name}_MAIN"
    pip_sequence_name = f"{project_name}_PIP_NEST"
    use_nested_pip = args.pip_mode == "nested"

    pip_marker_count = 0
    pip_slide_clip_count = 0
    if use_nested_pip:
        # ------------------------------------------------------------------
        # PIP nested sequence (used as source for pip_slides clipitems)
        # ------------------------------------------------------------------
        pip_sequence = ET.SubElement(children, "sequence", id=pip_sequence_id)
        add_text(pip_sequence, "name", pip_sequence_name)
        add_rate(pip_sequence, fps)
        add_text(pip_sequence, "duration", sequence_duration_frames)

        pip_timecode = ET.SubElement(pip_sequence, "timecode")
        add_rate(pip_timecode, fps)
        add_text(pip_timecode, "string", "00:00:00:00")
        add_text(pip_timecode, "frame", 0)
        add_text(pip_timecode, "displayformat", "NDF")

        pip_media = ET.SubElement(pip_sequence, "media")
        pip_video = ET.SubElement(pip_media, "video")
        pip_fmt = ET.SubElement(pip_video, "format")
        add_sample_characteristics(pip_fmt, fps=fps, width=width, height=height)

        pip_tracks: list[ET.Element] = [ET.SubElement(pip_video, "track") for _ in range(2)]

        # PIP track V1: full-length presenter base.
        xml_clipitem_video(
            track=pip_tracks[0],
            clip_id="pip-base-1",
            name=f"{project_name}_pip_base",
            start=0,
            end=sequence_duration_frames,
            in_frame=0,
            out_frame=sequence_duration_frames,
            file_id="file-pip-base",
            file_path=video_path,
            file_duration=max(video_duration_frames, sequence_duration_frames),
            fps=fps,
            width=width,
            height=height,
        )

        # PIP track V2: timed slide-stage stills.
        for idx, stage in enumerate(slide_timeline, start=1):
            global_stage_index = int(stage["global_stage_index"])
            if global_stage_index < 1 or global_stage_index > len(stage_images):
                continue

            image_path = stage_images[global_stage_index - 1]
            start = seconds_to_frames(float(stage["start_sec"]), fps)
            end = seconds_to_frames(float(stage["end_sec"]), fps)
            duration = max(1, end - start)
            slide_index = int(stage["slide_index"])
            stage_index = int(stage["stage_index"])
            clip_name = f"pip_slide_{slide_index:03d}_stage_{stage_index:02d}"

            xml_clipitem_image(
                track=pip_tracks[1],
                clip_id=f"pip-slide-{idx}",
                name=clip_name,
                start=start,
                end=end,
                duration=duration,
                file_id=f"file-pip-slide-{idx}",
                image_path=image_path,
                fps=fps,
                width=width,
                height=height,
            )
            pip_slide_clip_count += 1

            if stage.get("kind") == "build_hold":
                add_marker(
                    pip_sequence,
                    name="BUILD_ADVANCE",
                    in_frame=start,
                    out_frame=start + 1,
                    comment=f"Slide {slide_index} build stage {stage_index}",
                )
                pip_marker_count += 1
            elif stage_index == 1:
                add_marker(
                    pip_sequence,
                    name="SLIDE_CHANGE",
                    in_frame=start,
                    out_frame=start + 1,
                    comment=f"Slide {slide_index}",
                )
                pip_marker_count += 1

    # ------------------------------------------------------------------
    # Main delivery sequence
    # ------------------------------------------------------------------
    main_sequence_el = ET.SubElement(children, "sequence", id=main_sequence_id)
    add_text(main_sequence_el, "name", main_sequence_name)
    add_rate(main_sequence_el, fps)
    add_text(main_sequence_el, "duration", sequence_duration_frames)

    main_timecode = ET.SubElement(main_sequence_el, "timecode")
    add_rate(main_timecode, fps)
    add_text(main_timecode, "string", "00:00:00:00")
    add_text(main_timecode, "frame", 0)
    add_text(main_timecode, "displayformat", "NDF")

    media = ET.SubElement(main_sequence_el, "media")
    video = ET.SubElement(media, "video")
    fmt = ET.SubElement(video, "format")
    add_sample_characteristics(fmt, fps=fps, width=width, height=height)

    # Build six video tracks (V1-V6).
    tracks: list[ET.Element] = [ET.SubElement(video, "track") for _ in range(6)]

    clip_counter = 1
    nested_clip_count = 0

    # Main switch track logic:
    # - wide -> V1
    # - pip_slides -> V1 as nested sequence source
    # - punch -> V2
    for clip in main_sequence:
        source = clip.get("source")
        start = seconds_to_frames(float(clip["start_sec"]), fps)
        end = seconds_to_frames(float(clip["end_sec"]), fps)
        duration = max(1, end - start)
        in_frame = start
        out_frame = start + duration

        if source == "punch":
            target_track = tracks[1]  # V2
            clip_name = f"punch_{clip_counter:04d}"
            xml_clipitem_video(
                track=target_track,
                clip_id=f"clipitem-v-{clip_counter}",
                name=clip_name,
                start=start,
                end=end,
                in_frame=in_frame,
                out_frame=out_frame,
                file_id=f"file-video-{clip_counter}",
                file_path=video_path,
                file_duration=max(video_duration_frames, out_frame),
                fps=fps,
                width=width,
                height=height,
            )
        elif source == "pip_slides":
            if use_nested_pip:
                target_track = tracks[0]  # V1
                clip_name = f"pip_nested_{clip_counter:04d}"
                xml_clipitem_nested_sequence(
                    track=target_track,
                    clip_id=f"clipitem-v-{clip_counter}",
                    name=clip_name,
                    start=start,
                    end=end,
                    in_frame=in_frame,
                    out_frame=out_frame,
                    nested_sequence_id=pip_sequence_id,
                    nested_sequence_name=pip_sequence_name,
                    nested_sequence_duration=sequence_duration_frames,
                    fps=fps,
                )
                nested_clip_count += 1
            else:
                # Premiere compatibility mode: avoid nested sequence refs.
                # Keep presenter video on V1 while V3 already carries timed slide stages.
                target_track = tracks[0]  # V1
                clip_name = f"pip_zone_base_{clip_counter:04d}"
                xml_clipitem_video(
                    track=target_track,
                    clip_id=f"clipitem-v-{clip_counter}",
                    name=clip_name,
                    start=start,
                    end=end,
                    in_frame=in_frame,
                    out_frame=out_frame,
                    file_id=f"file-video-{clip_counter}",
                    file_path=video_path,
                    file_duration=max(video_duration_frames, out_frame),
                    fps=fps,
                    width=width,
                    height=height,
                )
        else:
            target_track = tracks[0]  # V1
            clip_name = f"wide_{clip_counter:04d}"
            xml_clipitem_video(
                track=target_track,
                clip_id=f"clipitem-v-{clip_counter}",
                name=clip_name,
                start=start,
                end=end,
                in_frame=in_frame,
                out_frame=out_frame,
                file_id=f"file-video-{clip_counter}",
                file_path=video_path,
                file_duration=max(video_duration_frames, out_frame),
                fps=fps,
                width=width,
                height=height,
            )
        clip_counter += 1

    # V3 receives slide stage stills too, so users can use them directly
    # or compare against nested PiP behavior.
    for idx, stage in enumerate(slide_timeline, start=1):
        global_stage_index = int(stage["global_stage_index"])
        if global_stage_index < 1 or global_stage_index > len(stage_images):
            continue
        image_path = stage_images[global_stage_index - 1]
        start = seconds_to_frames(float(stage["start_sec"]), fps)
        end = seconds_to_frames(float(stage["end_sec"]), fps)
        duration = max(1, end - start)
        slide_index = int(stage["slide_index"])
        stage_index = int(stage["stage_index"])
        clip_name = f"slide_{slide_index:03d}_stage_{stage_index:02d}"
        xml_clipitem_image(
            track=tracks[2],  # V3
            clip_id=f"clipitem-slide-main-{idx}",
            name=clip_name,
            start=start,
            end=end,
            duration=duration,
            file_id=f"file-slide-main-{idx}",
            image_path=image_path,
            fps=fps,
            width=width,
            height=height,
        )

    # Main sequence marker injection for graphics/MOGRT workflow.
    main_marker_count = 0
    add_marker(
        main_sequence_el,
        name="MOGRT_INTRO",
        in_frame=0,
        out_frame=min(sequence_duration_frames, fps * 2),
        comment="Apply branded intro MOGRT on V5.",
    )
    main_marker_count += 1
    outro_start = max(0, sequence_duration_frames - (fps * 2))
    add_marker(
        main_sequence_el,
        name="MOGRT_OUTRO",
        in_frame=outro_start,
        out_frame=sequence_duration_frames,
        comment="Apply branded outro/endcard MOGRT on V5.",
    )
    main_marker_count += 1

    if section_tags:
        slot = sequence_duration_frames / (len(section_tags) + 1)
        for idx, tag in enumerate(section_tags, start=1):
            frame = int(round(idx * slot))
            add_marker(
                main_sequence_el,
                name=f"TOPIC_{idx:02d}",
                in_frame=frame,
                out_frame=frame + 1,
                comment=str(tag),
            )
            main_marker_count += 1

    interesting_cues = {"GFX", "MUSIC", "BROLL", "PIP", "SLIDE"}
    for beat in script_beats:
        cue = str(beat.get("cue", "")).upper()
        if cue not in interesting_cues:
            continue
        start_sec = float(beat.get("start_sec", 0.0))
        end_sec = float(beat.get("end_sec", start_sec))
        start = seconds_to_frames(start_sec, fps)
        end = seconds_to_frames(end_sec, fps)
        add_marker(
            main_sequence_el,
            name=f"CUE_{cue}",
            in_frame=start,
            out_frame=max(start + 1, min(end, start + fps)),
            comment=str(beat.get("text", "")),
        )
        main_marker_count += 1

    audio = ET.SubElement(media, "audio")
    xml_audio_track_full_length(
        audio_parent=audio,
        video_path=video_path,
        fps=fps,
        sequence_duration=sequence_duration_frames,
    )

    xml_text = pretty_xml(xmeml)
    output_path.write_text(xml_text, encoding="utf-8")

    print(f"Wrote XML: {output_path}")
    print(f"Stage images: {stage_export_dir}")
    print(
        json.dumps(
            {
                "project_name": project_name,
                "pip_mode": args.pip_mode,
                "fps": fps,
                "width": width,
                "height": height,
                "sequence_duration_frames": sequence_duration_frames,
                "main_clips": len(main_sequence),
                "main_nested_pip_clips": nested_clip_count,
                "slide_stage_clips_main_v3": len(slide_timeline),
                "slide_stage_clips_pip_nest_v2": pip_slide_clip_count,
                "exported_stage_images": len(stage_images),
                "main_markers": main_marker_count,
                "pip_markers": pip_marker_count,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
