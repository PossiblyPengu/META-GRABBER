import { FFmpeg } from "https://esm.sh/@ffmpeg/ffmpeg@0.12.10";
import { fetchFile, toBlobURL } from "https://esm.sh/@ffmpeg/util@0.12.1";
import { inferBook, extractSortKey } from "./book-parser.js";
import { searchBooks, fetchCoverBlob, fetchBookDetails } from "./book-lookup.js";
import { extractMetadata } from "./metadata.js";
import { isSignedIn, signOut, onAuthChange, ensureAuth, listFolder, downloadFiles, uploadToDrive } from "./gdrive.js";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const form = $("compile-form");
const dropZone = $("drop-zone");
const fileInput = $("file-input");
const coverInput = $("cover-input");
const trackList = $("track-list");
const chapterCount = $("chapter-count");
const addMoreBtn = $("add-more-btn");
const clearAllButton = $("clear-all");
const compileButton = $("compile-button");
const statusDot = $("status-dot");
const statusText = $("status-text");
const progressTrack = $("progress-track");
const progressFill = $("progress-fill");
const progressDialog = $("progress-dialog");
const progressList = $("progress-list");
const progressDismiss = $("progress-dismiss");
const coverPreview = $("cover-preview");
const coverUploadBtn = $("cover-upload-btn");
const coverRemoveBtn = $("cover-remove-btn");
const lookupQuery = $("lookup-query");
const lookupBtn = $("lookup-btn");
const matchResultsGrid = $("match-results-grid");
const coverResultsStrip = $("cover-results-strip");
const uploadStatus = $("upload-status");
const uploadStatusText = $("upload-status-text");

// Google Drive
const gdriveImportBtn = $("gdrive-import-btn");
const gdriveExportBtn = $("gdrive-export-btn");
const gdriveConnectBtn = $("gdrive-connect-btn");
const gdriveConnectLabel = $("gdrive-connect-label");

// Custom Drive picker
const gdrivePickerModal = $("gdrive-picker-modal");
const gdrivePickerClose = $("gdrive-picker-close");
const gdrivePickerCancel = $("gdrive-picker-cancel");
const gdrivePickerSelect = $("gdrive-picker-select");
const gdriveFileList = $("gdrive-file-list");
const gdriveBreadcrumb = $("gdrive-breadcrumb");
const gdriveSelectedCount = $("gdrive-selected-count");


// Wizard panels & nav
const panels = {
  upload: $("panel-upload"),
  match: $("panel-match"),
  edit: $("panel-edit"),
  forge: $("panel-forge"),
};
const wizardNav = $("wizard-nav");
const stepOrder = ["upload", "match", "edit", "forge"];

// Form fields
const titleInput = form.elements.namedItem("title");
const authorInput = form.elements.namedItem("author");
const yearInput = form.elements.namedItem("year");
const genreInput = form.elements.namedItem("genre");
const narratorInput = form.elements.namedItem("narrator");
const descriptionInput = form.elements.namedItem("description");

// Forge review elements
const forgeTitle = $("forge-title");
const forgeAuthor = $("forge-author");
const forgePills = $("forge-meta-pills");
const forgeDesc = $("forge-description");
const forgeStats = $("forge-stats");
const forgeCover = $("forge-cover");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentStep = "upload";
let tracks = [];
let ffmpeg = null;
let ffmpegReady = false;
let ffmpegLoadingPromise = null;
let inferredBook = null;
let coverFile = null;
let coverObjectURL = null;
let lookupDebounceTimer = null;
let lastCompiledBlob = null;
let lastCompiledFilename = null;

// ---------------------------------------------------------------------------
// Wizard navigation
// ---------------------------------------------------------------------------
const goToStep = (step) => {
  const nextIdx = stepOrder.indexOf(step);
  if (nextIdx < 0) return;

  // Hide current panel, show new one
  panels[currentStep]?.classList.remove("active");
  panels[step]?.classList.add("active");
  currentStep = step;

  // Update nav buttons
  const buttons = wizardNav.querySelectorAll(".wizard-step");
  const connectors = wizardNav.querySelectorAll(".wizard-connector");
  buttons.forEach((btn, i) => {
    btn.classList.remove("active", "completed", "disabled");
    if (i === nextIdx) {
      btn.classList.add("active");
    } else if (i < nextIdx) {
      btn.classList.add("completed");
    } else if (i > nextIdx + 1) {
      btn.classList.add("disabled");
    }
  });
  connectors.forEach((c, i) => {
    c.classList.toggle("done", i < nextIdx);
  });

  // If entering forge step, populate review
  if (step === "forge") populateForgeReview();
};

// Allow clicking completed/adjacent steps
wizardNav.addEventListener("click", (e) => {
  const btn = e.target.closest(".wizard-step");
  if (!btn || btn.classList.contains("disabled")) return;
  const step = stepOrder[parseInt(btn.dataset.step, 10) - 1];
  if (step) goToStep(step);
});

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------
const updateStatus = (label, state = "busy") => {
  statusText.textContent = label;
  statusDot.className = "status-dot" + (state === "idle" ? "" : state === "error" ? " error" : " busy");
  if (state === "busy") {
    showProgressDialog();
    appendProgressStep(label, "active");
  }
  if (state === "error") {
    appendProgressStep(label, "error");
  }
};

const setIdle = (label = "Ready") => {
  statusText.textContent = label;
  statusDot.className = "status-dot";
  hideProgressDialogDelayed();
};

const showProgress = (pct) => {
  progressTrack.hidden = false;
  progressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
};

const hideProgress = () => {
  progressTrack.hidden = true;
  progressFill.style.width = "0%";
};

let progressHideTimer = null;
const showProgressDialog = () => {
  if (progressHideTimer) { clearTimeout(progressHideTimer); progressHideTimer = null; }
  progressDialog.hidden = false;
};

const hideProgressDialogDelayed = () => {
  if (!progressDialog.hidden) {
    progressHideTimer = setTimeout(() => {
      progressDialog.hidden = true;
      progressList.textContent = "";
    }, 1200);
  }
};

const appendProgressStep = (label, state = "pending") => {
  const item = document.createElement("li");
  item.className = "progress-item";
  item.dataset.state = state;
  const title = document.createElement("div");
  title.className = "progress-item-label";
  title.textContent = label;
  item.appendChild(title);
  progressList.appendChild(item);
  return item;
};

progressDismiss?.addEventListener("click", () => {
  progressDialog.hidden = true;
  progressList.textContent = "";
});

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
    const el = coverPreview.querySelector(".cover-placeholder");
    if (el) el.textContent = "";
    const img = document.createElement("img");
    img.src = coverObjectURL;
    img.alt = "Cover art";
    if (el) el.replaceWith(img); else coverPreview.appendChild(img);
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
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "32"); svg.setAttribute("height", "32");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("opacity", ".4"); svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>';
    const label = document.createElement("span");
    label.textContent = "Click to add cover";
    ph.append(svg, label);
    existing.replaceWith(ph);
  }
  coverRemoveBtn.hidden = true;
};

// ---------------------------------------------------------------------------
// FFmpeg.wasm setup
// ---------------------------------------------------------------------------
const loadFFmpeg = async () => {
  if (ffmpegReady) return;
  if (ffmpegLoadingPromise) { await ffmpegLoadingPromise; return; }

  ffmpegLoadingPromise = (async () => {
    updateStatus("Loading FFmpeg...");
    showProgress(10);
    ffmpeg = new FFmpeg();
    ffmpeg.on("progress", ({ progress }) => showProgress(20 + progress * 70));
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";
    try {
      const [coreURL, wasmURL, workerURL] = await Promise.all([
        toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
        toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, "text/javascript"),
      ]);
      await ffmpeg.load({ coreURL, wasmURL, workerURL });
      ffmpegReady = true;
      hideProgress();
      setIdle("FFmpeg ready");
    } catch (err) {
      console.error("FFmpeg failed to load", err);
      hideProgress();
      updateStatus("FFmpeg failed to load", "error");
      throw err;
    } finally {
      ffmpegLoadingPromise = null;
    }
  })();
  return ffmpegLoadingPromise;
};

// ---------------------------------------------------------------------------
// Track list UI (step 3)
// ---------------------------------------------------------------------------
const refreshTrackList = () => {
  trackList.textContent = "";

  if (!tracks.length) {
    const empty = document.createElement("div");
    empty.className = "track-list-empty";
    empty.textContent = "No chapters added yet.";
    trackList.appendChild(empty);
    chapterCount.textContent = "";
    return;
  }

  const totalDuration = tracks.reduce((s, t) => s + (t.meta?.duration || 0), 0);
  const totalSize = tracks.reduce((s, t) => s + t.file.size, 0);
  chapterCount.textContent = `${tracks.length} chapters \u00b7 ${formatDuration(totalDuration)} \u00b7 ${(totalSize / (1024 * 1024)).toFixed(1)} MB`;

  const fragment = document.createDocumentFragment();
  tracks.forEach((track, index) => {
    const row = document.createElement("div");
    row.className = "track-row";

    const num = document.createElement("span");
    num.className = "track-num";
    num.textContent = String(index + 1).padStart(2, "0");

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

    const actions = document.createElement("div");
    actions.className = "track-actions";
    const mkBtn = (label, cls, handler) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `btn btn-icon${cls ? " " + cls : ""}`;
      b.textContent = label;
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
    fragment.append(row);
  });
  trackList.append(fragment);
};

// ---------------------------------------------------------------------------
// Track management
// ---------------------------------------------------------------------------
const parseTrackNum = (track) => {
  if (track == null) return null;
  const str = String(track).split("/")[0].trim();
  const n = parseInt(str, 10);
  return Number.isFinite(n) ? n : null;
};

const sortTracks = () => {
  const hasID3TrackNums = tracks.some((t) => parseTrackNum(t.meta?.track) != null);
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
    return a.file.name.localeCompare(b.file.name, undefined, { numeric: true });
  });
};

const addFiles = async (fileList) => {
  const mp3Files = Array.from(fileList).filter(
    (file) => file.type === "audio/mpeg" || file.name.toLowerCase().endsWith(".mp3")
  );
  if (!mp3Files.length) return;

  // Show loading state on upload panel
  dropZone.hidden = true;
  uploadStatus.hidden = false;
  uploadStatusText.textContent = `Reading ${mp3Files.length} file${mp3Files.length > 1 ? "s" : ""}...`;

  const newTracks = mp3Files.map((file) => ({ file, meta: null, chapterName: null }));
  tracks = [...tracks, ...newTracks];

  // Initial sort by filename
  tracks.sort((a, b) => {
    const keyA = extractSortKey(a.file.name);
    const keyB = extractSortKey(b.file.name);
    if (keyA !== keyB) return keyA - keyB;
    return a.file.name.localeCompare(b.file.name, undefined, { numeric: true });
  });

  // Extract metadata
  uploadStatusText.textContent = "Reading ID3 metadata...";
  await Promise.all(newTracks.map(async (t) => { t.meta = await extractMetadata(t.file); }));

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

  // Auto-populate metadata fields (only if defaults)
  if (inferredBook.title && titleInput.value === "Untitled Audiobook") titleInput.value = inferredBook.title;
  if (inferredBook.author && authorInput.value === "Unknown") authorInput.value = inferredBook.author;
  if (inferredBook.description && !descriptionInput.value.trim()) descriptionInput.value = inferredBook.description;

  let needsYear = !yearInput.value;
  let needsGenre = genreInput.value === "Audiobook";
  let needsDescription = !descriptionInput.value.trim();
  for (const t of tracks) {
    if (!t.meta) continue;
    if (needsYear && t.meta.year) { yearInput.value = t.meta.year; needsYear = false; }
    if (needsGenre && t.meta.genre) { genreInput.value = t.meta.genre; needsGenre = false; }
    if (needsDescription && t.meta.description) { descriptionInput.value = t.meta.description; needsDescription = false; }
    if (!needsYear && !needsGenre && !needsDescription) break;
  }

  // Auto-extract cover from ID3
  if (!coverFile) {
    for (const t of tracks) {
      if (t.meta?.picture) { setCover(t.meta.picture); break; }
    }
  }

  refreshTrackList();

  // Auto-advance to Match step and trigger search
  goToStep("match");
  const searchQ = [inferredBook?.title, inferredBook?.author].filter(Boolean).join(" ");
  if (searchQ.length >= 3) {
    lookupQuery.value = searchQ;
    performLookup(searchQ);
  } else {
    matchResultsGrid.textContent = "";
    coverResultsStrip.textContent = "";
    const empty = document.createElement("div");
    empty.className = "match-empty";
    empty.textContent = "Could not auto-detect book info. Try searching manually above.";
    matchResultsGrid.appendChild(empty);
  }

  // Reset upload panel for potential re-use
  dropZone.hidden = false;
  uploadStatus.hidden = true;
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
// Book lookup (step 2)
// ---------------------------------------------------------------------------
let lastLookupResults = [];

const performLookup = async (query) => {
  if (!query || query.trim().length < 2) return;

  matchResultsGrid.textContent = "";
  coverResultsStrip.textContent = "";
  const spinner = document.createElement("div");
  spinner.className = "match-spinner";
  spinner.textContent = "Searching Google Books & Open Library...";
  matchResultsGrid.appendChild(spinner);

  const results = await searchBooks(query, 6);
  lastLookupResults = results;

  if (!results.length) {
    spinner.textContent = "No results found. Try a different search.";
    return;
  }

  // --- Metadata cards ---
  matchResultsGrid.textContent = "";
  for (const result of results) {
    const card = document.createElement("div");
    card.className = "match-card";

    const titleEl = document.createElement("div");
    titleEl.className = "match-card-title";
    titleEl.textContent = result.title;
    card.appendChild(titleEl);

    if (result.author) {
      const authorEl = document.createElement("div");
      authorEl.className = "match-card-author";
      authorEl.textContent = result.author;
      card.appendChild(authorEl);
    }

    if (result.year) {
      const yearEl = document.createElement("span");
      yearEl.className = "match-card-year";
      yearEl.textContent = result.year;
      card.appendChild(yearEl);
    }

    if (result.description) {
      const descEl = document.createElement("div");
      descEl.className = "match-card-desc";
      descEl.textContent = result.description;
      card.appendChild(descEl);
    }

    const sourceEl = document.createElement("div");
    sourceEl.className = "match-card-source";
    sourceEl.textContent = result.source === "google" ? "Google Books" : "Open Library";
    card.appendChild(sourceEl);

    card.addEventListener("click", () => {
      // Highlight selected metadata card
      matchResultsGrid.querySelectorAll(".match-card").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      applyMetadata(result);
    });
    matchResultsGrid.appendChild(card);
  }

  // --- Cover thumbnails ---
  coverResultsStrip.textContent = "";
  const coverResults = results.filter((r) => r.coverUrl);
  if (!coverResults.length) {
    const empty = document.createElement("div");
    empty.className = "cover-strip-empty";
    empty.textContent = "No covers available from search results. You can upload one in the Edit step.";
    coverResultsStrip.appendChild(empty);
    return;
  }

  for (const result of coverResults) {
    const thumb = document.createElement("div");
    thumb.className = "cover-thumb";

    const img = document.createElement("img");
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.alt = result.title;
    img.loading = "lazy";
    img.addEventListener("error", () => { thumb.remove(); });
    img.src = result.coverUrl;
    thumb.appendChild(img);

    const label = document.createElement("div");
    label.className = "cover-thumb-label";
    label.textContent = result.source === "google" ? "Google" : "Open Library";
    thumb.appendChild(label);

    thumb.addEventListener("click", () => {
      coverResultsStrip.querySelectorAll(".cover-thumb").forEach((c) => c.classList.remove("selected"));
      thumb.classList.add("selected");
      applyCover(result);
    });
    coverResultsStrip.appendChild(thumb);
  }
};

const applyMetadata = async (result) => {
  // Fill metadata immediately from search result
  if (result.title) titleInput.value = result.title;
  if (result.author) authorInput.value = result.author;
  if (result.year) yearInput.value = result.year;
  if (result.genre) genreInput.value = result.genre;
  if (result.description) descriptionInput.value = result.description;

  updateStatus("Fetching book details...");

  // Fetch deeper details in background
  const { description, chapters, narrator } = await fetchBookDetails(result);
  if (description && !descriptionInput.value.trim()) descriptionInput.value = description;
  if (narrator && !narratorInput.value.trim()) narratorInput.value = narrator;

  // Apply chapter names from API
  if (tracks.length && chapters?.length) {
    const count = Math.min(chapters.length, tracks.length);
    for (let i = 0; i < count; i++) tracks[i].chapterName = chapters[i];
    for (let i = count; i < tracks.length; i++) tracks[i].chapterName = `Chapter ${i + 1}`;
    refreshTrackList();
  }

  setIdle("Metadata loaded");
};

const applyCover = async (result) => {
  if (!result.coverUrl) return;
  updateStatus("Fetching cover...");
  const blob = await fetchCoverBlob(result.coverUrl);
  if (blob && blob.size > 0) setCover(blob);
  setIdle("Cover loaded");
};

// ---------------------------------------------------------------------------
// Forge review (step 4)
// ---------------------------------------------------------------------------
const populateForgeReview = () => {
  forgeTitle.textContent = titleInput.value || "Untitled Audiobook";
  forgeAuthor.textContent = authorInput.value || "Unknown";

  // Pills
  forgePills.textContent = "";
  const pills = [];
  if (yearInput.value) pills.push(yearInput.value);
  if (genreInput.value) pills.push(genreInput.value);
  if (narratorInput.value) pills.push(`Narrated by ${narratorInput.value}`);
  for (const text of pills) {
    const pill = document.createElement("span");
    pill.className = "forge-pill";
    pill.textContent = text;
    forgePills.appendChild(pill);
  }

  // Description
  forgeDesc.textContent = descriptionInput.value || "";
  forgeDesc.hidden = !descriptionInput.value;

  // Stats
  forgeStats.textContent = "";
  const totalDuration = tracks.reduce((s, t) => s + (t.meta?.duration || 0), 0);
  const totalSize = tracks.reduce((s, t) => s + t.file.size, 0);
  const stats = [
    { value: String(tracks.length), label: "Chapters" },
    { value: formatDuration(totalDuration), label: "Duration" },
    { value: `${(totalSize / (1024 * 1024)).toFixed(1)} MB`, label: "Source Size" },
  ];
  for (const s of stats) {
    const el = document.createElement("div");
    el.className = "forge-stat";
    const v = document.createElement("span"); v.className = "forge-stat-value"; v.textContent = s.value;
    const l = document.createElement("span"); l.className = "forge-stat-label"; l.textContent = s.label;
    el.append(v, l);
    forgeStats.appendChild(el);
  }

  // Cover in review
  forgeCover.textContent = "";
  if (coverObjectURL) {
    const img = document.createElement("img");
    img.src = coverObjectURL;
    img.alt = "Cover art";
    forgeCover.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "cover-placeholder";
    ph.textContent = "No cover";
    forgeCover.appendChild(ph);
  }

  compileButton.disabled = !tracks.length;
};

// ---------------------------------------------------------------------------
// Compile to M4B
// ---------------------------------------------------------------------------
const compileM4B = async () => {
  await loadFFmpeg();

  // eslint-disable-next-line no-control-regex
  const sanitizeMeta = (s) => s.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  const titleVal = sanitizeMeta(titleInput.value) || "Untitled Audiobook";
  const authorVal = sanitizeMeta(authorInput.value) || "Unknown";
  const yearVal = sanitizeMeta(yearInput.value);
  const genreVal = sanitizeMeta(genreInput.value);
  const descVal = sanitizeMeta(descriptionInput.value);

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
      const chTitle = sanitizeMeta(
        track.chapterName || track.meta?.title || track.file.name.replace(/\.mp3$/i, "")
      );
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
  await ffmpeg.exec(["-y", "-f", "concat", "-safe", "0", "-i", "inputs.txt", "-c", "copy", "combined.mp3"]);

  updateStatus("Converting to M4B...");
  showProgress(25);

  const args = ["-y", "-i", "combined.mp3", "-i", "chapters.txt"];
  if (hasCover) {
    args.push("-i", "cover.jpg", "-map", "0:a", "-map", "2:v");
    args.push("-c:v", "mjpeg", "-disposition:v", "attached_pic");
  }
  args.push("-map_metadata", "1", "-map_chapters", "1", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-f", "mp4", "audiobook.m4b");
  if (!hasCover) args.splice(args.indexOf("-f"), 0, "-vn");
  await ffmpeg.exec(args);

  updateStatus("Preparing download...");
  showProgress(95);
  const data = await ffmpeg.readFile("audiobook.m4b");

  // Cleanup
  const cleanup = [...filenames, "inputs.txt", "chapters.txt", "combined.mp3", "audiobook.m4b"];
  if (hasCover) cleanup.push("cover.jpg");
  for (const f of cleanup) {
    await ffmpeg.deleteFile(f).catch((err) => console.warn(`cleanup: failed to delete ${f}`, err));
  }

  const slug = titleVal.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "audiobook";
  const blob = new Blob([data.buffer], { type: "audio/x-m4b" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${slug}.m4b`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  // Retain for Google Drive export
  lastCompiledBlob = blob;
  lastCompiledFilename = `${slug}.m4b`;
  gdriveExportBtn.hidden = false;

  showProgress(100);
  setIdle("Complete!");
  setTimeout(hideProgress, 1500);
};

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

// Cover
coverPreview.addEventListener("click", () => coverInput.click());
coverUploadBtn.addEventListener("click", () => coverInput.click());
coverInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) { setCover(file); coverInput.value = ""; }
});
coverRemoveBtn.addEventListener("click", removeCover);

// Lookup (with debounce)
const debouncedLookup = () => {
  clearTimeout(lookupDebounceTimer);
  lookupDebounceTimer = setTimeout(() => performLookup(lookupQuery.value), 400);
};
lookupBtn.addEventListener("click", () => performLookup(lookupQuery.value));
lookupQuery.addEventListener("input", debouncedLookup);
lookupQuery.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(lookupDebounceTimer);
    performLookup(lookupQuery.value);
  }
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
  narratorInput.value = "";
  descriptionInput.value = "";
  lookupQuery.value = "";
  refreshTrackList();
  goToStep("upload");
});

// Drop zone + file input
dropZone.addEventListener("click", (e) => { e.stopPropagation(); fileInput.click(); });
addMoreBtn.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave", () => { dropZone.classList.remove("dragover"); });
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

// Allow dropping files anywhere on the page
document.body.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (currentStep === "upload") dropZone.classList.add("dragover");
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
  if (e.target.files?.length) { addFiles(e.target.files); fileInput.value = ""; }
});

// Wizard navigation buttons
$("match-back-btn").addEventListener("click", () => goToStep("upload"));
$("match-skip-btn").addEventListener("click", () => goToStep("edit"));
$("match-next-btn").addEventListener("click", () => goToStep("edit"));
$("edit-back-btn").addEventListener("click", () => goToStep("match"));
$("edit-next-btn").addEventListener("click", () => goToStep("forge"));
$("forge-back-btn").addEventListener("click", () => goToStep("edit"));

// Compile
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!tracks.length) { updateStatus("Add MP3 files first", "error"); return; }
  compileButton.disabled = true;
  try {
    await compileM4B();
  } catch (err) {
    console.error(err);
    updateStatus(err.message || "Conversion failed", "error");
    hideProgress();
  } finally {
    compileButton.disabled = !tracks.length;
    setTimeout(() => { if (!tracks.length) setIdle(); }, 4000);
  }
});

// ---------------------------------------------------------------------------
// Google Drive — connection state
// ---------------------------------------------------------------------------
const updateDriveUI = () => {
  const signedIn = isSignedIn();
  gdriveConnectBtn.classList.toggle("connected", signedIn);
  gdriveConnectLabel.textContent = signedIn ? "Drive Connected" : "Connect Drive";
};

onAuthChange(updateDriveUI);

// Toolbar connect/disconnect button
gdriveConnectBtn.addEventListener("click", async () => {
  if (isSignedIn()) {
    signOut();
    updateDriveUI();
    return;
  }
  try {
    await ensureAuth();
    updateDriveUI();
  } catch (err) {
    console.error("Google Drive sign-in failed:", err);
    updateStatus(err.message || "Sign-in failed", "error");
    setTimeout(setIdle, 3000);
  }
});

// ---------------------------------------------------------------------------
// Custom Google Drive file picker
// ---------------------------------------------------------------------------
const pickerSelected = new Map(); // id → {id, name}
let pickerResolve = null;
let pickerBreadcrumbs = [{ id: "root", name: "My Drive" }];

const openDrivePicker = () => new Promise((resolve) => {
  pickerSelected.clear();
  pickerBreadcrumbs = [{ id: "root", name: "My Drive" }];
  pickerResolve = resolve;
  gdrivePickerModal.hidden = false;
  refreshPickerCount();
  navigateToFolder("root");
});

const closeDrivePicker = (result) => {
  gdrivePickerModal.hidden = true;
  if (pickerResolve) {
    pickerResolve(result || []);
    pickerResolve = null;
  }
};

const refreshPickerCount = () => {
  const n = pickerSelected.size;
  gdriveSelectedCount.textContent = `${n} file${n !== 1 ? "s" : ""} selected`;
  gdrivePickerSelect.disabled = n === 0;
};

const renderBreadcrumbs = () => {
  gdriveBreadcrumb.textContent = "";
  pickerBreadcrumbs.forEach((crumb, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "gdrive-crumb-sep";
      sep.textContent = "/";
      gdriveBreadcrumb.appendChild(sep);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-ghost btn-xs gdrive-crumb";
    btn.textContent = crumb.name;
    btn.addEventListener("click", () => {
      pickerBreadcrumbs = pickerBreadcrumbs.slice(0, i + 1);
      navigateToFolder(crumb.id);
    });
    gdriveBreadcrumb.appendChild(btn);
  });
};

const navigateToFolder = async (folderId) => {
  gdriveFileList.innerHTML = '<div class="gdrive-picker-empty">Loading...</div>';
  renderBreadcrumbs();

  try {
    const files = await listFolder(folderId);
    gdriveFileList.textContent = "";

    if (!files.length) {
      gdriveFileList.innerHTML = '<div class="gdrive-picker-empty">No MP3 files or folders here</div>';
      return;
    }

    for (const file of files) {
      const isFolder = file.mimeType === "application/vnd.google-apps.folder";
      const row = document.createElement("div");
      row.className = "gdrive-file-row";

      if (isFolder) {
        row.innerHTML = `
          <span class="gdrive-file-icon gdrive-folder-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          </span>
          <span class="gdrive-file-name">${file.name}</span>
        `;
        row.addEventListener("click", () => {
          pickerBreadcrumbs.push({ id: file.id, name: file.name });
          navigateToFolder(file.id);
        });
      } else {
        const checked = pickerSelected.has(file.id);
        const size = file.size ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : "";
        row.innerHTML = `
          <label class="gdrive-file-check">
            <input type="checkbox" ${checked ? "checked" : ""} />
          </label>
          <span class="gdrive-file-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          </span>
          <span class="gdrive-file-name">${file.name}</span>
          <span class="gdrive-file-size">${size}</span>
        `;
        const checkbox = row.querySelector("input");
        const toggleSelect = () => {
          if (pickerSelected.has(file.id)) {
            pickerSelected.delete(file.id);
            checkbox.checked = false;
          } else {
            pickerSelected.set(file.id, { id: file.id, name: file.name });
            checkbox.checked = true;
          }
          refreshPickerCount();
        };
        checkbox.addEventListener("change", toggleSelect);
        row.addEventListener("click", (e) => {
          if (e.target !== checkbox) toggleSelect();
        });
      }

      gdriveFileList.appendChild(row);
    }
  } catch (err) {
    gdriveFileList.innerHTML = `<div class="gdrive-picker-empty">Error: ${err.message}</div>`;
  }
};

gdrivePickerClose.addEventListener("click", () => closeDrivePicker([]));
gdrivePickerCancel.addEventListener("click", () => closeDrivePicker([]));
gdrivePickerModal.addEventListener("click", (e) => { if (e.target === gdrivePickerModal) closeDrivePicker([]); });
gdrivePickerSelect.addEventListener("click", () => closeDrivePicker([...pickerSelected.values()]));

// ---------------------------------------------------------------------------
// Google Drive import
// ---------------------------------------------------------------------------
gdriveImportBtn.addEventListener("click", async () => {
  try {
    updateStatus("Connecting to Google Drive...");
    await ensureAuth();
    updateDriveUI();
    setIdle();

    const selected = await openDrivePicker();
    if (!selected.length) return;

    updateStatus(`Downloading ${selected.length} file${selected.length > 1 ? "s" : ""}...`);
    const files = await downloadFiles(selected);
    if (files.length) await addFiles(files);
    else setIdle();
  } catch (err) {
    console.error("Google Drive import failed:", err);
    updateStatus(err.message || "Google Drive import failed", "error");
    setTimeout(setIdle, 3000);
  }
});

// ---------------------------------------------------------------------------
// Google Drive export
// ---------------------------------------------------------------------------
gdriveExportBtn.addEventListener("click", async () => {
  if (!lastCompiledBlob || !lastCompiledFilename) return;
  try {
    updateStatus("Uploading to Google Drive...");
    showProgress(50);
    const result = await uploadToDrive(lastCompiledBlob, lastCompiledFilename);
    updateDriveUI();
    showProgress(100);
    setIdle("Saved to Google Drive!");
    if (result.webViewLink) {
      window.open(result.webViewLink, "_blank", "noopener");
    }
    setTimeout(hideProgress, 1500);
  } catch (err) {
    console.error("Google Drive export failed:", err);
    hideProgress();
    updateStatus(err.message || "Google Drive upload failed", "error");
    setTimeout(setIdle, 3000);
  }
});

// Init
updateDriveUI();
goToStep("upload");
