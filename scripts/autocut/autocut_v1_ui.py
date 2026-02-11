#!/usr/bin/env python3
"""Basic desktop UI for Autocut V1 batch processing.

Features:
- Pick file or folder paths for Keynote, script PDF, and video assets
- Accept folders with multiple assets and auto-match by project key
- Generate per-project edit plan JSON and Premiere XML
"""

from __future__ import annotations

import datetime as dt
import json
import queue
import re
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from tkinter import filedialog, messagebox, scrolledtext, ttk
import tkinter as tk
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen


VIDEO_EXTENSIONS = {".mov", ".mp4", ".mxf", ".avi", ".m4v"}
KEYNOTE_MOV_EXTENSIONS = {".mov", ".mp4", ".m4v"}
SUPPORTED_DOWNLOAD_EXTENSIONS = {".key", ".pdf"} | VIDEO_EXTENSIONS
PROJECT_KEY_RE = re.compile(r"([A-Za-z]{2,}\d{3,})")

SCRIPT_DIR = Path(__file__).resolve().parent
BUILD_SCRIPT = SCRIPT_DIR / "build_v1_edit_plan.py"
XML_SCRIPT = SCRIPT_DIR / "export_premiere_xml_v1.py"
EDL_SCRIPT = SCRIPT_DIR / "export_edl_v1.py"
SLIDE_MOV_SCRIPT = SCRIPT_DIR / "render_keynote_overlay_v1.py"
MANIFEST_SCRIPT = SCRIPT_DIR / "write_delivery_manifest_v1.py"

DROPBOX_API_BASE = "https://api.dropboxapi.com/2"
DROPBOX_CONTENT_API_BASE = "https://content.dropboxapi.com/2"
DROPBOX_VALIDATE_TIMEOUT_SECONDS = 10
DROPBOX_VALIDATE_WATCHDOG_MS = 12000
DEFAULT_DROPBOX_SHARED_URL = (
    "https://www.dropbox.com/scl/fi/efj52dv7wqv64oov2va8k/"
    "FSTR002-Script-Bigtable-correct-script.pdf"
    "?rlkey=szkbjfxqo4yjhfghonvsqgalv&st=7lv1lin4&dl=0"
)
DEFAULT_DROPBOX_API_TOKEN = "sl.u.AGTdyKDMKiYzKh3CijHlAvb8nGs1mpq_3VAXaSekBoi3SHFRdxme2ZxzlVys9bqvQmUkfecTer9PI6Ro4YOzdeEIf3PCO_5g3aWvHowHyYk_iqPXuChAhO7-w9DgCGpQpNjkC8Q6QSjhkX6Rg-hkWhP5irrwZTsHnLgCdW5TfPb1fqxCJRVdSEk6R6d0UP7rCCwnCdsIjxhbNkU5i39h7018-063v7o1ZLGylDmNBJUb-xyrRM43dNowb7XlViJly_EJhX_aZySU7o0S-FfRTdjyeCNWQoQPMwHWKFsJQwJn2RYWYYBRPABgbZbkgpaW1Z08gDaEhwWcc2vmu_67dr55hOfyePn31KH_wab-ejNbafe4jOMPDWqZcclSDEFFpVQFDHq7JOBT9_SzM4cGmX0f0Bw49el9w2ZVDt0Osm4Mazd7CZrLYp1YQ5QzOrf9_qLQ0VwKHd72vbeBSSOEFP7R4b1qilwgD1l3NTCz8bFA3pFby0vYoeN0fkFfZRh_kfJiLKoa_p9UNdnC_4KZk_ALylvRPs-D40YBRN-trwfzSt-pbkVL9cYSBGc0PwTOP8JGGwtf7vvD75LZYVsEKJ2fRpVm1xctynU93WvHn6Mg00jjgh6x2wkqFDnXezRSjyTmmQ7IR01wxAg_lZ4TZrS25QyOyPgTKnZ0uwQYRkt9EP4Hbyih18RQtXtQhY7tPKfiQSiBdVL5ex0qSRTDV2PXSnANmzErthg6WMNwggovmJQqdBlv51aeXpvzNVmpQD4LDi3y8sgNmReRX2n9h6cqGKLL0nQIQluinoclaElVKf42YmJQ-_HIhs1mzLon-i8egDC01YfFMhH34hehGsK1vrQYoU5mu66p-ti7ARfO3kcg-ED0NWX2kLNGFLKsC7CZCDf0cf2EOtXXoVtZ5HZ-x8N2MZ-kMO_V9wYEgR8StTj_KXJNWWL7alylhK1f8uBXpqhr4DXI2UFXw0a2qpHHBifkqwVPDxU-PaDfkC9lJ9hiSrwWArhtU21AFasQp4SFYOK3rfOdusCGMY-aR_mte-1VgZChwY9olyHl639vpu4WTskak84iuoyYPFMaE1wS4uDugymkO2C2PHqNrHPe_0RMxYJ4jNSxIvP3YsLcVE7i4ezSdAezTNcoGBcZyJYL8emnp9Focu4jFhcB-ebVt9Hm-Z__h7CPwmF_x3ChNHKHgpa9XdTXw0bT_ZKEB_mzNFWozP4pqTvGOUahDGrO-PuPPjJcxKXmAAv0r1U8Z6TlLCNOWIhhRXy5rOB859mYUtLOZA9zPTjsgB4F_kXap8C401-SCtL82OAw3x68HA"
DEFAULT_DROPBOX_SELECT_USER = ""
BRAND_COLORS = {
    "bg": "#070E1B",
    "card": "#101B31",
    "panel": "#162744",
    "panel_hover": "#1F3458",
    "panel_border": "#27406A",
    "text": "#EAF1FF",
    "muted": "#9BB0D4",
    "accent": "#1E9BFF",
    "accent_hover": "#43B2FF",
    "success": "#34D07F",
    "warning": "#FFBE55",
    "error": "#FF6C7D",
    "info": "#57A8FF",
    "disabled_bg": "#223557",
    "disabled_text": "#6F82A7",
    "log_bg": "#091223",
}


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


@dataclass
class ProjectInput:
    project_key: str
    keynote: Path
    keynote_mov: Path | None
    video: Path | None
    script_pdf: Path | None


def project_key_from_name(name: str) -> str:
    match = PROJECT_KEY_RE.search(name)
    if match:
        return match.group(1).upper()
    cleaned = re.sub(
        r"(?i)[-_ ]?(keynote|script|slides?|deck|builds|v\d+|final|video)+.*$",
        "",
        name,
    ).strip(" _-")
    if cleaned:
        return cleaned.upper()
    return name.upper()


def iter_files(path: Path, extensions: set[str]) -> list[Path]:
    if path.is_file():
        return [path] if path.suffix.lower() in extensions else []
    if path.is_dir():
        return sorted([p for p in path.iterdir() if p.is_file() and p.suffix.lower() in extensions])
    return []


def choose_best_match(
    *,
    candidates: list[Path],
    project_key: str,
    keynote_stem: str,
    purpose: str = "generic",
) -> Path | None:
    if not candidates:
        return None
    key = project_key.upper()
    keynote_upper = keynote_stem.upper()

    def score(path: Path) -> tuple[int, int]:
        name = path.stem.upper()
        value = 0
        if key and key in name:
            value += 100
        if name == keynote_upper:
            value += 90
        if keynote_upper in name:
            value += 40
        if "FINAL" in name:
            value += 5
        if purpose == "video":
            if any(token in name for token in ("KEYNOTE", "SLIDE", "DECK", "SCRIPT", "STAGE")):
                value -= 80
            if any(token in name for token in ("WIDE", "CAM", "MAIN", "ONCAM", "INTERVIEW")):
                value += 20
        elif purpose == "keynote_mov":
            if any(token in name for token in ("KEYNOTE", "SLIDE", "DECK", "BUILD", "STAGE")):
                value += 90
            if any(token in name for token in ("WIDE", "CAM", "MAIN", "ONCAM", "INTERVIEW")):
                value -= 30
        # Prefer shorter names when score ties.
        return (value, -len(name))

    best = max(candidates, key=score)
    if score(best)[0] <= 0 and len(candidates) > 1:
        return None
    return best


def resolve_projects(
    *,
    keynote_path: Path,
    keynote_mov_path: Path | None,
    video_path: Path | None,
    script_path: Path | None,
) -> list[ProjectInput]:
    keynotes = iter_files(keynote_path, {".key"})
    if not keynotes:
        return []

    keynote_mov_candidates = iter_files(keynote_mov_path, KEYNOTE_MOV_EXTENSIONS) if keynote_mov_path else []
    video_candidates = iter_files(video_path, VIDEO_EXTENSIONS) if video_path else []
    script_candidates = iter_files(script_path, {".pdf"}) if script_path else []

    projects: list[ProjectInput] = []
    for keynote in keynotes:
        key = project_key_from_name(keynote.stem)
        keynote_mov = choose_best_match(
            candidates=keynote_mov_candidates,
            project_key=key,
            keynote_stem=keynote.stem,
            purpose="keynote_mov",
        )
        video = choose_best_match(
            candidates=video_candidates,
            project_key=key,
            keynote_stem=keynote.stem,
            purpose="video",
        )
        script_pdf = choose_best_match(
            candidates=script_candidates,
            project_key=key,
            keynote_stem=keynote.stem,
            purpose="script",
        )

        # If there is exactly one script candidate, use it as default.
        if script_pdf is None and len(script_candidates) == 1:
            script_pdf = script_candidates[0]

        projects.append(
            ProjectInput(
                project_key=key,
                keynote=keynote,
                keynote_mov=keynote_mov,
                video=video,
                script_pdf=script_pdf,
            )
        )
    return projects


def normalize_dropbox_shared_url(url: str) -> str:
    parsed = urlparse(url.strip())
    if not parsed.scheme or not parsed.netloc:
        raise ValueError("Dropbox URL must be a full https URL.")

    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.pop("dl", None)
    query.pop("raw", None)
    # "st" is an ephemeral browser parameter and can expire.
    query.pop("st", None)
    query["dl"] = "0"
    rebuilt = parsed._replace(query=urlencode(query, doseq=True))
    return urlunparse(rebuilt)


def looks_like_url(value: str) -> bool:
    text = value.strip().lower()
    return text.startswith("http://") or text.startswith("https://")


def looks_like_dropbox_url(value: str) -> bool:
    if not looks_like_url(value):
        return False
    try:
        host = urlparse(value.strip()).netloc.lower()
    except Exception:
        return False
    return "dropbox.com" in host


def extract_dropbox_url_candidate(*values: str) -> str | None:
    for value in values:
        if looks_like_dropbox_url(value):
            return value.strip()
    return None


def dropbox_api_post(
    endpoint: str,
    token: str,
    payload: dict[str, object],
    *,
    select_user: str | None = None,
    timeout_seconds: int = 30,
    allow_select_user_fallback: bool = True,
) -> dict[str, object]:
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    if select_user and select_user.strip():
        headers["Dropbox-API-Select-User"] = select_user.strip()
    request = Request(
        f"{DROPBOX_API_BASE}{endpoint}",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers=headers,
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            body = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        if (
            select_user
            and allow_select_user_fallback
            and "Unexpected select user header" in detail
        ):
            return dropbox_api_post(
                endpoint,
                token,
                payload,
                select_user=None,
                timeout_seconds=timeout_seconds,
                allow_select_user_fallback=False,
            )
        raise RuntimeError(f"Dropbox API {endpoint} failed ({exc.code}): {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Dropbox API {endpoint} network error: {exc}") from exc

    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Dropbox API {endpoint} returned invalid JSON.") from exc


def dropbox_download_file(
    *,
    token: str,
    shared_url: str,
    path_in_share: str | None,
    dest_path: Path,
    select_user: str | None = None,
    allow_select_user_fallback: bool = True,
) -> dict[str, object]:
    arg: dict[str, object] = {"url": shared_url}
    if path_in_share:
        arg["path"] = path_in_share

    headers = {
        "Authorization": f"Bearer {token}",
        "Dropbox-API-Arg": json.dumps(arg),
    }
    if select_user and select_user.strip():
        headers["Dropbox-API-Select-User"] = select_user.strip()

    request = Request(
        f"{DROPBOX_CONTENT_API_BASE}/sharing/get_shared_link_file",
        data=b"",
        method="POST",
        headers=headers,
    )
    try:
        with urlopen(request, timeout=600) as response:
            result_header = response.headers.get("dropbox-api-result", "{}")
            metadata = json.loads(result_header)
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            with dest_path.open("wb") as handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        if (
            select_user
            and allow_select_user_fallback
            and "Unexpected select user header" in detail
        ):
            return dropbox_download_file(
                token=token,
                shared_url=shared_url,
                path_in_share=path_in_share,
                dest_path=dest_path,
                select_user=None,
                allow_select_user_fallback=False,
            )
        raise RuntimeError(
            f"Dropbox file download failed for {path_in_share or shared_url} ({exc.code}): {detail}"
        ) from exc
    except URLError as exc:
        raise RuntimeError(
            f"Dropbox file download network error for {path_in_share or shared_url}: {exc}"
        ) from exc

    return metadata


def download_dropbox_shared_assets(
    *,
    shared_url: str,
    token: str,
    destination_root: Path,
    logger: Callable[[str], None],
    select_user: str | None = None,
) -> Path:
    normalized_url = normalize_dropbox_shared_url(shared_url)
    destination_root.mkdir(parents=True, exist_ok=True)

    logger("Inspecting Dropbox shared link metadata...")
    metadata = dropbox_api_post(
        "/sharing/get_shared_link_metadata",
        token,
        {"url": normalized_url},
        select_user=select_user,
    )
    tag = str(metadata.get(".tag", ""))

    if tag == "file":
        name = str(metadata.get("name") or "dropbox_asset")
        ext = Path(name).suffix.lower()
        if ext and ext not in SUPPORTED_DOWNLOAD_EXTENSIONS:
            raise RuntimeError(
                f"Dropbox file '{name}' is not a supported asset type for this pipeline."
            )
        target = destination_root / name
        logger(f"Downloading Dropbox file: {name}")
        dropbox_download_file(
            token=token,
            shared_url=normalized_url,
            path_in_share=None,
            dest_path=target,
            select_user=select_user,
        )
        logger(f"Downloaded: {target}")
        return destination_root

    if tag != "folder":
        raise RuntimeError(
            "Dropbox link is neither a shared file nor a shared folder that this tool can process."
        )

    logger("Listing Dropbox folder contents via API...")
    entries: list[dict[str, object]] = []
    list_response = dropbox_api_post(
        "/files/list_folder",
        token,
        {
            "path": "",
            "recursive": True,
            "include_media_info": False,
            "include_deleted": False,
            "include_has_explicit_shared_members": False,
            "include_mounted_folders": False,
            "include_non_downloadable_files": False,
            "shared_link": {"url": normalized_url},
        },
        select_user=select_user,
    )
    entries.extend(list_response.get("entries", []))  # type: ignore[arg-type]

    while bool(list_response.get("has_more")):
        cursor = str(list_response.get("cursor"))
        list_response = dropbox_api_post(
            "/files/list_folder/continue",
            token,
            {"cursor": cursor},
            select_user=select_user,
        )
        entries.extend(list_response.get("entries", []))  # type: ignore[arg-type]

    file_entries: list[dict[str, object]] = []
    for entry in entries:
        if str(entry.get(".tag")) != "file":
            continue
        name = str(entry.get("name") or "")
        ext = Path(name).suffix.lower()
        if ext in SUPPORTED_DOWNLOAD_EXTENSIONS:
            file_entries.append(entry)

    if not file_entries:
        raise RuntimeError(
            "No supported asset files (.key/.pdf/video) were found in the Dropbox folder."
        )

    logger(f"Downloading {len(file_entries)} supported file(s) from Dropbox folder...")
    downloaded = 0
    for entry in file_entries:
        path_display = str(entry.get("path_display") or entry.get("name") or "")
        path_lower = str(entry.get("path_lower") or "")
        if not path_display:
            continue
        rel = path_display.lstrip("/")
        destination = destination_root / rel
        logger(f"Downloading: {rel}")
        dropbox_download_file(
            token=token,
            shared_url=normalized_url,
            path_in_share=path_lower if path_lower else f"/{rel}",
            dest_path=destination,
            select_user=select_user,
        )
        downloaded += 1

    logger(f"Dropbox download complete. Files downloaded: {downloaded}")
    return destination_root


class AutocutV1UI:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Autocut V1 Launcher")
        self.root.geometry("1180x820")
        self.root.minsize(1120, 760)

        self.log_queue: queue.Queue[str] = queue.Queue()
        self.worker_running = False
        self.dropbox_validate_button: ttk.Button | None = None
        self._dropbox_access_verified = False
        self._validated_dropbox_context: tuple[str, str, str] | None = None
        self._dropbox_validating = False
        self._dropbox_validate_request_id = 0
        self.brand = BRAND_COLORS
        self.font_family = "Avenir Next"
        self.style = ttk.Style(self.root)

        self.keynote_var = tk.StringVar()
        self.keynote_mov_var = tk.StringVar()
        self.video_var = tk.StringVar()
        self.script_var = tk.StringVar()
        self.output_var = tk.StringVar(value=str((Path.cwd() / "autocut_output").resolve()))
        self.dropbox_url_var = tk.StringVar(value=DEFAULT_DROPBOX_SHARED_URL)
        self.dropbox_token_var = tk.StringVar(value=DEFAULT_DROPBOX_API_TOKEN)
        self.dropbox_select_user_var = tk.StringVar(value=DEFAULT_DROPBOX_SELECT_USER)
        self.dropbox_status_var = tk.StringVar()
        self.dropbox_status_label: tk.Label | None = None

        self.build_seconds_var = tk.StringVar(value="1.0")
        self.slide_seconds_var = tk.StringVar(value="6.0")
        self.pip_lead_var = tk.StringVar(value="2.0")
        self.shot_clock_var = tk.StringVar(value="12.0")
        self.fps_var = tk.StringVar(value="30")
        self.min_build_var = tk.StringVar(value="0.25")
        self.min_slide_var = tk.StringVar(value="1.0")

        self.export_xml_var = tk.BooleanVar(value=True)
        self.export_edl_var = tk.BooleanVar(value=True)
        self.export_slide_mov_var = tk.BooleanVar(value=True)
        self.append_tail_var = tk.BooleanVar(value=True)
        self.continue_on_error_var = tk.BooleanVar(value=True)
        self.auto_fit_timing_var = tk.BooleanVar(value=True)

        self._configure_theme()
        self._build_layout()
        self.dropbox_url_var.trace_add("write", lambda *_: self._update_dropbox_status())
        self.dropbox_token_var.trace_add("write", lambda *_: self._update_dropbox_status())
        self.dropbox_select_user_var.trace_add("write", lambda *_: self._update_dropbox_status())
        self._update_dropbox_status()
        self.root.after(100, self._drain_logs)

    def _configure_theme(self) -> None:
        style = self.style
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass

        bg = self.brand["bg"]
        card = self.brand["card"]
        panel = self.brand["panel"]
        panel_border = self.brand["panel_border"]
        text = self.brand["text"]
        muted = self.brand["muted"]
        accent = self.brand["accent"]
        accent_hover = self.brand["accent_hover"]
        disabled_bg = self.brand["disabled_bg"]
        disabled_text = self.brand["disabled_text"]

        self.root.configure(bg=bg)
        style.configure(".", font=(self.font_family, 10))
        style.configure("Root.TFrame", background=bg)
        style.configure("Card.TFrame", background=card)
        style.configure(
            "Card.TLabelframe",
            background=card,
            borderwidth=1,
            relief="solid",
            bordercolor=panel_border,
            lightcolor=panel_border,
            darkcolor=panel_border,
        )
        style.configure(
            "Card.TLabelframe.Label",
            background=card,
            foreground=text,
            font=(self.font_family, 11, "bold"),
        )
        style.configure("HeroTitle.TLabel", background=bg, foreground=text, font=(self.font_family, 20, "bold"))
        style.configure("HeroSubtitle.TLabel", background=bg, foreground=muted, font=(self.font_family, 11))
        style.configure("Body.TLabel", background=card, foreground=text, font=(self.font_family, 10))
        style.configure("Muted.TLabel", background=card, foreground=muted, font=(self.font_family, 9))
        style.configure("RootBody.TLabel", background=bg, foreground=text, font=(self.font_family, 10))
        style.configure(
            "Brand.TEntry",
            fieldbackground=panel,
            foreground=text,
            bordercolor=panel_border,
            lightcolor=panel_border,
            darkcolor=panel_border,
            padding=(8, 6),
            relief="flat",
        )
        style.map(
            "Brand.TEntry",
            bordercolor=[("focus", accent)],
            lightcolor=[("focus", accent)],
            darkcolor=[("focus", accent)],
        )
        style.configure(
            "Accent.TButton",
            background=accent,
            foreground="#FFFFFF",
            bordercolor=accent,
            lightcolor=accent,
            darkcolor=accent,
            focuscolor=accent,
            padding=(14, 8),
            font=(self.font_family, 10, "bold"),
        )
        style.map(
            "Accent.TButton",
            background=[("active", accent_hover), ("disabled", disabled_bg)],
            foreground=[("disabled", disabled_text)],
            bordercolor=[("active", accent_hover), ("disabled", disabled_bg)],
        )
        style.configure(
            "Secondary.TButton",
            background=panel,
            foreground=text,
            bordercolor=panel_border,
            lightcolor=panel_border,
            darkcolor=panel_border,
            focuscolor=accent,
            padding=(10, 6),
            font=(self.font_family, 10),
        )
        style.map(
            "Secondary.TButton",
            background=[("active", self.brand["panel_hover"]), ("disabled", disabled_bg)],
            foreground=[("disabled", disabled_text)],
            bordercolor=[("active", accent), ("disabled", disabled_bg)],
        )
        style.configure(
            "Card.TCheckbutton",
            background=card,
            foreground=text,
            indicatorcolor=panel,
            indicatormargin=2,
            focuscolor=accent,
            font=(self.font_family, 10),
        )
        style.map(
            "Card.TCheckbutton",
            foreground=[("disabled", disabled_text)],
            indicatorcolor=[("selected", accent), ("!selected", panel)],
            background=[("active", card)],
        )

    def _build_layout(self) -> None:
        container = ttk.Frame(self.root, padding=(16, 14, 16, 16), style="Root.TFrame")
        container.pack(fill=tk.BOTH, expand=True)

        header = ttk.Frame(container, style="Root.TFrame")
        header.pack(fill=tk.X, pady=(0, 12))
        ttk.Label(header, text="Autocut V1 Launcher", style="HeroTitle.TLabel").pack(anchor=tk.W)
        ttk.Label(
            header,
            text="Stories that drive tech forward. Batch ingest, intelligent timing, and Premiere XML delivery.",
            style="HeroSubtitle.TLabel",
        ).pack(anchor=tk.W, pady=(2, 0))

        path_frame = ttk.LabelFrame(container, text="Asset Locations", padding=12, style="Card.TLabelframe")
        path_frame.pack(fill=tk.X)

        self._path_row(
            path_frame,
            row=0,
            label="Keynote (.key file or folder):",
            variable=self.keynote_var,
            file_types=[("Keynote files", "*.key")],
            allow_folder=True,
        )
        self._path_row(
            path_frame,
            row=1,
            label="Keynote animation MOV file/folder (optional):",
            variable=self.keynote_mov_var,
            file_types=[("Video files", "*.mov *.mp4 *.m4v")],
            allow_folder=True,
        )
        self._path_row(
            path_frame,
            row=2,
            label="Video file/folder (optional but recommended):",
            variable=self.video_var,
            file_types=[("Video files", "*.mov *.mp4 *.mxf *.avi *.m4v")],
            allow_folder=True,
        )
        self._path_row(
            path_frame,
            row=3,
            label="Script PDF file/folder (optional):",
            variable=self.script_var,
            file_types=[("PDF files", "*.pdf")],
            allow_folder=True,
        )
        self._path_row(
            path_frame,
            row=4,
            label="Output folder:",
            variable=self.output_var,
            file_types=[],
            allow_folder=True,
            folder_only=True,
        )
        self._path_row(
            path_frame,
            row=5,
            label="Dropbox shared URL (optional file or folder):",
            variable=self.dropbox_url_var,
            file_types=[],
            allow_folder=False,
            folder_only=False,
            show_file_button=False,
            show_edit_button=True,
            edit_title="Edit Dropbox Shared URL",
            show_paste_button=True,
        )
        self._path_row(
            path_frame,
            row=6,
            label="Dropbox API token (required for Dropbox URL):",
            variable=self.dropbox_token_var,
            file_types=[],
            allow_folder=False,
            folder_only=False,
            show_file_button=False,
            masked=True,
            show_edit_button=True,
            edit_title="Edit Dropbox API Token",
            show_paste_button=True,
        )
        self._path_row(
            path_frame,
            row=7,
            label="Dropbox Select User (team token only, e.g. dbmid:...):",
            variable=self.dropbox_select_user_var,
            file_types=[],
            allow_folder=False,
            folder_only=False,
            show_file_button=False,
            show_edit_button=True,
            edit_title="Edit Dropbox Select User",
            show_paste_button=True,
        )
        self.dropbox_status_label = tk.Label(
            path_frame,
            textvariable=self.dropbox_status_var,
            anchor="w",
            justify=tk.LEFT,
            bg=self.brand["card"],
            fg=self.brand["muted"],
            font=(self.font_family, 10),
        )
        self.dropbox_status_label.grid(row=8, column=1, sticky=tk.W, padx=6, pady=(2, 6))
        self.dropbox_validate_button = ttk.Button(
            path_frame,
            text="Validate Link",
            command=self._on_validate_dropbox,
            width=14,
            style="Secondary.TButton",
        )
        self.dropbox_validate_button.grid(row=8, column=2, padx=(0, 4), pady=(2, 6), sticky=tk.W)

        opts_frame = ttk.LabelFrame(container, text="Timing & Options", padding=12, style="Card.TLabelframe")
        opts_frame.pack(fill=tk.X, pady=(10, 0))

        fields = [
            ("Build seconds", self.build_seconds_var),
            ("Slide seconds", self.slide_seconds_var),
            ("PiP lead seconds", self.pip_lead_var),
            ("Shot clock seconds", self.shot_clock_var),
            ("FPS", self.fps_var),
            ("Min build seconds", self.min_build_var),
            ("Min slide seconds", self.min_slide_var),
        ]
        for idx, (label, var) in enumerate(fields):
            ttk.Label(opts_frame, text=label, style="Body.TLabel").grid(
                row=0, column=idx * 2, sticky=tk.W, padx=(0, 4)
            )
            ttk.Entry(opts_frame, textvariable=var, width=8, style="Brand.TEntry").grid(
                row=0, column=idx * 2 + 1, sticky=tk.W, padx=(0, 12)
            )

        ttk.Checkbutton(
            opts_frame,
            text="Export Premiere XML after JSON build",
            variable=self.export_xml_var,
            style="Card.TCheckbutton",
        ).grid(row=1, column=0, columnspan=4, sticky=tk.W, pady=(8, 0))
        ttk.Checkbutton(
            opts_frame,
            text="Export EDL fallback after JSON build",
            variable=self.export_edl_var,
            style="Card.TCheckbutton",
        ).grid(row=1, column=4, columnspan=4, sticky=tk.W, pady=(8, 0))
        ttk.Checkbutton(
            opts_frame,
            text="Export timed Keynote MOV overlay (with hold frames)",
            variable=self.export_slide_mov_var,
            style="Card.TCheckbutton",
        ).grid(row=2, column=0, columnspan=6, sticky=tk.W, pady=(8, 0))
        ttk.Checkbutton(
            opts_frame,
            text="Auto-fit slide/build timing to video runtime",
            variable=self.auto_fit_timing_var,
            style="Card.TCheckbutton",
        ).grid(row=2, column=6, columnspan=4, sticky=tk.W, pady=(8, 0))
        ttk.Checkbutton(
            opts_frame,
            text="Append on-cam tail if video is longer than slide timeline",
            variable=self.append_tail_var,
            style="Card.TCheckbutton",
        ).grid(row=3, column=0, columnspan=5, sticky=tk.W, pady=(8, 0))
        ttk.Checkbutton(
            opts_frame,
            text="Continue batch when one project fails",
            variable=self.continue_on_error_var,
            style="Card.TCheckbutton",
        ).grid(row=3, column=5, columnspan=5, sticky=tk.W, pady=(8, 0))

        action_frame = ttk.Frame(container, style="Root.TFrame")
        action_frame.pack(fill=tk.X, pady=(10, 0))
        self.run_button = ttk.Button(
            action_frame,
            text="Run Autocut V1 Batch",
            command=self.on_run,
            style="Accent.TButton",
        )
        self.run_button.pack(side=tk.LEFT)
        ttk.Button(
            action_frame,
            text="Open Output Folder",
            command=self.on_open_output,
            style="Secondary.TButton",
        ).pack(
            side=tk.LEFT, padx=(8, 0)
        )
        ttk.Button(
            action_frame,
            text="Clear Log",
            command=self.on_clear_log,
            style="Secondary.TButton",
        ).pack(
            side=tk.LEFT, padx=(8, 0)
        )

        log_frame = ttk.LabelFrame(container, text="Run Log", padding=10, style="Card.TLabelframe")
        log_frame.pack(fill=tk.BOTH, expand=True, pady=(10, 0))
        self.log_text = scrolledtext.ScrolledText(
            log_frame,
            wrap=tk.WORD,
            height=24,
            bg=self.brand["log_bg"],
            fg=self.brand["text"],
            insertbackground=self.brand["accent"],
            selectbackground=self.brand["accent"],
            selectforeground="#FFFFFF",
            relief=tk.FLAT,
            borderwidth=0,
            highlightthickness=1,
            highlightbackground=self.brand["panel_border"],
            font=("SF Mono", 10),
            padx=8,
            pady=8,
        )
        self.log_text.pack(fill=tk.BOTH, expand=True)
        self.log_text.configure(state=tk.DISABLED)

    def _path_row(
        self,
        parent: ttk.LabelFrame,
        *,
        row: int,
        label: str,
        variable: tk.StringVar,
        file_types: list[tuple[str, str]],
        allow_folder: bool,
        folder_only: bool = False,
        show_file_button: bool = True,
        masked: bool = False,
        show_edit_button: bool = False,
        edit_title: str = "Edit Value",
        show_paste_button: bool = False,
    ) -> None:
        ttk.Label(parent, text=label, style="Body.TLabel").grid(row=row, column=0, sticky=tk.W, pady=4)
        entry = ttk.Entry(parent, textvariable=variable, width=96, style="Brand.TEntry")
        if masked:
            entry.configure(show="*")
        entry.grid(row=row, column=1, sticky=tk.EW, padx=6)

        if show_file_button and not folder_only:
            ttk.Button(
                parent,
                text="File",
                command=lambda: self._pick_file(variable, file_types),
                width=7,
                style="Secondary.TButton",
            ).grid(row=row, column=2, padx=(0, 4))
        if allow_folder:
            ttk.Button(
                parent,
                text="Folder",
                command=lambda: self._pick_folder(variable),
                width=7,
                style="Secondary.TButton",
            ).grid(row=row, column=3, padx=(0, 4))
        if show_edit_button:
            ttk.Button(
                parent,
                text="Edit",
                command=lambda: self._open_long_value_editor(variable, edit_title, masked=masked),
                width=7,
                style="Secondary.TButton",
            ).grid(row=row, column=4, padx=(0, 4))
        if show_paste_button:
            ttk.Button(
                parent,
                text="Paste",
                command=lambda: self._paste_from_clipboard(variable),
                width=7,
                style="Secondary.TButton",
            ).grid(row=row, column=5, padx=(0, 4))
        parent.grid_columnconfigure(1, weight=1)

    def _pick_file(self, var: tk.StringVar, file_types: list[tuple[str, str]]) -> None:
        path = filedialog.askopenfilename(filetypes=file_types or [("All files", "*.*")])
        if path:
            var.set(path)

    def _pick_folder(self, var: tk.StringVar) -> None:
        path = filedialog.askdirectory()
        if path:
            var.set(path)

    def _set_dropbox_status(self, text: str, color: str) -> None:
        self.dropbox_status_var.set(text)
        if self.dropbox_status_label is not None:
            self.dropbox_status_label.configure(fg=color, bg=self.brand["card"])

    def _current_dropbox_context(self) -> tuple[str, str, str]:
        return (
            self.dropbox_url_var.get().strip(),
            self.dropbox_token_var.get().strip(),
            self.dropbox_select_user_var.get().strip(),
        )

    def _is_current_dropbox_validated(self) -> bool:
        context = self._current_dropbox_context()
        return self._dropbox_access_verified and self._validated_dropbox_context == context

    def _mark_dropbox_validation_stale_if_needed(self) -> None:
        if self._validated_dropbox_context != self._current_dropbox_context():
            self._dropbox_access_verified = False

    def _update_dropbox_status(self) -> None:
        self._mark_dropbox_validation_stale_if_needed()
        url = self.dropbox_url_var.get().strip()
        token = self.dropbox_token_var.get().strip()
        select_user = self.dropbox_select_user_var.get().strip()

        if not url:
            self._set_dropbox_status("Dropbox URL: not set (local assets mode).", self.brand["muted"])
            return

        length = len(url)
        try:
            normalized = normalize_dropbox_shared_url(url)
        except Exception as exc:
            self._set_dropbox_status(
                f"Dropbox URL invalid ({length} chars): {exc}",
                self.brand["error"],
            )
            return

        host = urlparse(normalized).netloc.lower()
        if "dropbox.com" not in host:
            self._set_dropbox_status(
                f"URL format parsed ({length} chars), but host is not Dropbox: {host}",
                self.brand["warning"],
            )
            return

        if not token:
            self._set_dropbox_status(
                f"Dropbox URL looks valid ({length} chars), but API token is missing.",
                self.brand["warning"],
            )
            return

        if self._is_current_dropbox_validated():
            self._set_dropbox_status(
                f"✓ Dropbox link access verified ({length} chars).",
                self.brand["success"],
            )
        else:
            if select_user:
                detail = f" select_user={select_user[:24]}{'...' if len(select_user) > 24 else ''}"
            else:
                detail = ""
            self._set_dropbox_status(
                f"Dropbox URL + token ready ({length} chars). Click 'Validate Link'.{detail}",
                self.brand["warning"],
            )

    def _on_validate_dropbox(self) -> None:
        if self._dropbox_validating:
            return

        url = extract_dropbox_url_candidate(
            self.dropbox_url_var.get(),
            self.keynote_var.get(),
            self.video_var.get(),
            self.script_var.get(),
        ) or ""
        if url:
            self.dropbox_url_var.set(url)
        token = self.dropbox_token_var.get().strip()
        select_user = self.dropbox_select_user_var.get().strip()
        if not url:
            messagebox.showerror("Missing Dropbox URL", "Please provide a Dropbox shared URL first.")
            return
        if not token:
            messagebox.showerror("Missing Dropbox Token", "Please provide a Dropbox API token first.")
            return

        try:
            normalized = normalize_dropbox_shared_url(url)
            host = urlparse(normalized).netloc.lower()
            if "dropbox.com" not in host:
                raise ValueError(f"Host is not Dropbox: {host}")
        except Exception as exc:
            self._dropbox_access_verified = False
            self._set_dropbox_status(f"✗ Dropbox URL invalid: {exc}", self.brand["error"])
            return

        self._dropbox_validating = True
        if self.dropbox_validate_button is not None:
            self.dropbox_validate_button.configure(state=tk.DISABLED)
        self._set_dropbox_status("Validating Dropbox link access...", self.brand["info"])

        self._dropbox_validate_request_id += 1
        request_id = self._dropbox_validate_request_id

        thread = threading.Thread(
            target=self._validate_dropbox_worker,
            args=(request_id, url, token, select_user),
            daemon=True,
        )
        thread.start()
        self.root.after(
            DROPBOX_VALIDATE_WATCHDOG_MS,
            lambda rid=request_id: self._on_validate_dropbox_timeout(rid),
        )

    def _validate_dropbox_worker(
        self,
        request_id: int,
        url: str,
        token: str,
        select_user: str,
    ) -> None:
        try:
            normalized = normalize_dropbox_shared_url(url)
            metadata = dropbox_api_post(
                "/sharing/get_shared_link_metadata",
                token,
                {"url": normalized},
                select_user=select_user or None,
                timeout_seconds=DROPBOX_VALIDATE_TIMEOUT_SECONDS,
            )
            tag = str(metadata.get(".tag", "unknown"))
            name = str(metadata.get("name") or "(unnamed)")
            success_message = f"✓ Dropbox link accessible ({tag}: {name})"
            self.root.after(
                0,
                lambda: self._on_validate_dropbox_done(
                    request_id,
                    True,
                    success_message,
                    (url.strip(), token.strip(), select_user.strip()),
                ),
            )
        except Exception as exc:
            error_message = self._augment_dropbox_error_message(str(exc), select_user)
            self.root.after(
                0,
                lambda msg=error_message, rid=request_id: self._on_validate_dropbox_done(
                    rid,
                    False,
                    f"✗ Dropbox access failed: {msg}",
                    None,
                ),
            )

    def _augment_dropbox_error_message(self, error_message: str, select_user: str) -> str:
        if "Dropbox-API-Select-User" in error_message and not select_user.strip():
            return (
                error_message
                + " Team token detected. Set 'Dropbox Select User' (team member id, e.g. dbmid:...)."
            )
        return error_message

    def _on_validate_dropbox_timeout(self, request_id: int) -> None:
        if request_id != self._dropbox_validate_request_id:
            return
        if not self._dropbox_validating:
            return
        self._dropbox_validating = False
        if self.dropbox_validate_button is not None:
            self.dropbox_validate_button.configure(state=tk.NORMAL)
        self._dropbox_access_verified = False
        self._validated_dropbox_context = None
        self._set_dropbox_status(
            (
                f"✗ Dropbox validation timed out after "
                f"{DROPBOX_VALIDATE_TIMEOUT_SECONDS}s. Check token, link permissions, or network."
            ),
            self.brand["error"],
        )

    def _on_validate_dropbox_done(
        self,
        request_id: int,
        ok: bool,
        message: str,
        context: tuple[str, str, str] | None,
    ) -> None:
        if request_id != self._dropbox_validate_request_id:
            return
        self._dropbox_validating = False
        if self.dropbox_validate_button is not None:
            self.dropbox_validate_button.configure(state=tk.NORMAL)

        if ok and context is not None:
            self._dropbox_access_verified = True
            self._validated_dropbox_context = context
            self._set_dropbox_status(message, self.brand["success"])
            return

        self._dropbox_access_verified = False
        self._validated_dropbox_context = None
        self._set_dropbox_status(message, self.brand["error"])

    def _paste_from_clipboard(self, var: tk.StringVar) -> None:
        try:
            text = self.root.clipboard_get()
        except tk.TclError:
            return
        if text:
            var.set(text.strip())

    def _open_long_value_editor(self, var: tk.StringVar, title: str, *, masked: bool = False) -> None:
        window = tk.Toplevel(self.root)
        window.title(title)
        window.geometry("900x300")
        window.configure(bg=self.brand["bg"])
        window.transient(self.root)
        window.grab_set()

        frame = ttk.Frame(window, padding=10, style="Root.TFrame")
        frame.pack(fill=tk.BOTH, expand=True)

        if masked:
            ttk.Label(frame, text="Value:", style="RootBody.TLabel").pack(anchor="w")
            entry_var = tk.StringVar(value=var.get())
            entry = ttk.Entry(frame, textvariable=entry_var, show="*", style="Brand.TEntry")
            entry.pack(fill=tk.X, expand=False, pady=(4, 8))
            entry.focus_set()
        else:
            ttk.Label(frame, text="Value (long text supported):", style="RootBody.TLabel").pack(anchor="w")
            text = scrolledtext.ScrolledText(
                frame,
                wrap=tk.WORD,
                height=10,
                bg=self.brand["log_bg"],
                fg=self.brand["text"],
                insertbackground=self.brand["accent"],
                selectbackground=self.brand["accent"],
                selectforeground="#FFFFFF",
                relief=tk.FLAT,
                borderwidth=0,
                highlightthickness=1,
                highlightbackground=self.brand["panel_border"],
                font=(self.font_family, 10),
                padx=8,
                pady=8,
            )
            text.pack(fill=tk.BOTH, expand=True, pady=(4, 8))
            text.insert("1.0", var.get())
            text.focus_set()

        buttons = ttk.Frame(frame, style="Root.TFrame")
        buttons.pack(fill=tk.X)

        def on_paste() -> None:
            try:
                clipboard = self.root.clipboard_get()
            except tk.TclError:
                return
            if masked:
                entry_var.set(clipboard.strip())
            else:
                text.delete("1.0", tk.END)
                text.insert("1.0", clipboard.strip())

        def on_save() -> None:
            if masked:
                var.set(entry_var.get().strip())
            else:
                var.set(text.get("1.0", tk.END).strip())
            window.destroy()

        ttk.Button(
            buttons,
            text="Paste Clipboard",
            command=on_paste,
            style="Secondary.TButton",
        ).pack(side=tk.LEFT)
        ttk.Button(buttons, text="Cancel", command=window.destroy, style="Secondary.TButton").pack(
            side=tk.RIGHT
        )
        ttk.Button(buttons, text="Save", command=on_save, style="Accent.TButton").pack(
            side=tk.RIGHT, padx=(0, 6)
        )

    def on_open_output(self) -> None:
        output = self.output_var.get().strip()
        if not output:
            return
        path = Path(output).expanduser().resolve()
        path.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.run(["open", str(path)], check=False)
        except Exception:
            pass

    def on_clear_log(self) -> None:
        self.log_text.configure(state=tk.NORMAL)
        self.log_text.delete("1.0", tk.END)
        self.log_text.configure(state=tk.DISABLED)

    def log(self, message: str) -> None:
        self.log_queue.put(message)

    def _drain_logs(self) -> None:
        drained = False
        while True:
            try:
                message = self.log_queue.get_nowait()
            except queue.Empty:
                break
            drained = True
            self.log_text.configure(state=tk.NORMAL)
            self.log_text.insert(tk.END, message.rstrip() + "\n")
            self.log_text.see(tk.END)
            self.log_text.configure(state=tk.DISABLED)
        if drained:
            self.root.update_idletasks()
        self.root.after(100, self._drain_logs)

    def on_run(self) -> None:
        if self.worker_running:
            return

        keynote_input = self.keynote_var.get().strip()
        keynote_mov_input = self.keynote_mov_var.get().strip()
        video_input = self.video_var.get().strip()
        script_input = self.script_var.get().strip()
        dropbox_url_input = self.dropbox_url_var.get().strip()
        dropbox_token_input = self.dropbox_token_var.get().strip()
        dropbox_select_user_input = self.dropbox_select_user_var.get().strip()

        # Backward-compatible UX: if a Dropbox URL is pasted in local asset fields,
        # auto-promote it to Dropbox URL mode.
        dropbox_candidates = [
            value
            for value in [dropbox_url_input, keynote_input, keynote_mov_input, video_input, script_input]
            if looks_like_dropbox_url(value)
        ]
        if dropbox_candidates:
            dropbox_url_input = dropbox_candidates[0]
            self.dropbox_url_var.set(dropbox_url_input)
            # URL values in local fields should not be treated as local filesystem paths.
            if looks_like_url(keynote_input):
                keynote_input = ""
                self.keynote_var.set("")
            if looks_like_url(keynote_mov_input):
                keynote_mov_input = ""
                self.keynote_mov_var.set("")
            if looks_like_url(video_input):
                video_input = ""
                self.video_var.set("")
            if looks_like_url(script_input):
                script_input = ""
                self.script_var.set("")

        if self._dropbox_validating:
            messagebox.showinfo(
                "Dropbox Validation In Progress",
                "Dropbox link validation is still running. Please wait for completion.",
            )
            return

        if not keynote_input and not dropbox_url_input:
            messagebox.showerror(
                "Missing Input",
                "Please select a local Keynote file/folder or provide a Dropbox shared URL.",
            )
            return

        for field_name, value in [
            ("Keynote", keynote_input),
            ("Keynote MOV", keynote_mov_input),
            ("Video", video_input),
            ("Script", script_input),
        ]:
            if value and looks_like_url(value):
                messagebox.showerror(
                    "Unsupported URL Field",
                    f"{field_name} field contains a URL. Use the Dropbox shared URL field instead.",
                )
                return

        keynote_path: Path | None = None
        if keynote_input:
            keynote_path = Path(keynote_input).expanduser().resolve()
            if not keynote_path.exists():
                messagebox.showerror("Invalid Path", f"Keynote path does not exist:\n{keynote_path}")
                return

        video_path: Path | None = None
        if video_input:
            video_path = Path(video_input).expanduser().resolve()
            if not video_path.exists():
                messagebox.showerror("Invalid Path", f"Video path does not exist:\n{video_path}")
                return

        keynote_mov_path: Path | None = None
        if keynote_mov_input:
            keynote_mov_path = Path(keynote_mov_input).expanduser().resolve()
            if not keynote_mov_path.exists():
                messagebox.showerror(
                    "Invalid Path",
                    f"Keynote MOV path does not exist:\n{keynote_mov_path}",
                )
                return

        script_path: Path | None = None
        if script_input:
            script_path = Path(script_input).expanduser().resolve()
            if not script_path.exists():
                messagebox.showerror("Invalid Path", f"Script path does not exist:\n{script_path}")
                return

        if dropbox_url_input and not dropbox_token_input:
            messagebox.showerror(
                "Missing Dropbox Token",
                "Dropbox API token is required when a Dropbox shared URL is provided.",
            )
            return
        if dropbox_url_input and not self._is_current_dropbox_validated():
            proceed = messagebox.askyesno(
                "Dropbox Not Validated",
                "Dropbox link has not been validated in this session.\n"
                "Continue anyway?",
            )
            if not proceed:
                return

        output_root = Path(self.output_var.get().strip()).expanduser().resolve()
        output_root.mkdir(parents=True, exist_ok=True)

        try:
            build_seconds = float(self.build_seconds_var.get().strip())
            slide_seconds = float(self.slide_seconds_var.get().strip())
            pip_lead_seconds = float(self.pip_lead_var.get().strip())
            shot_clock_seconds = float(self.shot_clock_var.get().strip())
            fps = int(self.fps_var.get().strip())
            min_build_seconds = float(self.min_build_var.get().strip())
            min_slide_seconds = float(self.min_slide_var.get().strip())
        except ValueError:
            messagebox.showerror("Invalid Timing", "Timing/FPS fields must be numeric.")
            return

        self.worker_running = True
        self.run_button.configure(state=tk.DISABLED)
        self.log("Starting batch run...")

        config = {
            "keynote_path": keynote_path,
            "keynote_mov_path": keynote_mov_path,
            "video_path": video_path,
            "script_path": script_path,
            "dropbox_url": dropbox_url_input or None,
            "dropbox_token": dropbox_token_input or None,
            "dropbox_select_user": dropbox_select_user_input or None,
            "output_root": output_root,
            "build_seconds": build_seconds,
            "slide_seconds": slide_seconds,
            "pip_lead_seconds": pip_lead_seconds,
            "shot_clock_seconds": shot_clock_seconds,
            "fps": fps,
            "min_build_seconds": min_build_seconds,
            "min_slide_seconds": min_slide_seconds,
            "timing_mode": "auto-fit" if self.auto_fit_timing_var.get() else "fixed",
            "export_xml": self.export_xml_var.get(),
            "export_edl": self.export_edl_var.get(),
            "export_slide_mov": self.export_slide_mov_var.get(),
            "append_tail": self.append_tail_var.get(),
            "continue_on_error": self.continue_on_error_var.get(),
        }

        thread = threading.Thread(target=self._worker, args=(config,), daemon=True)
        thread.start()

    def _run_subprocess(self, command: list[str]) -> tuple[int, str]:
        process = subprocess.run(command, text=True, capture_output=True)
        output = (process.stdout or "") + ("\n" + process.stderr if process.stderr else "")
        return process.returncode, output.strip()

    def _worker(self, config: dict[str, object]) -> None:
        output_root: Path = config["output_root"]  # type: ignore[assignment]
        keynote_path: Path | None = config.get("keynote_path")  # type: ignore[assignment]
        keynote_mov_path: Path | None = config.get("keynote_mov_path")  # type: ignore[assignment]
        video_path: Path | None = config.get("video_path")  # type: ignore[assignment]
        script_path: Path | None = config.get("script_path")  # type: ignore[assignment]
        dropbox_url: str | None = config.get("dropbox_url")  # type: ignore[assignment]
        dropbox_token: str | None = config.get("dropbox_token")  # type: ignore[assignment]
        dropbox_select_user: str | None = config.get("dropbox_select_user")  # type: ignore[assignment]

        failures = 0
        success = 0

        if dropbox_url:
            try:
                if not dropbox_token:
                    raise RuntimeError("Dropbox token missing.")
                timestamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
                dropbox_stage_root = output_root / "_dropbox_stage" / timestamp
                self.log(f"Dropbox URL detected. Downloading assets to: {dropbox_stage_root}")
                download_dropbox_shared_assets(
                    shared_url=dropbox_url,
                    token=dropbox_token,
                    destination_root=dropbox_stage_root,
                    logger=self.log,
                    select_user=dropbox_select_user,
                )
                # Use Dropbox staged files as defaults when local overrides are absent.
                keynote_path = keynote_path or dropbox_stage_root
                keynote_mov_path = keynote_mov_path or dropbox_stage_root
                video_path = video_path or dropbox_stage_root
                script_path = script_path or dropbox_stage_root
            except Exception as exc:
                self.log(f"Dropbox download failed: {exc}")
                self.log("=" * 72)
                self.log("Batch finished. Success: 0, Failed: 1")
                self.root.after(0, self._on_worker_done)
                return

        if keynote_path is None:
            self.log("No Keynote source available after resolving inputs.")
            self.log("=" * 72)
            self.log("Batch finished. Success: 0, Failed: 1")
            self.root.after(0, self._on_worker_done)
            return

        projects = resolve_projects(
            keynote_path=keynote_path,
            keynote_mov_path=keynote_mov_path,
            video_path=video_path,
            script_path=script_path,
        )
        if not projects:
            self.log(f"No .key files found in source: {keynote_path}")
            self.log("=" * 72)
            self.log("Batch finished. Success: 0, Failed: 1")
            self.root.after(0, self._on_worker_done)
            return

        self.log(f"Found {len(projects)} project(s).")

        for index, project in enumerate(projects, start=1):
            self.log("=" * 72)
            self.log(f"[{index}/{len(projects)}] Project {project.project_key}")
            self.log(f"Keynote: {project.keynote}")
            self.log(f"Keynote MOV: {project.keynote_mov if project.keynote_mov else 'none'}")
            self.log(f"Video:   {project.video if project.video else 'MISSING'}")
            self.log(f"Script:  {project.script_pdf if project.script_pdf else 'none'}")

            if project.video is None:
                self.log("Skipping: No matching video found.")
                failures += 1
                if not config["continue_on_error"]:
                    break
                continue

            project_dir = output_root / project.project_key
            project_dir.mkdir(parents=True, exist_ok=True)
            plan_path = project_dir / f"{project.project_key}_edit_plan.json"
            xml_path = project_dir / f"{project.project_key}_premiere.xml"
            edl_path = project_dir / f"{project.project_key}_main.edl"
            oncam_edl_path = project_dir / f"{project.project_key}_oncam.edl"
            slides_edl_path = project_dir / f"{project.project_key}_slides_overlay.edl"
            slide_mov_path = project_dir / f"{project.project_key}_slides_timed.mov"
            manifest_json_path = project_dir / f"{project.project_key}_delivery_manifest.json"
            import_guide_path = project_dir / f"{project.project_key}_premiere_import.md"
            stage_dir = project_dir / f"{project.project_key}_stages"

            build_cmd = [
                sys.executable,
                str(BUILD_SCRIPT),
                "--keynote",
                str(project.keynote),
                "--video",
                str(project.video),
                "--project-name",
                project.project_key,
                "--build-seconds",
                str(config["build_seconds"]),
                "--slide-seconds",
                str(config["slide_seconds"]),
                "--pip-lead-seconds",
                str(config["pip_lead_seconds"]),
                "--shot-clock-seconds",
                str(config["shot_clock_seconds"]),
                "--fps",
                str(config["fps"]),
                "--timing-mode",
                str(config["timing_mode"]),
                "--min-build-seconds",
                str(config["min_build_seconds"]),
                "--min-slide-seconds",
                str(config["min_slide_seconds"]),
                "--video-fit-mode",
                "append-oncam-tail" if config["append_tail"] else "none",
                "--output",
                str(plan_path),
            ]
            if project.script_pdf:
                build_cmd.extend(["--script-pdf", str(project.script_pdf)])

            self.log("Running JSON build...")
            code, output = self._run_subprocess(build_cmd)
            if output:
                self.log(output)
            if code != 0:
                self.log("JSON build failed.")
                failures += 1
                if not config["continue_on_error"]:
                    break
                continue

            if config["export_xml"]:
                xml_cmd = [
                    sys.executable,
                    str(XML_SCRIPT),
                    "--plan",
                    str(plan_path),
                    "--output",
                    str(xml_path),
                    "--stage-export-dir",
                    str(stage_dir),
                    "--pip-mode",
                    "flat",
                ]
                self.log("Running Premiere XML export...")
                code, output = self._run_subprocess(xml_cmd)
                if output:
                    self.log(output)
                if code != 0:
                    self.log("XML export failed.")
                    failures += 1
                    if not config["continue_on_error"]:
                        break
                    continue

            slides_for_edl: Path | None = slide_mov_path if slide_mov_path.exists() else None
            if config.get("export_slide_mov"):
                if project.keynote_mov is None:
                    self.log("Timed slide MOV skipped: no matching Keynote animation MOV found.")
                else:
                    mov_cmd = [
                        sys.executable,
                        str(SLIDE_MOV_SCRIPT),
                        "--plan",
                        str(plan_path),
                        "--keynote-mov",
                        str(project.keynote_mov),
                        "--output",
                        str(slide_mov_path),
                    ]
                    self.log("Running timed slide MOV render...")
                    code, output = self._run_subprocess(mov_cmd)
                    if output:
                        self.log(output)
                    if code != 0:
                        self.log("Timed slide MOV render failed.")
                        failures += 1
                        if not config["continue_on_error"]:
                            break
                        continue
                    slides_for_edl = slide_mov_path

            if config.get("export_edl"):
                intercut_cmd = [
                    sys.executable,
                    str(EDL_SCRIPT),
                    "--plan",
                    str(plan_path),
                    "--output",
                    str(edl_path),
                    "--main-video",
                    str(project.video),
                    "--mode",
                    "intercut",
                ]
                if slides_for_edl and slides_for_edl.exists():
                    intercut_cmd.extend(["--slides-video", str(slides_for_edl)])
                self.log("Running EDL export (intercut)...")
                code, output = self._run_subprocess(intercut_cmd)
                if output:
                    self.log(output)
                if code != 0:
                    self.log("EDL export failed.")
                    failures += 1
                    if not config["continue_on_error"]:
                        break
                    continue

                oncam_cmd = [
                    sys.executable,
                    str(EDL_SCRIPT),
                    "--plan",
                    str(plan_path),
                    "--output",
                    str(oncam_edl_path),
                    "--main-video",
                    str(project.video),
                    "--mode",
                    "oncam",
                ]
                self.log("Running EDL export (on-cam only)...")
                code, output = self._run_subprocess(oncam_cmd)
                if output:
                    self.log(output)
                if code != 0:
                    self.log("On-cam EDL export failed.")
                    failures += 1
                    if not config["continue_on_error"]:
                        break
                    continue

                if slides_for_edl and slides_for_edl.exists():
                    slides_cmd = [
                        sys.executable,
                        str(EDL_SCRIPT),
                        "--plan",
                        str(plan_path),
                        "--output",
                        str(slides_edl_path),
                        "--main-video",
                        str(project.video),
                        "--slides-video",
                        str(slides_for_edl),
                        "--mode",
                        "slides",
                    ]
                    self.log("Running EDL export (slides overlay only)...")
                    code, output = self._run_subprocess(slides_cmd)
                    if output:
                        self.log(output)
                    if code != 0:
                        self.log("Slides-overlay EDL export failed.")
                        failures += 1
                        if not config["continue_on_error"]:
                            break
                        continue
                else:
                    self.log("Slides-overlay EDL skipped: timed slide MOV is unavailable.")

            manifest_cmd = [
                sys.executable,
                str(MANIFEST_SCRIPT),
                "--plan",
                str(plan_path),
                "--project-dir",
                str(project_dir),
                "--main-video",
                str(project.video),
                "--manifest-json",
                str(manifest_json_path),
                "--import-guide",
                str(import_guide_path),
            ]
            if xml_path.exists():
                manifest_cmd.extend(["--xml", str(xml_path)])
            if edl_path.exists():
                manifest_cmd.extend(["--main-edl", str(edl_path)])
            if oncam_edl_path.exists():
                manifest_cmd.extend(["--oncam-edl", str(oncam_edl_path)])
            if slides_edl_path.exists():
                manifest_cmd.extend(["--slides-edl", str(slides_edl_path)])
            if slides_for_edl and slides_for_edl.exists():
                manifest_cmd.extend(["--slides-video", str(slides_for_edl)])

            self.log("Writing delivery manifest...")
            code, output = self._run_subprocess(manifest_cmd)
            if output:
                self.log(output)
            if code != 0:
                self.log("Delivery manifest generation failed (non-fatal).")

            # Optional short summary readback.
            try:
                payload = json.loads(plan_path.read_text(encoding="utf-8"))
                summary = payload.get("summary", {})
                self.log(
                    "Summary: "
                    + json.dumps(
                        {
                            "main_sequence_duration_sec": summary.get("main_sequence_duration_sec"),
                            "video_duration_sec": summary.get("video_duration_sec"),
                            "main_sequence_cut_count": summary.get("main_sequence_cut_count"),
                            "script_cue_count": summary.get("script_cue_count"),
                        }
                    )
                )
            except Exception:
                pass

            success += 1
            self.log(f"Completed: {project.project_key}")

        self.log("=" * 72)
        self.log(f"Batch finished. Success: {success}, Failed: {failures}")
        self.root.after(0, self._on_worker_done)

    def _on_worker_done(self) -> None:
        self.worker_running = False
        self.run_button.configure(state=tk.NORMAL)


def main() -> None:
    if not BUILD_SCRIPT.exists():
        fail(f"Missing build script: {BUILD_SCRIPT}")
    if not XML_SCRIPT.exists():
        fail(f"Missing XML export script: {XML_SCRIPT}")
    if not EDL_SCRIPT.exists():
        fail(f"Missing EDL export script: {EDL_SCRIPT}")
    if not SLIDE_MOV_SCRIPT.exists():
        fail(f"Missing timed slide MOV script: {SLIDE_MOV_SCRIPT}")
    if not MANIFEST_SCRIPT.exists():
        fail(f"Missing delivery manifest script: {MANIFEST_SCRIPT}")

    root = tk.Tk()
    app = AutocutV1UI(root)
    _ = app
    root.mainloop()


if __name__ == "__main__":
    main()
