import { FFmpeg } from "https://esm.sh/@ffmpeg/ffmpeg@0.12.10";
import { fetchFile, toBlobURL } from "https://esm.sh/@ffmpeg/util@0.12.1";
import { inferBook, extractSortKey } from "./book-parser.js";
import { searchBooks, fetchCoverBlob, fetchChapters, fetchBookDetails } from "./book-lookup.js";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const form = document.getElementById("compile-form");
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const workspace = document.getElementById("workspace");
const trackList = document.getElementById("track-list");
const addMoreBtn = document.getElementById("add-more-btn");
const clearAllButton = document.getElementById("clear-all");
const compileButton = document.getElementById("compile-button");
const compileSummary = document.getElementById("compile-summary");
const fileBarInfo = document.getElementById("file-bar-info");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const progressTrack = document.getElementById("progress-track");
const progressFill = document.getElementById("progress-fill");
const titleInput = form.elements.namedItem("title");
const authorInput = form.elements.namedItem("author");
const yearInput = form.elements.namedItem("year");
const genreInput = form.elements.namedItem("genre");
const descriptionInput = form.elements.namedItem("description");
const coverPreview = document.getElementById("cover-preview");
const coverInput = document.getElementById("cover-input");
const coverPlaceholder = document.getElementById("cover-placeholder");
const coverUploadBtn = document.getElementById("cover-upload-btn");
const coverRemoveBtn = document.getElementById("cover-remove-btn");
const lookupQuery = document.getElementById("lookup-query");
const lookupBtn = document.getElementById("lookup-btn");
const lookupResults = document.getElementById("lookup-results");
const lookupResultsList = document.getElementById("lookup-results-list");
const lookupDismiss = document.getElementById("lookup-dismiss");
const defaultCompileSummary = "Drop MP3 chapters to prep your forge.";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let tracks = []; // { file, meta, chapterName }
let ffmpeg = null;
let ffmpegReady = false;
let inferredBook = null;
let coverFile = null;
let coverObjectURL = null;

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------
const updateStatus = (label, state = "busy") => {
  statusText.textContent = label;
  statusDot.className = "status-dot" + (state === "idle" ? "" : state === "error" ? " error" : " busy");
};

const setIdle = (label = "Ready") => {
  statusText.textContent = label;
  statusDot.className = "status-dot";
};

const showProgress = (pct) => {
  progressTrack.hidden = false;
  progressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
};

const hideProgress = () => {
  progressTrack.hidden = true;
  progressFill.style.width = "0%";
};

const formatDuration = (seconds) => {
  if (!seconds) return "--:--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
};

// ---------------------------------------------------------------------------
// Cover art management
// ---------------------------------------------------------------------------
const setCover = (blob) => {
  if (coverObjectURL) URL.revokeObjectURL(coverObjectURL);
  coverFile = blob;
  coverObjectURL = URL.createObjectURL(blob);

  const existing = coverPreview.querySelector("img");
  if (existing) {
    existing.src = coverObjectURL;
  } else {
    coverPlaceholder.innerHTML = "";
    const img = document.createElement("img");
    img.src = coverObjectURL;
    img.alt = "Cover art";
    coverPlaceholder.replaceWith(img);
  }
  coverRemoveBtn.hidden = false;
};

const removeCover = () => {
  if (coverObjectURL) URL.revokeObjectURL(coverObjectURL);
  coverFile = null;
  coverObjectURL = null;
  const existing = coverPreview.querySelector("img");
  if (existing) {
    const ph = document.createElement("div");
    ph.className = "cover-placeholder";
    ph.id = "cover-placeholder";
    ph.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity=".4">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
      <span>Click to add cover</span>`;
    existing.replaceWith(ph);
  }
  coverRemoveBtn.hidden = true;
};

// ---------------------------------------------------------------------------
// ID3 metadata extraction
// ---------------------------------------------------------------------------
const readID3 = (file) =>
  new Promise((resolve) => {
    if (!window.jsmediatags) {
      const script = document.createElement("script");
      script.src =
        "https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.7/jsmediatags.min.js";
      script.onload = () => parseTag(file, resolve);
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    } else {
      parseTag(file, resolve);
    }
  });

const parseTag = (file, resolve) => {
  window.jsmediatags.read(file, {
    onSuccess: (tag) => {
      const t = tag.tags || {};
      let picture = null;
      if (t.picture) {
        const { data, format } = t.picture;
        const bytes = new Uint8Array(data);
        picture = new Blob([bytes], { type: format });
      }
      const normalizeComment = (entry) => {
        if (!entry) return null;
        if (Array.isArray(entry)) {
          for (const item of entry) {
            const text = normalizeComment(item);
            if (text) return text;
          }
          return null;
        }
        if (typeof entry === "string") return entry.trim();
        if (typeof entry === "object") {
          if (typeof entry.text === "string") return entry.text.trim();
          if (typeof entry.description === "string") return entry.description.trim();
          if (entry.data && typeof entry.data === "string") return entry.data.trim();
        }
        return null;
      };
      const comment = normalizeComment(t.comment) || normalizeComment(t.COMM) || normalizeComment(t.comments);
      resolve({
        title: t.title || null,
        artist: t.artist || null,
        album: t.album || null,
        year: t.year || null,
        track: t.track ? String(t.track) : null,
        genre: t.genre || null,
        comment,
        picture,
      });
    },
    onError: () => resolve(null),
  });
};

const readAudioInfo = (file) =>
  new Promise((resolve) => {
    const audio = new Audio();
    audio.preload = "metadata";
    const url = URL.createObjectURL(file);
    audio.src = url;
    audio.addEventListener(
      "loadedmetadata",
      () => {
        const duration = audio.duration || 0;
        const bitrate =
          duration > 0 ? Math.round((file.size * 8) / duration / 1000) : 0;
        URL.revokeObjectURL(url);
        resolve({ duration: Math.round(duration * 100) / 100, bitrate });
      },
      { once: true }
    );
    audio.addEventListener(
      "error",
      () => {
        URL.revokeObjectURL(url);
        resolve({ duration: 0, bitrate: 0 });
      },
      { once: true }
    );
  });

const extractMetadata = async (file) => {
  const [id3, audioInfo] = await Promise.all([
    readID3(file),
    readAudioInfo(file),
  ]);
  return {
    title: id3?.title || null,
    artist: id3?.artist || null,
    album: id3?.album || null,
    year: id3?.year || null,
    track: id3?.track || null,
    genre: id3?.genre || null,
    description: id3?.comment || null,
    picture: id3?.picture || null,
    duration: audioInfo.duration,
    bitrate: audioInfo.bitrate,
  };
};

// ---------------------------------------------------------------------------
// FFmpeg.wasm setup
// ---------------------------------------------------------------------------
const loadFFmpeg = async () => {
  if (ffmpegReady) return;
  updateStatus("Loading FFmpeg...");
  showProgress(10);

  ffmpeg = new FFmpeg();
  ffmpeg.on("progress", ({ progress }) => showProgress(20 + progress * 70));

  const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(
      `${baseURL}/ffmpeg-core.wasm`,
      "application/wasm"
    ),
  });

  ffmpegReady = true;
  hideProgress();
  setIdle();
};

// ---------------------------------------------------------------------------
// Track list UI
// ---------------------------------------------------------------------------
const refreshTrackList = () => {
  trackList.innerHTML = "";

  if (!tracks.length) {
    trackList.innerHTML =
      '<div class="track-list-empty">No chapters added yet. Drop MP3 files above.</div>';
    compileButton.disabled = true;
    compileSummary.textContent = defaultCompileSummary;
    if (fileBarInfo) fileBarInfo.textContent = "No files loaded yet.";
    workspace.hidden = true;
    dropZone.classList.remove("compact");
    return;
  }

  workspace.hidden = false;
  dropZone.classList.add("compact");
  compileButton.disabled = false;

  // Summary
  const totalDuration = tracks.reduce(
    (s, t) => s + (t.meta?.duration || 0),
    0
  );
  const totalSize = tracks.reduce((s, t) => s + t.file.size, 0);
  const durationLabel = formatDuration(totalDuration);
  const sizeLabel = (totalSize / (1024 * 1024)).toFixed(1);
  const chapterLabel = `${tracks.length} chapter${tracks.length !== 1 ? "s" : ""}`;
  compileSummary.textContent = `${chapterLabel} \u00b7 ${durationLabel} \u00b7 ${sizeLabel} MB`;
  if (fileBarInfo) {
    fileBarInfo.textContent = `${chapterLabel} ready \u00b7 ${durationLabel} total \u00b7 ${sizeLabel} MB`;
  }

  tracks.forEach((track, index) => {
    const row = document.createElement("div");
    row.className = "track-row";

    // Number
    const num = document.createElement("span");
    num.className = "track-num";
    num.textContent = String(index + 1).padStart(2, "0");

    // Body (chapter name input + details)
    const body = document.createElement("div");
    body.className = "track-body";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "track-chapter-input";
    nameInput.value = track.chapterName || `Chapter ${index + 1}`;
    nameInput.addEventListener("change", () => {
      track.chapterName = nameInput.value.trim() || `Chapter ${index + 1}`;
    });

    const detail = document.createElement("span");
    detail.className = "track-detail";
    const parts = [track.file.name];
    if (track.meta) {
      parts.push(formatDuration(track.meta.duration));
      parts.push(`${track.meta.bitrate || "?"}kbps`);
    }
    parts.push(`${(track.file.size / (1024 * 1024)).toFixed(1)} MB`);
    detail.textContent = parts.join(" \u00b7 ");

    body.append(nameInput, detail);

    // Actions
    const actions = document.createElement("div");
    actions.className = "track-actions";

    const mkBtn = (label, cls, handler) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `btn btn-icon${cls ? " " + cls : ""}`;
      b.innerHTML = label;
      b.addEventListener("click", handler);
      return b;
    };

    const upBtn = mkBtn("\u2191", "", () => moveTrack(index, index - 1));
    upBtn.disabled = index === 0;
    const downBtn = mkBtn("\u2193", "", () => moveTrack(index, index + 1));
    downBtn.disabled = index === tracks.length - 1;
    const removeBtn = mkBtn("\u2715", "danger", () => removeTrack(index));

    actions.append(upBtn, downBtn, removeBtn);
    row.append(num, body, actions);
    trackList.append(row);
  });
};

// ---------------------------------------------------------------------------
// Track management
// ---------------------------------------------------------------------------
const parseTrackNum = (track) => {
  if (track == null) return null;
  // Handle "3/12" format (track number / total tracks)
  const str = String(track).split("/")[0].trim();
  const n = parseInt(str, 10);
  return Number.isFinite(n) ? n : null;
};

const sortTracks = () => {
  const hasID3TrackNums = tracks.some(
    (t) => parseTrackNum(t.meta?.track) != null
  );

  tracks.sort((a, b) => {
    if (hasID3TrackNums) {
      const numA = parseTrackNum(a.meta?.track);
      const numB = parseTrackNum(b.meta?.track);
      if (numA != null && numB != null && numA !== numB) return numA - numB;
      if (numA != null && numB == null) return -1;
      if (numA == null && numB != null) return 1;
    }
    const keyA = extractSortKey(a.file.name);
    const keyB = extractSortKey(b.file.name);
    if (keyA !== keyB) return keyA - keyB;
    return a.file.name.localeCompare(b.file.name, undefined, {
      numeric: true,
    });
  });
};

const addFiles = async (fileList) => {
  const mp3Files = Array.from(fileList).filter(
    (file) =>
      file.type === "audio/mpeg" || file.name.toLowerCase().endsWith(".mp3")
  );
  if (!mp3Files.length) return;

  const newTracks = mp3Files.map((file) => ({
    file,
    meta: null,
    chapterName: null,
  }));
  tracks = [...tracks, ...newTracks];

  // Initial sort by filename numbers
  tracks.sort((a, b) => {
    const keyA = extractSortKey(a.file.name);
    const keyB = extractSortKey(b.file.name);
    if (keyA !== keyB) return keyA - keyB;
    return a.file.name.localeCompare(b.file.name, undefined, {
      numeric: true,
    });
  });

  refreshTrackList();
  updateStatus("Reading metadata...");

  // Extract metadata
  await Promise.all(newTracks.map(async (t) => {
    t.meta = await extractMetadata(t.file);
  }));

  // Re-sort with ID3 track numbers
  sortTracks();

  // Infer book info
  const allMeta = tracks.map((t) => t.meta);
  inferredBook = inferBook(tracks, allMeta);

  // Apply chapter names
  if (inferredBook.chapters) {
    inferredBook.chapters.forEach((name, i) => {
      if (i < tracks.length) tracks[i].chapterName = name;
    });
  }

  // Auto-populate metadata fields
  if (inferredBook.title && titleInput.value === "Untitled Audiobook") {
    titleInput.value = inferredBook.title;
  }
  if (inferredBook.author && authorInput.value === "Unknown") {
    authorInput.value = inferredBook.author;
  }
  if (
    inferredBook.description &&
    !descriptionInput.value.trim()
  ) {
    descriptionInput.value = inferredBook.description;
  }
  let needsYear = !yearInput.value;
  let needsGenre = genreInput.value === "Audiobook";
  let needsDescription = !descriptionInput.value.trim();
  for (const t of tracks) {
    if (!t.meta) continue;
    if (needsYear && t.meta.year) {
      yearInput.value = t.meta.year;
      needsYear = false;
    }
    if (needsGenre && t.meta.genre) {
      genreInput.value = t.meta.genre;
      needsGenre = false;
    }
    if (needsDescription && t.meta.description) {
      descriptionInput.value = t.meta.description;
      needsDescription = false;
    }
    if (!needsYear && !needsGenre && !needsDescription) {
      break;
    }
  }

  // Auto-extract cover from ID3
  if (!coverFile) {
    for (const t of tracks) {
      if (t.meta?.picture) {
        setCover(t.meta.picture);
        break;
      }
    }
  }

  refreshTrackList();
  setIdle();

  // Auto-search for book metadata
  const searchQ = [inferredBook?.title, inferredBook?.author]
    .filter(Boolean)
    .join(" ");
  if (searchQ.length >= 3) {
    lookupQuery.value = searchQ;
    performLookup(searchQ);
  }
};

const moveTrack = (from, to) => {
  if (to < 0 || to >= tracks.length) return;
  const updated = [...tracks];
  const [item] = updated.splice(from, 1);
  updated.splice(to, 0, item);
  tracks = updated;
  refreshTrackList();
};

const removeTrack = (index) => {
  tracks.splice(index, 1);
  refreshTrackList();
};

// ---------------------------------------------------------------------------
// Compile to M4B
// ---------------------------------------------------------------------------
const compileM4B = async () => {
  await loadFFmpeg();

  const titleVal = titleInput.value.trim() || "Untitled Audiobook";
  const authorVal = authorInput.value.trim() || "Unknown";
  const yearVal = yearInput.value.trim();
  const genreVal = genreInput.value.trim();
  const descVal = descriptionInput.value.trim();

  updateStatus("Reading files...");
  showProgress(5);

  const filenames = [];
  for (let i = 0; i < tracks.length; i++) {
    const fname = `input_${String(i).padStart(3, "0")}.mp3`;
    filenames.push(fname);
    await ffmpeg.writeFile(fname, await fetchFile(tracks[i].file));
    showProgress(5 + ((i + 1) / tracks.length) * 10);
  }

  const listContent = filenames.map((f) => `file '${f}'`).join("\n");
  await ffmpeg.writeFile("inputs.txt", new TextEncoder().encode(listContent));

  let hasCover = false;
  if (coverFile) {
    await ffmpeg.writeFile("cover.jpg", await fetchFile(coverFile));
    hasCover = true;
  }

  // Build FFMETADATA1
  let meta = ";FFMETADATA1\n";
  meta += `title=${titleVal}\n`;
  meta += `artist=${authorVal}\n`;
  if (yearVal) meta += `date=${yearVal}\n`;
  if (genreVal) meta += `genre=${genreVal}\n`;
  if (descVal) meta += `comment=${descVal}\n`;

  let cursorMs = 0;
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const dur = track.meta?.duration || 0;
    const durationMs = Math.round(dur * 1000);
    if (durationMs > 0) {
      const chTitle =
        track.chapterName ||
        track.meta?.title ||
        track.file.name.replace(/\.mp3$/i, "");
      meta += "\n[CHAPTER]\nTIMEBASE=1/1000\n";
      meta += `START=${cursorMs}\n`;
      meta += `END=${cursorMs + durationMs}\n`;
      meta += `title=${chTitle}\n`;
      cursorMs += durationMs;
    }
  }
  await ffmpeg.writeFile("chapters.txt", new TextEncoder().encode(meta));

  updateStatus("Concatenating...");
  showProgress(18);
  await ffmpeg.exec([
    "-y", "-f", "concat", "-safe", "0",
    "-i", "inputs.txt", "-c", "copy", "combined.mp3",
  ]);

  updateStatus("Converting to M4B...");
  showProgress(25);

  const args = ["-y", "-i", "combined.mp3", "-i", "chapters.txt"];
  if (hasCover) {
    args.push("-i", "cover.jpg", "-map", "0:a", "-map", "2:v");
    args.push("-c:v", "mjpeg", "-disposition:v", "attached_pic");
  }
  args.push(
    "-map_metadata", "1", "-map_chapters", "1",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart", "-f", "mp4", "audiobook.m4b"
  );
  if (!hasCover) args.splice(args.indexOf("-f"), 0, "-vn");
  await ffmpeg.exec(args);

  updateStatus("Preparing download...");
  showProgress(95);
  const data = await ffmpeg.readFile("audiobook.m4b");

  // Cleanup
  for (const f of filenames) await ffmpeg.deleteFile(f).catch(() => {});
  await ffmpeg.deleteFile("inputs.txt").catch(() => {});
  await ffmpeg.deleteFile("chapters.txt").catch(() => {});
  await ffmpeg.deleteFile("combined.mp3").catch(() => {});
  await ffmpeg.deleteFile("audiobook.m4b").catch(() => {});
  if (hasCover) await ffmpeg.deleteFile("cover.jpg").catch(() => {});

  const slug =
    titleVal
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "audiobook";
  const blob = new Blob([data.buffer], { type: "audio/x-m4b" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${slug}.m4b`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  showProgress(100);
  setIdle("Complete!");
  setTimeout(hideProgress, 1500);
};

// ---------------------------------------------------------------------------
// Book lookup
// ---------------------------------------------------------------------------
const performLookup = async (query) => {
  if (!query || query.trim().length < 2) return;
  lookupResultsList.innerHTML =
    '<div class="lookup-spinner">Searching...</div>';
  lookupResults.hidden = false;

  const results = await searchBooks(query, 6);

  if (!results.length) {
    lookupResultsList.innerHTML =
      '<div class="lookup-spinner">No results found.</div>';
    return;
  }

  lookupResultsList.innerHTML = "";
  for (const result of results) {
    const card = document.createElement("div");
    card.className = "lookup-card";

    const imgContainer = document.createElement("div");
    if (result.coverUrl) {
      const img = document.createElement("img");
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      img.alt = result.title;
      img.loading = "lazy";
      img.addEventListener("error", () => {
        img.remove();
        const fb = document.createElement("div");
        fb.className = "no-cover";
        fb.textContent = "No cover";
        imgContainer.appendChild(fb);
      });
      img.src = result.coverUrl;
      imgContainer.appendChild(img);
    } else {
      const nc = document.createElement("div");
      nc.className = "no-cover";
      nc.textContent = "No cover";
      imgContainer.appendChild(nc);
    }
    card.appendChild(imgContainer);

    const titleEl = document.createElement("div");
    titleEl.className = "lookup-card-title";
    titleEl.textContent = result.title;
    card.appendChild(titleEl);

    if (result.author) {
      const authorEl = document.createElement("div");
      authorEl.className = "lookup-card-author";
      authorEl.textContent = result.author;
      card.appendChild(authorEl);
    }

    const sourceEl = document.createElement("div");
    sourceEl.className = "lookup-card-source";
    sourceEl.textContent =
      result.source === "google" ? "Google Books" : "Open Library";
    card.appendChild(sourceEl);

    card.addEventListener("click", () => applyLookupResult(result));
    lookupResultsList.appendChild(card);
  }
};

const applyLookupResult = async (result) => {
  if (result.title) titleInput.value = result.title;
  if (result.author) authorInput.value = result.author;
  if (result.year) yearInput.value = result.year;
  if (result.genre) genreInput.value = result.genre;
  if (result.description) descriptionInput.value = result.description;

  // Fetch cover
  if (result.coverUrl) {
    updateStatus("Fetching cover...");
    const blob = await fetchCoverBlob(result.coverUrl);
    if (blob && blob.size > 0) setCover(blob);
  }

  updateStatus("Fetching book details...");
  const { description, chapters } = await fetchBookDetails(result);
  if (description && !descriptionInput.value.trim()) {
    descriptionInput.value = description;
  }

  // Fetch and apply chapter names
  if (tracks.length && chapters?.length) {
    const count = Math.min(chapters.length, tracks.length);
    for (let i = 0; i < count; i++) {
      tracks[i].chapterName = chapters[i];
    }
    for (let i = count; i < tracks.length; i++) {
      tracks[i].chapterName = `Chapter ${i + 1}`;
    }
    refreshTrackList();
  }

  setIdle();
  lookupResults.hidden = true;
};

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

// Cover
coverPreview.addEventListener("click", () => coverInput.click());
coverUploadBtn.addEventListener("click", () => coverInput.click());
coverInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) {
    setCover(file);
    coverInput.value = "";
  }
});
coverRemoveBtn.addEventListener("click", removeCover);

// Lookup
lookupBtn.addEventListener("click", () => performLookup(lookupQuery.value));
lookupQuery.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    performLookup(lookupQuery.value);
  }
});
lookupDismiss.addEventListener("click", () => {
  lookupResults.hidden = true;
});

// Clear all
clearAllButton.addEventListener("click", () => {
  tracks = [];
  inferredBook = null;
  removeCover();
  titleInput.value = "Untitled Audiobook";
  authorInput.value = "Unknown";
  yearInput.value = "";
  genreInput.value = "Audiobook";
  descriptionInput.value = "";
  lookupQuery.value = "";
  lookupResults.hidden = true;
  refreshTrackList();
});

// Drop zone + file input
dropZone.addEventListener("click", (e) => {
  e.stopPropagation();
  fileInput.click();
});
addMoreBtn.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragover");
});
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

// Allow dropping files anywhere on the page
document.body.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (!dropZone.classList.contains("compact")) {
    dropZone.classList.add("dragover");
  }
});
document.body.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
    dropZone.classList.remove("dragover");
  }
});
document.body.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

fileInput.addEventListener("change", (e) => {
  if (e.target.files?.length) {
    addFiles(e.target.files);
    fileInput.value = "";
  }
});

// Compile
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!tracks.length) {
    updateStatus("Add MP3 files first", "error");
    return;
  }
  compileButton.disabled = true;
  try {
    await compileM4B();
  } catch (err) {
    console.error(err);
    updateStatus(err.message || "Conversion failed", "error");
    hideProgress();
  } finally {
    compileButton.disabled = !tracks.length;
    setTimeout(() => {
      if (!tracks.length) setIdle();
    }, 4000);
  }
});

// Init
refreshTrackList();
