from __future__ import annotations

import asyncio
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List

from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from mutagen.id3 import ID3, ID3NoHeaderError
from mutagen.mp3 import MP3

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATE_DIR = BASE_DIR / "templates"

app = FastAPI(title="M4B Foundry")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATE_DIR)


@app.get("/", response_class=HTMLResponse)
async def landing(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok"})


def _ensure_ffmpeg() -> str:
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise RuntimeError(
            "ffmpeg is required but was not found on the system PATH. "
            "Install ffmpeg and make sure it is reachable."
        )
    return ffmpeg_path


def _sanitize_filename(name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]", "_", name)
    return cleaned or "track.mp3"


def _slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "audiobook"


def _concat_and_convert(
    ffmpeg_path: str,
    files: List[Path],
    working_dir: Path,
    title: str,
    author: str,
) -> Path:
    combined_mp3 = working_dir / "combined.mp3"
    output_path = working_dir / "audiobook.m4b"
    list_file = working_dir / "inputs.txt"

    with list_file.open("w", encoding="utf-8") as handle:
        for file_path in files:
            handle.write(f"file '{file_path.as_posix()}'\n")

    concat_cmd = [
        ffmpeg_path,
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_file),
        "-c",
        "copy",
        str(combined_mp3),
    ]

    concat_proc = subprocess.run(
        concat_cmd, capture_output=True, text=True, check=False
    )
    if concat_proc.returncode != 0:
        raise RuntimeError(
            "Failed to concatenate MP3 files.\n" + concat_proc.stderr.strip()
        )

    convert_cmd = [
        ffmpeg_path,
        "-y",
        "-i",
        str(combined_mp3),
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-vn",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        "-metadata",
        f"title={title}",
        "-metadata",
        f"artist={author or 'Unknown'}",
        str(output_path),
    ]

    convert_proc = subprocess.run(
        convert_cmd, capture_output=True, text=True, check=False
    )
    if convert_proc.returncode != 0:
        raise RuntimeError(
            "Failed to convert to M4B.\n" + convert_proc.stderr.strip()
        )

    combined_mp3.unlink(missing_ok=True)
    list_file.unlink(missing_ok=True)

    # Build chapter markers from individual file durations
    all_meta = [_extract_metadata(fp) for fp in files]
    filenames = [fp.name for fp in files]
    chapter_names = _infer_chapter_names(filenames, all_meta)

    chapters: List[Dict[str, Any]] = []
    cursor_ms = 0
    for i, meta in enumerate(all_meta):
        duration_ms = int(meta["duration"] * 1000)
        if duration_ms > 0:
            chapters.append({
                "start_ms": cursor_ms,
                "end_ms": cursor_ms + duration_ms,
                "title": chapter_names[i],
            })
            cursor_ms += duration_ms

    _build_chapters_metadata(ffmpeg_path, output_path, chapters)

    return output_path


def _most_common(values: List[str]) -> str | None:
    """Return the most frequently occurring non-empty string."""
    cleaned = [v.strip() for v in values if v and v.strip()]
    if not cleaned:
        return None
    counts: Dict[str, int] = {}
    originals: Dict[str, str] = {}
    for v in cleaned:
        key = v.lower()
        counts[key] = counts.get(key, 0) + 1
        originals[key] = v
    best_key = max(counts, key=counts.get)
    return originals[best_key]


_FILENAME_PATTERNS = [
    # Author - Title - Chapter 01 / Author - Title - 01 - Name
    (re.compile(r"^(.+?)\s*[-–—]\s*(.+?)\s*[-–—]\s*(?:(?:ch(?:apter)?\.?\s*)?(\d+)\s*[-–—.]?\s*(.+?))?\.mp3$", re.I),
     lambda m: (m.group(1).strip(), m.group(2).strip(), m.group(4).strip() if m.group(4) else None)),
    # Title - 01 - Chapter Name  /  Title - Chapter 01
    (re.compile(r"^(.+?)\s*[-–—]\s*(?:ch(?:apter)?\.?\s*)?(\d+)\s*(?:[-–—.]\s*(.+?))?\.mp3$", re.I),
     lambda m: (None, m.group(1).strip(), m.group(3).strip() if m.group(3) else None)),
    # Title Ch01.mp3
    (re.compile(r"^(.+?)\s+ch(?:apter)?\.?\s*(\d+)\.mp3$", re.I),
     lambda m: (None, m.group(1).strip(), None)),
    # 01 - Chapter Name.mp3
    (re.compile(r"^(\d+)\s*[-–—.]\s*(.+?)\.mp3$", re.I),
     lambda m: (None, None, m.group(2).strip())),
    # Chapter 01.mp3
    (re.compile(r"^ch(?:apter)?\.?\s*(\d+)\.mp3$", re.I),
     lambda m: (None, None, None)),
    # 01.mp3
    (re.compile(r"^(\d+)\.mp3$", re.I),
     lambda m: (None, None, None)),
]


def _clean_chapter_name(raw: str | None) -> str | None:
    if not raw:
        return None
    cleaned = raw.strip()
    for noise in [
        re.compile(r"^\d+\s*[-–—.)\]]\s*"),
        re.compile(r"^ch(?:apter)?\.?\s*", re.I),
        re.compile(r"^track\s*\d*\s*[-–—.]?\s*", re.I),
    ]:
        cleaned = noise.sub("", cleaned)
    cleaned = re.sub(r"\s*[(\[]\d+[)\]]\s*$", "", cleaned)
    cleaned = cleaned.replace("_", " ").strip()
    if cleaned and cleaned == cleaned.lower():
        cleaned = cleaned.title()
    return cleaned or None


def _parse_filename(filename: str) -> tuple[str | None, str | None, str | None]:
    """Returns (author, title, chapter_name) from a filename."""
    basename = Path(filename).name
    for pattern, extractor in _FILENAME_PATTERNS:
        m = pattern.match(basename)
        if m:
            return extractor(m)
    # Fallback
    stem = Path(basename).stem.replace("_", " ").strip()
    return (None, None, stem)


def _infer_chapter_names(
    filenames: List[str], metadata_list: List[Dict[str, Any]]
) -> List[str]:
    """Build smart chapter names from filenames and ID3 tags."""
    parsed = [_parse_filename(fn) for fn in filenames]
    chapter_names = []
    for i, (_author, _title, ch_name) in enumerate(parsed):
        meta = metadata_list[i] if i < len(metadata_list) else {}
        num = i + 1
        clean_id3 = _clean_chapter_name(meta.get("title"))
        clean_fn = _clean_chapter_name(ch_name)
        name = clean_id3 or clean_fn
        if name:
            has_num = bool(re.match(r"^\d", name)) or bool(re.search(r"chapter\s*\d", name, re.I))
            chapter_names.append(name if has_num else f"Chapter {num}: {name}")
        else:
            chapter_names.append(f"Chapter {num}")
    return chapter_names


def _infer_book_info(
    filenames: List[str], metadata_list: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """Infer book title and author from filenames + ID3 consensus."""
    parsed = [_parse_filename(fn) for fn in filenames]
    fn_titles = [t for _, t, _ in parsed if t]
    fn_authors = [a for a, _, _ in parsed if a]
    id3_albums = [m.get("album") for m in metadata_list if m.get("album")]
    id3_artists = [m.get("artist") for m in metadata_list if m.get("artist")]
    return {
        "title": _most_common(id3_albums) or _most_common(fn_titles),
        "author": _most_common(id3_artists) or _most_common(fn_authors),
    }


def _extract_metadata(file_path: Path) -> Dict[str, Any]:
    """Read ID3 tags and audio info from an MP3 file."""
    result: Dict[str, Any] = {
        "duration": 0.0,
        "bitrate": 0,
        "sample_rate": 0,
        "title": None,
        "artist": None,
        "album": None,
        "track": None,
        "year": None,
    }
    try:
        audio = MP3(file_path)
        result["duration"] = round(audio.info.length, 2)
        result["bitrate"] = audio.info.bitrate // 1000
        result["sample_rate"] = audio.info.sample_rate
    except Exception:
        return result

    try:
        tags = ID3(file_path)
        result["title"] = str(tags["TIT2"]) if "TIT2" in tags else None
        result["artist"] = str(tags["TPE1"]) if "TPE1" in tags else None
        result["album"] = str(tags["TALB"]) if "TALB" in tags else None
        result["year"] = str(tags["TDRC"]) if "TDRC" in tags else None
        if "TRCK" in tags:
            result["track"] = str(tags["TRCK"])
    except ID3NoHeaderError:
        pass

    return result


def _build_chapters_metadata(
    ffmpeg_path: str, m4b_path: Path, chapters: List[Dict[str, Any]]
) -> None:
    """Inject chapter markers into an existing M4B file using ffmpeg."""
    if not chapters:
        return

    metadata_file = m4b_path.parent / "chapters.txt"
    with metadata_file.open("w", encoding="utf-8") as fh:
        fh.write(";FFMETADATA1\n")
        for ch in chapters:
            fh.write("\n[CHAPTER]\nTIMEBASE=1/1000\n")
            fh.write(f"START={ch['start_ms']}\n")
            fh.write(f"END={ch['end_ms']}\n")
            fh.write(f"title={ch['title']}\n")

    chaptered_path = m4b_path.parent / "chaptered.m4b"
    cmd = [
        ffmpeg_path, "-y",
        "-i", str(m4b_path),
        "-i", str(metadata_file),
        "-map_metadata", "1",
        "-map_chapters", "1",
        "-c", "copy",
        str(chaptered_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    metadata_file.unlink(missing_ok=True)
    if proc.returncode == 0:
        chaptered_path.replace(m4b_path)
    else:
        chaptered_path.unlink(missing_ok=True)


async def _persist_upload(upload_file: UploadFile, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as buffer:
        while True:
            chunk = await upload_file.read(1024 * 1024)
            if not chunk:
                break
            buffer.write(chunk)
    await upload_file.seek(0)


@app.post("/api/metadata")
async def extract_metadata(
    files: List[UploadFile] = File(..., description="MP3 files to inspect"),
) -> JSONResponse:
    """Return ID3 metadata, inferred book info, and chapter names."""
    working_dir = Path(tempfile.mkdtemp(prefix="m4b_meta_"))
    results = []
    filenames = []
    try:
        for idx, upload in enumerate(files, start=1):
            filename = upload.filename or f"track_{idx}.mp3"
            filenames.append(filename)
            target = working_dir / f"{idx:03d}_{_sanitize_filename(filename)}"
            await _persist_upload(upload, target)
            meta = await asyncio.to_thread(_extract_metadata, target)
            meta["filename"] = filename
            results.append(meta)
    finally:
        shutil.rmtree(working_dir, ignore_errors=True)

    book_info = _infer_book_info(filenames, results)
    chapter_names = _infer_chapter_names(filenames, results)
    return JSONResponse({
        "tracks": results,
        "book": book_info,
        "chapters": chapter_names,
    })


@app.post("/api/compile")
async def compile_audiobook(
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(..., description="MP3 files in playback order"),
    title: str = Form("Untitled Audiobook"),
    author: str = Form("Unknown"),
) -> FileResponse:
    if not files:
        raise HTTPException(status_code=400, detail="Please upload at least one MP3 file.")

    ffmpeg_path = None
    try:
        ffmpeg_path = _ensure_ffmpeg()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    working_dir = Path(tempfile.mkdtemp(prefix="m4b_builder_"))

    saved_files: List[Path] = []
    try:
        for idx, upload in enumerate(files, start=1):
            filename = upload.filename or f"track_{idx}.mp3"
            if not filename.lower().endswith(".mp3"):
                raise HTTPException(
                    status_code=400,
                    detail=f"{filename} is not an MP3 file.",
                )
            target = working_dir / f"{idx:03d}_{_sanitize_filename(filename)}"
            await _persist_upload(upload, target)
            saved_files.append(target)

        output_path = await asyncio.to_thread(
            _concat_and_convert, ffmpeg_path, saved_files, working_dir, title, author
        )
    except Exception:
        shutil.rmtree(working_dir, ignore_errors=True)
        raise

    slug_title = _slugify(title)
    download_name = f"{slug_title}.m4b"

    background_tasks.add_task(shutil.rmtree, working_dir, ignore_errors=True)

    return FileResponse(
        path=output_path,
        filename=download_name,
        media_type="audio/x-m4b",
        background=background_tasks,
    )
