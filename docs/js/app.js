import { inferBook, extractSortKey, detectSeries } from "./book-parser.js";
import { searchBooks, fetchCoverBlob, fetchBookDetails } from "./book-lookup.js";
import { extractMetadata } from "./metadata.js";
import { isSupportedBookFile, extractMetadataFromBookFile } from "./book-file-import.js";
import { saveSession, loadSession, clearSession } from "./session.js";
import { compileM4B } from "./compiler.js";
import { pushState, undo, redo, clearHistory } from "./history.js";
import { importFromDrive, exportToDrive, gdriveDownloading, isPickerHidden, setPickerVisible } from "./drive-ui.js";
import { handleRedirectReturn, hasPendingRedirect, clearPendingRedirect } from "./gdrive.js";
import { toastSuccess, toastError, toastInfo, toastWarning } from "./toast.js";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const form = $("compile-form");
const DEFAULT_TITLE = "Untitled Audiobook";
const DEFAULT_AUTHOR = "Unknown";
const dropZone = $("drop-zone");
const fileInput = $("file-input");
const coverInput = $("cover-input");
const trackList = $("track-list");
const chapterCount = $("chapter-count");
const addMoreBtn = $("add-more-btn");
const clearAllButton = $("clear-all");
const restartBtn = $("restart-btn");
const fetchChaptersBtn = $("fetch-chapters-btn");
const compileButton = $("compile-button");
const statusDot = $("status-dot");
const statusText = $("status-text");
const progressTrack = $("progress-track");
const progressFill = $("progress-fill");
const progressDialog = $("progress-dialog");
const progressList = $("progress-list");
const progressDismiss = $("progress-dismiss");
const progressDialogBar = $("progress-dialog-bar");
const progressDialogBarFill = $("progress-dialog-bar-fill");
const coverPreview = $("cover-preview");
const coverUploadBtn = $("cover-upload-btn");
const coverRemoveBtn = $("cover-remove-btn");
const lookupQuery = $("lookup-query");
const lookupBtn = $("lookup-btn");
const matchResultsGrid = $("match-results-grid");
const coverResultsStrip = $("cover-results-strip");
const uploadStatus = $("upload-status");
const uploadStatusText = $("upload-status-text");
const uploadFileSummary = $("upload-file-summary");
const uploadFileCount = $("upload-file-count");
const uploadFileList = $("upload-file-list");
const uploadAddMoreBtn = $("upload-add-more-btn");
const uploadClearBtn = $("upload-clear-btn");
const uploadNextBtn = $("upload-next-btn");

// Chapter search
const chapterSearchBar = $("chapter-search-bar");
const chapterSearchInput = $("chapter-search");
const chapterSearchClear = $("chapter-search-clear");
const chapterSearchCount = $("chapter-search-count");

// Google Drive buttons (picker UI is in drive-ui.js)
const gdriveImportBtn = $("gdrive-import-btn");
const gdriveExportBtn = $("gdrive-export-btn");

// Wizard panels & nav
const panels = {
  upload: $("panel-upload"),
  match: $("panel-match"),
  edit: $("panel-edit"),
  forge: $("panel-forge"),
};
const wizardNav = $("wizard-nav");
const bottomNav = $("bottom-nav");
const stepOrder = ["upload", "match", "edit", "forge"];

// Form fields
const titleInput = form.elements.namedItem("title");
const authorInput = form.elements.namedItem("author");
const yearInput = form.elements.namedItem("year");
const genreInput = form.elements.namedItem("genre");
const narratorInput = form.elements.namedItem("narrator");
const seriesInput = form.elements.namedItem("series");
const booknumInput = form.elements.namedItem("booknum");
const descriptionInput = form.elements.namedItem("description");

// Forge review elements
const forgeTitle = $("forge-title");
const forgeAuthor = $("forge-author");
const forgePills = $("forge-meta-pills");
const forgeDesc = $("forge-description");
const forgeStats = $("forge-stats");
const forgeCover = $("forge-cover");
const downloadAgainBtn = $("download-again-btn");
const matchNextBtn = $("match-next-btn");

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------
const themeToggle = $("theme-toggle");
const themeIconDark = $("theme-icon-dark");
const themeIconLight = $("theme-icon-light");

const applyTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  themeIconDark.hidden = theme === "dark";
  themeIconLight.hidden = theme === "light";
};

// Init theme from localStorage or system preference
const savedTheme = localStorage.getItem("bf-theme");
if (savedTheme) {
  applyTheme(savedTheme);
} else if (window.matchMedia("(prefers-color-scheme: light)").matches) {
  applyTheme("light");
}

themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applyTheme(next);
  localStorage.setItem("bf-theme", next);
});

// ---------------------------------------------------------------------------
// Performance helpers
// ---------------------------------------------------------------------------
const TRACK_RENDER_BATCH_SIZE = 20;
const AUTO_LOOKUP_IDLE_DELAY = 1600;

const supportsIdleCallback = typeof window.requestIdleCallback === "function";
const supportsIdleCancel = typeof window.cancelIdleCallback === "function";

const scheduleIdle = (fn, timeout = 500) => {
  if (supportsIdleCallback) {
    const id = window.requestIdleCallback(fn, { timeout });
    return { type: "idle", id };
  }
  const id = window.setTimeout(fn, timeout);
  return { type: "timeout", id };
};

const cancelScheduled = (handle) => {
  if (!handle) return;
  if (handle.type === "idle" && supportsIdleCancel) {
    window.cancelIdleCallback(handle.id);
  } else if (handle.type === "timeout") {
    clearTimeout(handle.id);
  }
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentStep = "upload";
let tracks = [];
let inferredBook = null;
let coverFile = null;
let coverObjectURL = null;
let lookupDebounceTimer = null;
let lastCompiledBlob = null;
let lastCompiledFilename = null;
let onSessionChange = null;
let autoLookupHandle = null;
let rowRenderHandle = null;
let undoScheduleHandle = null;
let sessionSaveHandle = null;
let savedTrackKeys = new Set();
let chapterFilter = "";

const scheduleAutoLookup = (query) => {
  cancelScheduled(autoLookupHandle);
  if (!query) return;
  autoLookupHandle = scheduleIdle(() => {
    autoLookupHandle = null;
    performLookup(query);
  }, AUTO_LOOKUP_IDLE_DELAY);
};

const cancelAutoLookup = () => {
  if (!autoLookupHandle) return;
  cancelScheduled(autoLookupHandle);
  autoLookupHandle = null;
};

// ---------------------------------------------------------------------------
// Upload file summary (shown when returning to upload step with files)
// ---------------------------------------------------------------------------
const refreshUploadSummary = () => {
  const altActions = document.querySelector(".upload-alt-actions");
  if (!tracks.length) {
    uploadFileSummary.hidden = true;
    dropZone.hidden = false;
    if (altActions) altActions.hidden = false;
    return;
  }
  dropZone.hidden = true;
  if (altActions) altActions.hidden = true;
  uploadFileSummary.hidden = false;

  const totalSize = tracks.reduce((s, t) => s + t.file.size, 0);
  const totalDur = tracks.reduce((s, t) => s + (t.meta?.duration || 0), 0);
  uploadFileCount.textContent = `${tracks.length} file${tracks.length !== 1 ? "s" : ""} \u00b7 ${formatDuration(totalDur)} \u00b7 ${(totalSize / (1024 * 1024)).toFixed(1)} MB`;

  uploadFileList.textContent = "";
  for (const track of tracks) {
    const li = document.createElement("li");
    li.className = "upload-file-item";
    const name = document.createElement("span");
    name.className = "upload-file-name";
    name.textContent = track.file.name;
    const detail = document.createElement("span");
    detail.className = "upload-file-detail";
    const parts = [];
    if (track.meta?.duration) parts.push(formatDuration(track.meta.duration));
    parts.push(`${(track.file.size / (1024 * 1024)).toFixed(1)} MB`);
    detail.textContent = parts.join(" \u00b7 ");
    li.append(name, detail);
    uploadFileList.appendChild(li);
  }
};

// ---------------------------------------------------------------------------
// Wizard navigation
// ---------------------------------------------------------------------------
const syncBottomNav = (step) => {
  if (!bottomNav) return;
  const activeIdx = stepOrder.indexOf(step);
  bottomNav.querySelectorAll(".bottom-nav-item").forEach((btn, i) => {
    btn.classList.toggle("active", i === activeIdx);
    btn.classList.toggle("completed", i < activeIdx);
    btn.disabled = i > activeIdx + 1;
  });
};

const goToStep = (step) => {
  const nextIdx = stepOrder.indexOf(step);
  if (nextIdx < 0) return;

  // Hide current panel, show new one
  panels[currentStep]?.classList.remove("active");
  panels[step]?.classList.add("active");
  currentStep = step;

  // Update top wizard nav
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

  // Sync mobile bottom nav
  syncBottomNav(step);

  // If entering upload step, show file summary if tracks exist
  if (step === "upload") refreshUploadSummary();

  // If entering forge step, populate review
  if (step === "forge") populateForgeReview();

  // Persist session on step change
  if (onSessionChange) onSessionChange();
};

// Allow clicking completed/adjacent steps (top nav)
wizardNav.addEventListener("click", (e) => {
  const btn = e.target.closest(".wizard-step");
  if (!btn || btn.classList.contains("disabled")) return;
  const step = stepOrder[parseInt(btn.dataset.step, 10) - 1];
  if (step) goToStep(step);
});

// Mobile bottom nav clicks
bottomNav?.addEventListener("click", (e) => {
  const btn = e.target.closest(".bottom-nav-item");
  if (!btn || btn.disabled) return;
  const step = btn.dataset.step;
  if (step) goToStep(step);
});

// ---------------------------------------------------------------------------
// Edit panel tab switcher (mobile)
// ---------------------------------------------------------------------------
const editTabs = $("edit-tabs");
const editorGrid = $("editor-grid");

editTabs?.addEventListener("click", (e) => {
  const tab = e.target.closest(".edit-tab");
  if (!tab) return;
  const targetTab = tab.dataset.tab;
  editTabs.querySelectorAll(".edit-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === targetTab);
    t.setAttribute("aria-selected", String(t.dataset.tab === targetTab));
  });
  editorGrid?.classList.remove("tab-chapters", "tab-details");
  editorGrid?.classList.add(`tab-${targetTab}`);
});

// ---------------------------------------------------------------------------
// Prompt modal (replaces native window.prompt for better mobile UX)
// ---------------------------------------------------------------------------
const promptModal = (title, label, { isTextarea = false, defaultValue = "", placeholder = "" } = {}) =>
  new Promise((resolve) => {
    const modal = $("prompt-modal");
    if (!modal) { resolve(window.prompt(label, defaultValue)); return; }
    $("prompt-modal-title").textContent = title;
    $("prompt-modal-label").textContent = label;
    const inputEl = $("prompt-modal-input");
    const textareaEl = $("prompt-modal-textarea");
    if (isTextarea) {
      inputEl.hidden = true;
      textareaEl.hidden = false;
      textareaEl.value = "";
      textareaEl.placeholder = placeholder;
    } else {
      inputEl.hidden = false;
      textareaEl.hidden = true;
      inputEl.value = defaultValue;
      inputEl.placeholder = placeholder;
    }
    modal.hidden = false;
    requestAnimationFrame(() => (isTextarea ? textareaEl : inputEl).focus());

    const finish = (value) => {
      modal.hidden = true;
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      closeBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const confirmBtn = $("prompt-modal-confirm");
    const cancelBtn = $("prompt-modal-cancel");
    const closeBtn = $("prompt-modal-close");
    const onConfirm = () => finish(isTextarea ? textareaEl.value : inputEl.value);
    const onCancel = () => finish(null);
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); finish(null); }
      if (!isTextarea && e.key === "Enter") { e.preventDefault(); onConfirm(); }
    };
    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    closeBtn.addEventListener("click", onCancel);
    modal.addEventListener("keydown", onKey);
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
  const clamped = `${Math.min(100, Math.max(0, pct))}%`;
  progressTrack.hidden = false;
  progressFill.style.width = clamped;
  progressDialogBar.hidden = false;
  progressDialogBarFill.style.width = clamped;
};

const hideProgress = () => {
  progressTrack.hidden = true;
  progressFill.style.width = "0%";
  progressDialogBar.hidden = true;
  progressDialogBarFill.style.width = "0%";
};

let progressHideTimer = null;
let progressDismissedManually = false;

const showProgressDialog = () => {
  if (progressHideTimer) { clearTimeout(progressHideTimer); progressHideTimer = null; }
  progressDismissedManually = false;
  progressDialog.hidden = false;
};

const hideProgressDialogDelayed = () => {
  if (progressHideTimer) { clearTimeout(progressHideTimer); progressHideTimer = null; }
  if (!progressDialog.hidden) {
    progressHideTimer = setTimeout(() => {
      progressHideTimer = null;
      progressDialog.hidden = true;
      progressList.textContent = "";
      progressDismissedManually = false;
    }, 1200);
  } else if (progressDismissedManually) {
    // Dialog was dismissed but work finished — clean up after delay
    progressHideTimer = setTimeout(() => {
      progressHideTimer = null;
      progressList.textContent = "";
      progressDismissedManually = false;
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
  progressDismissedManually = true;
});

// Click anywhere on the progress dialog to reopen Drive download modal
progressDialog?.addEventListener("click", (e) => {
  if (e.target.closest(".btn")) return; // don't interfere with Hide button
  if (gdriveDownloading && isPickerHidden()) {
    setPickerVisible(true);
  }
});

// Click toolbar status to reopen dismissed progress dialog or download modal
const toolbarStatus = $("toolbar-status");
toolbarStatus?.addEventListener("click", () => {
  // Reopen Drive download modal if a download is in progress
  if (gdriveDownloading && isPickerHidden()) {
    setPickerVisible(true);
    return;
  }
  // Reopen progress dialog if it was dismissed
  if (progressDialog.hidden && progressList.childElementCount > 0) {
    progressDialog.hidden = false;
    progressDismissedManually = false;
  }
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

const fileKey = (file) => `${file.name}|${file.size}|${file.lastModified}`;

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "m4b", "aac", "ogg", "oga", "opus", "flac", "wav"]);
const AUDIO_MIME_PREFIXES = ["audio/mpeg", "audio/mp4", "audio/x-m4b", "audio/aac", "audio/ogg", "audio/flac", "audio/wav", "audio/x-wav", "audio/opus"];

const isAudioTrackFile = (file) => {
  if (!file) return false;
  const ext = file.name?.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? "";
  if (AUDIO_EXTENSIONS.has(ext)) return true;
  return AUDIO_MIME_PREFIXES.some((p) => file.type?.startsWith(p));
};

// Keep for compat — used by compiler to detect if stream-copy is safe
const isMp3File = (file) => file?.type === "audio/mpeg" || file?.name?.toLowerCase().endsWith(".mp3");

const setFieldIfDefault = (input, value, defaultValue) => {
  if (!input || !value) return false;
  const trimmed = String(value).trim();
  if (!trimmed) return false;
  if (!input.value || input.value === defaultValue) {
    input.value = trimmed;
    return true;
  }
  return false;
};

const setFieldIfEmpty = (input, value) => {
  if (!input || !value) return false;
  const trimmed = String(value).trim();
  if (!trimmed || input.value?.trim()) return false;
  input.value = trimmed;
  return true;
};

const applyBookFileMetadata = (meta) => {
  if (!meta) return;
  const updated = [];
  if (setFieldIfDefault(titleInput, meta.title, DEFAULT_TITLE)) updated.push("title");
  if (setFieldIfDefault(authorInput, meta.author, DEFAULT_AUTHOR)) updated.push("author");
  if (setFieldIfEmpty(descriptionInput, meta.description)) updated.push("description");
  if (setFieldIfEmpty(narratorInput, meta.narrator)) updated.push("narrator");
  if (meta.coverBlob && meta.coverBlob.size) {
    setCover(meta.coverBlob);
    updated.push("cover");
  }
  if (updated.length && onSessionChange) onSessionChange();
};

const processBookFiles = async (bookFiles, { keepStatus = false } = {}) => {
  if (!bookFiles.length) return null;
  uploadStatus.hidden = false;
  uploadStatusText.textContent = `Reading metadata from ${bookFiles.length} book file${bookFiles.length > 1 ? "s" : ""}...`;
  let embeddedChapters = null;
  let embeddedTimings = null;
  let firstBookMeta = null;
  for (const file of bookFiles) {
    try {
      uploadStatusText.textContent = `Processing ${file.name}...`;
      const meta = await extractMetadataFromBookFile(file);
      applyBookFileMetadata(meta);
      if (!firstBookMeta) firstBookMeta = meta;
      // Capture the first embedded chapter list found
      if (!embeddedChapters && meta.chapters?.length) {
        embeddedChapters = meta.chapters;
        embeddedTimings = meta.chapterTimings ?? null;
      }
    } catch (err) {
      console.warn("Book file metadata extraction failed for", file.name, err);
    }
  }
  if (!keepStatus) {
    uploadStatus.hidden = true;
  }
  return embeddedChapters
    ? { chapters: embeddedChapters, timings: embeddedTimings, bookMeta: firstBookMeta }
    : (firstBookMeta ? { chapters: null, timings: null, bookMeta: firstBookMeta } : null);
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
// Audio preview
// ---------------------------------------------------------------------------
const previewAudio = new Audio();
let previewingIndex = -1;
let previewObjectURL = null;

const stopPreview = () => {
  previewAudio.pause();
  previewAudio.currentTime = 0;
  if (previewObjectURL) { URL.revokeObjectURL(previewObjectURL); previewObjectURL = null; }
  const prev = trackList.querySelector(".track-play-btn.playing");
  if (prev) prev.classList.remove("playing");
  previewingIndex = -1;
};

const togglePreview = (index) => {
  if (previewingIndex === index) { stopPreview(); return; }
  stopPreview();
  const track = tracks[index];
  if (!track) return;
  previewObjectURL = URL.createObjectURL(track.file);
  previewAudio.src = previewObjectURL;
  previewAudio.play();
  previewingIndex = index;
  const btn = trackList.querySelectorAll(".track-play-btn")[index];
  if (btn) btn.classList.add("playing");
};

previewAudio.addEventListener("ended", stopPreview);

// ---------------------------------------------------------------------------
// Track list UI (step 3)
// ---------------------------------------------------------------------------
const teardownTrackRendering = () => {
  cancelScheduled(rowRenderHandle);
  rowRenderHandle = null;
};

const buildTrackRow = (track, index) => {
  const row = document.createElement("div");
  row.className = "track-row";
  row.draggable = true;
  row.dataset.index = index;
  row.addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
    row.classList.add("dragging");
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    trackList.querySelectorAll(".drag-over").forEach((r) => r.classList.remove("drag-over"));
  });
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    trackList.querySelectorAll(".drag-over").forEach((r) => r.classList.remove("drag-over"));
    row.classList.add("drag-over");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    row.classList.remove("drag-over");
    const fromIdx = parseInt(e.dataTransfer.getData("text/plain"), 10);
    const toIdx = parseInt(row.dataset.index, 10);
    if (fromIdx !== toIdx && Number.isFinite(fromIdx) && Number.isFinite(toIdx)) {
      const [item] = tracks.splice(fromIdx, 1);
      tracks.splice(toIdx, 0, item);
      stopPreview();
      refreshTrackList();
      if (onSessionChange) onSessionChange();
    }
  });

  // Grip handle (drag affordance)
  const grip = document.createElement("span");
  grip.className = "track-grip";
  grip.setAttribute("aria-hidden", "true");
  grip.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>`;

  const num = document.createElement("span");
  num.className = "track-num";
  num.textContent = String(index + 1).padStart(2, "0");

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "track-play-btn" + (previewingIndex === index ? " playing" : "");
  playBtn.title = "Preview";
  playBtn.innerHTML = previewingIndex === index
    ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
  playBtn.addEventListener("click", () => togglePreview(index));

  const body = document.createElement("div");
  body.className = "track-body";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "track-chapter-input";
  nameInput.value = track.chapterName || `Chapter ${index + 1}`;
  nameInput.addEventListener("change", () => {
    track.chapterName = nameInput.value.trim() || `Chapter ${index + 1}`;
    if (onSessionChange) onSessionChange();
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
  row.append(grip, num, playBtn, body, actions);
  return row;
};

const refreshTrackList = () => {
  teardownTrackRendering();
  trackList.textContent = "";

  if (!tracks.length) {
    if (chapterSearchBar) chapterSearchBar.hidden = true;
    const empty = document.createElement("div");
    empty.className = "track-list-empty";
    empty.textContent = "No chapters added yet.";
    trackList.appendChild(empty);
    chapterCount.textContent = "";
    if (restartBtn) restartBtn.hidden = true;
    return;
  }

  // Show Restart button whenever there are tracks
  if (restartBtn) restartBtn.hidden = false;
  // Show Fetch Chapters button once we have tracks
  if (fetchChaptersBtn) fetchChaptersBtn.hidden = false;

  // Show chapter search bar for 5+ tracks
  if (chapterSearchBar) chapterSearchBar.hidden = tracks.length < 5;

  // Build filtered pairs (real index preserved so mutations work correctly)
  const filterText = chapterFilter.toLowerCase().trim();
  const pairs = tracks.map((t, i) => ({ track: t, i })).filter(({ track, i }) => {
    if (!filterText) return true;
    const name = (track.chapterName || `Chapter ${i + 1}`).toLowerCase();
    return name.includes(filterText);
  });

  const totalDuration = tracks.reduce((s, t) => s + (t.meta?.duration || 0), 0);
  const totalSize = tracks.reduce((s, t) => s + t.file.size, 0);
  chapterCount.textContent = `${tracks.length} chapters \u00b7 ${formatDuration(totalDuration)} \u00b7 ${(totalSize / (1024 * 1024)).toFixed(1)} MB`;
  if (chapterSearchCount) {
    chapterSearchCount.textContent = filterText ? `${pairs.length} of ${tracks.length}` : "";
  }

  if (!pairs.length) {
    const empty = document.createElement("div");
    empty.className = "track-list-empty";
    empty.textContent = "No chapters match your filter.";
    trackList.appendChild(empty);
    return;
  }

  const renderState = { index: 0 };
  const renderBatch = () => {
    const fragment = document.createDocumentFragment();
    const end = Math.min(pairs.length, renderState.index + TRACK_RENDER_BATCH_SIZE);
    for (let j = renderState.index; j < end; j++) {
      const { track, i } = pairs[j];
      fragment.appendChild(buildTrackRow(track, i));
    }
    trackList.appendChild(fragment);
    renderState.index = end;
    if (renderState.index < pairs.length) {
      rowRenderHandle = scheduleIdle(renderBatch, 32);
    } else {
      rowRenderHandle = null;
    }
  };

  renderBatch();
};

// ---------------------------------------------------------------------------
// Batch chapter rename
// ---------------------------------------------------------------------------
const renameBtn = $("rename-btn");
const renameMenu = $("rename-menu");

renameBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  renameMenu.hidden = !renameMenu.hidden;
});
document.addEventListener("click", () => { renameMenu.hidden = true; });

renameMenu.addEventListener("click", async (e) => {
  const opt = e.target.closest(".rename-option");
  if (!opt) return;
  renameMenu.hidden = true;
  const pattern = opt.dataset.pattern;
  if (!tracks.length) return;

  if (pattern === "chapter-num") {
    tracks.forEach((t, i) => { t.chapterName = `Chapter ${i + 1}`; });
  } else if (pattern === "part-num") {
    tracks.forEach((t, i) => { t.chapterName = `Part ${i + 1}`; });
  } else if (pattern === "filename") {
    tracks.forEach((t) => { t.chapterName = t.file.name.replace(/\.[^.]+$/, ""); });
  } else if (pattern === "custom") {
    const prefix = await promptModal("Custom Rename", "Prefix (a number will be added after)", {
      defaultValue: "Chapter",
      placeholder: "e.g. Chapter",
    });
    if (prefix == null) return;
    tracks.forEach((t, i) => { t.chapterName = `${prefix} ${i + 1}`; });
  } else if (pattern === "paste") {
    const list = await promptModal("Paste Chapter Names", "One chapter name per line", {
      isTextarea: true,
      placeholder: "Chapter 1\nChapter 2\n…",
    });
    if (list == null) return;
    const names = list.split("\n").map((s) => s.trim()).filter(Boolean);
    names.forEach((name, i) => { if (i < tracks.length) tracks[i].chapterName = name; });
  }
  refreshTrackList();
  if (onSessionChange) onSessionChange();
});

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
  const files = Array.from(fileList || []);
  console.log(`[addFiles] received ${files.length} file(s):`, files.map((f) => `${f.name} (${f.type}, ${f.size}B)`));
  let audioFiles = files.filter((file) => isAudioTrackFile(file));
  // EPUB and PDF only — M4B is handled as an audio track below
  const bookFiles = files.filter((file) => !isAudioTrackFile(file) && isSupportedBookFile(file));
  console.log(`[addFiles] ${audioFiles.length} audio file(s), ${bookFiles.length} book file(s)`);
  if (!audioFiles.length && !bookFiles.length) {
    console.warn("[addFiles] no recognised audio or book files — returning early");
    return;
  }

  if (bookFiles.length) {
    await processBookFiles(bookFiles, { keepStatus: audioFiles.length > 0 });
  }

  // M4B files also carry album/artist/cover and possibly embedded chapter lists
  const m4bAudioFiles = audioFiles.filter((f) => {
    const ext = f.name?.toLowerCase().match(/\.([^.]+)$/)?.[1];
    return ext === "m4b" || f.type === "audio/x-m4b";
  });
  const m4bResult = m4bAudioFiles.length
    ? await processBookFiles(m4bAudioFiles, { keepStatus: true })
    : null;
  const embeddedChapters = m4bResult?.chapters ?? null;
  const embeddedTimings = m4bResult?.timings ?? null;
  // Book-level metadata already parsed by processBookFiles — used below to
  // populate virtual track meta without re-reading the source file.
  const m4bBookMeta = m4bResult?.bookMeta ?? null;

  // Single M4B with multiple embedded chapters: expand to one virtual track per
  // chapter so the user can view and edit each chapter name individually.
  // Each virtual track wraps the same source file with a unique filename so that
  // undo/redo (keyed on file.name) and the compiler can distinguish them.
  let expandedFromSingleM4B = false;
  let m4bSourceFile = null;
  if (audioFiles.length === 1 && (embeddedChapters?.length ?? 0) > 1) {
    const src = audioFiles[0];
    const ext = src.name?.toLowerCase().match(/\.([^.]+)$/)?.[1];
    if (ext === "m4b" || src.type === "audio/x-m4b" || src.type === "audio/mp4") {
      m4bSourceFile = src;
      const stem = src.name.replace(/\.[^.]+$/, "");
      audioFiles = embeddedChapters.map((_, i) =>
        new File([src], `${stem}_ch${String(i + 1).padStart(3, "0")}.m4b`, { type: src.type, lastModified: src.lastModified })
      );
      expandedFromSingleM4B = true;
    }
  }

  if (!audioFiles.length) return;

  // Show loading state on upload panel
  dropZone.hidden = true;
  uploadFileSummary.hidden = true;
  const altActions = document.querySelector(".upload-alt-actions");
  if (altActions) altActions.hidden = true;
  uploadStatus.hidden = false;
  uploadStatusText.textContent = `Reading ${audioFiles.length} file${audioFiles.length > 1 ? "s" : ""}...`;

  const newTracks = audioFiles.map((file, i) => (expandedFromSingleM4B
    ? {
        file,
        meta: null,
        chapterName: embeddedChapters[i],
        chapterStart: embeddedTimings?.[i]?.start ?? null,
        chapterEnd: embeddedTimings?.[i]?.end ?? null,
        _sourceFile: m4bSourceFile,
      }
    : { file, meta: null, chapterName: null }));
  tracks = [...tracks, ...newTracks];

  // Initial sort by filename
  tracks.sort((a, b) => {
    const keyA = extractSortKey(a.file.name);
    const keyB = extractSortKey(b.file.name);
    if (keyA !== keyB) return keyA - keyB;
    return a.file.name.localeCompare(b.file.name, undefined, { numeric: true });
  });

  // Extract metadata in batches of 8 to avoid saturating the main thread
  uploadStatusText.textContent = "Reading ID3 metadata...";
  const META_BATCH = 8;
  const metaFailures = [];
  for (let i = 0; i < newTracks.length; i += META_BATCH) {
    const batch = newTracks.slice(i, i + META_BATCH);
    const batchResults = await Promise.allSettled(batch.map(async (t) => {
      if (t._sourceFile || m4bAudioFiles.includes(t.file)) {
        // M4B file already parsed by processBookFiles — reuse the metadata
        // instead of calling parseBlob again on the same large file.
        // Covers both virtual chapter tracks (_sourceFile set) and a single
        // M4B with no embedded chapters (no expansion, _sourceFile unset).
        t.meta = {
          title: null,
          album: m4bBookMeta?.title ?? null,
          artist: m4bBookMeta?.author ?? null,
          year: null,
          track: null,
          genre: null,
          description: m4bBookMeta?.description ?? null,
          picture: null,
          duration: null,
          bitrate: null,
        };
      } else {
        t.meta = await extractMetadata(t.file);
      }
    }));
    batchResults.forEach((r) => { if (r.status === "rejected") metaFailures.push(r); });
    if (newTracks.length > META_BATCH) {
      uploadStatusText.textContent = `Reading ID3 metadata... (${Math.min(i + META_BATCH, newTracks.length)}/${newTracks.length})`;
    }
  }
  if (metaFailures.length) {
    console.warn(`Metadata extraction failed for ${metaFailures.length} file(s):`, metaFailures.map((r) => r.reason));
  }

  // Re-sort with ID3 track numbers
  sortTracks();

  // Infer book info
  const allMeta = tracks.map((t) => t.meta);
  inferredBook = inferBook(tracks, allMeta);

  // Apply chapter names — prefer embedded chapter list from M4B when inferBook
  // couldn't find real names (all "Chapter N") and the count matches.
  // Skip this pass when we already set chapterName via single-M4B expansion.
  if (!expandedFromSingleM4B) {
    const hasRealInferredNames = inferredBook.chapters?.some((n) => !/^Chapter \d+$/.test(n));
    const useEmbedded = !hasRealInferredNames && embeddedChapters?.length === tracks.length;
    const chaptersToApply = useEmbedded ? embeddedChapters : inferredBook.chapters;
    if (chaptersToApply) {
      chaptersToApply.forEach((name, i) => {
        if (i < tracks.length) tracks[i].chapterName = name;
      });
    }
  }

  // Detect series from inferred title
  const seriesInfo = detectSeries(inferredBook.title);
  if (seriesInfo) {
    seriesInput.value = seriesInfo.series;
    booknumInput.value = seriesInfo.totalBooks
      ? `${seriesInfo.bookNum} of ${seriesInfo.totalBooks}`
      : String(seriesInfo.bookNum);
    // Use the series name as the title instead of the full "Title, Book X" string
    inferredBook.title = seriesInfo.series;
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

  console.log(`[addFiles] calling refreshTrackList with ${tracks.length} track(s)`);
  refreshTrackList();

  // Auto-advance to Match step and trigger search
  console.log("[addFiles] calling goToStep('match')");
  goToStep("match");
  // Fall back to form field values in case processBookFiles already populated them
  // (e.g. a single M4B whose title/artist was set by readM4BFile but inferBook couldn't
  // independently derive the title because common.album was unset)
  const effectiveTitle = inferredBook?.title || (titleInput.value !== DEFAULT_TITLE ? titleInput.value : null);
  const effectiveAuthor = inferredBook?.author || (authorInput.value !== DEFAULT_AUTHOR ? authorInput.value : null);
  const searchQ = [effectiveTitle, effectiveAuthor].filter(Boolean).join(" ");
  if (searchQ.length >= 3) {
    lookupQuery.value = searchQ;
    scheduleAutoLookup(searchQ);
  } else {
    cancelAutoLookup();
    matchResultsGrid.textContent = "";
    coverResultsStrip.textContent = "";
    const empty = document.createElement("div");
    empty.className = "match-empty";
    empty.textContent = "Could not auto-detect book info. Try searching manually above.";
    matchResultsGrid.appendChild(empty);
  }

  // Reset upload panel — summary will show when user navigates back
  uploadStatus.hidden = true;
};

const moveTrack = (from, to) => {
  if (to < 0 || to >= tracks.length) return;
  const updated = [...tracks];
  const [item] = updated.splice(from, 1);
  updated.splice(to, 0, item);
  tracks = updated;
  refreshTrackList();
  if (onSessionChange) onSessionChange();
};

const removeTrack = (index) => {
  tracks.splice(index, 1);
  refreshTrackList();
  if (onSessionChange) onSessionChange();
};

// ---------------------------------------------------------------------------
// Book lookup (step 2)
// ---------------------------------------------------------------------------
const performLookup = async (query) => {
  if (!query || query.trim().length < 2) return;

  matchResultsGrid.textContent = "";
  coverResultsStrip.textContent = "";
  const spinner = document.createElement("div");
  spinner.className = "match-spinner";
  spinner.textContent = "Searching Google Books & Open Library...";
  matchResultsGrid.appendChild(spinner);

  const results = await searchBooks(query, 6);
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
    const fallbackUrls = (result.coverUrls || []).slice(1);
    let fallbackIdx = 0;
    img.addEventListener("error", () => {
      if (fallbackIdx < fallbackUrls.length) {
        img.src = fallbackUrls[fallbackIdx++];
      } else {
        thumb.remove();
      }
    });
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
  // Detect series from search result title
  const lookupSeries = detectSeries(result.title);
  if (lookupSeries) {
    seriesInput.value = lookupSeries.series;
    booknumInput.value = lookupSeries.totalBooks
      ? `${lookupSeries.bookNum} of ${lookupSeries.totalBooks}`
      : String(lookupSeries.bookNum);
  }

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
  toastSuccess("Metadata applied from search result.");
  matchNextBtn?.classList.remove("match-ready");
  // Re-trigger the animation by forcing reflow
  void matchNextBtn?.offsetWidth;
  matchNextBtn?.classList.add("match-ready");
  if (onSessionChange) onSessionChange();
};

const applyCover = async (result) => {
  const urls = result.coverUrls?.length ? result.coverUrls : result.coverUrl ? [result.coverUrl] : [];
  if (!urls.length) return;
  updateStatus("Fetching cover...");
  const blob = await fetchCoverBlob(urls);
  if (blob && blob.size > 0) setCover(blob);
  else updateStatus("No usable cover found", "error");
  setIdle(blob ? "Cover loaded" : "Ready");
  if (onSessionChange) onSessionChange();
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
  if (seriesInput.value) {
    const seriesLabel = booknumInput.value
      ? `${seriesInput.value} #${booknumInput.value}`
      : seriesInput.value;
    pills.push(seriesLabel);
  }
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
// Compile to M4B (delegates to compiler.js)
// ---------------------------------------------------------------------------
const ui = { updateStatus, showProgress, hideProgress, setIdle };

const bitrateSelect = $("bitrate-select");
const compileBtnIcon = document.querySelector(".compile-btn-icon");
const compileBtnSpinner = document.querySelector(".compile-btn-spinner");
const compileBtnLabel = document.querySelector(".compile-btn-label");

const setCompileSpinner = (on) => {
  if (compileBtnIcon) compileBtnIcon.hidden = on;
  if (compileBtnSpinner) compileBtnSpinner.hidden = !on;
  if (compileBtnLabel) compileBtnLabel.textContent = on ? "Forging…" : "Forge M4B";
};

const doCompile = async () => {
  const { blob, filename } = await compileM4B({
    tracks,
    coverFile,
    formValues: {
      title: titleInput.value,
      author: authorInput.value,
      year: yearInput.value,
      genre: genreInput.value,
      narrator: narratorInput.value,
      description: descriptionInput.value,
    },
    bitrate: bitrateSelect.value,
    onChapterProgress: (index, total, phase) => {
      if (phase === "reading") {
        updateStatus(`Reading chapter ${index + 1} of ${total}…`);
      }
    },
    ui,
  });

  // Trigger download
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  // Retain for Google Drive export
  lastCompiledBlob = blob;
  lastCompiledFilename = filename;
  gdriveExportBtn.hidden = false;
  if (downloadAgainBtn) downloadAgainBtn.hidden = false;

  showProgress(100);
  setIdle("Complete!");
  setTimeout(hideProgress, 1500);
  toastSuccess(`"${filename}" downloaded successfully!`, 6000);
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
  cancelAutoLookup();
  clearTimeout(lookupDebounceTimer);
  lookupDebounceTimer = setTimeout(() => performLookup(lookupQuery.value), 400);
};
lookupBtn.addEventListener("click", () => {
  cancelAutoLookup();
  performLookup(lookupQuery.value);
});
lookupQuery.addEventListener("input", debouncedLookup);
lookupQuery.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(lookupDebounceTimer);
    cancelAutoLookup();
    performLookup(lookupQuery.value);
  }
});

// Clear all
const clearAll = async () => {
  tracks = [];
  chapterFilter = "";
  if (chapterSearchInput) chapterSearchInput.value = "";
  if (chapterSearchClear) chapterSearchClear.hidden = true;
  inferredBook = null;
  removeCover();
  titleInput.value = "Untitled Audiobook";
  authorInput.value = "Unknown";
  yearInput.value = "";
  genreInput.value = "Audiobook";
  narratorInput.value = "";
  seriesInput.value = "";
  booknumInput.value = "";
  descriptionInput.value = "";
  lookupQuery.value = "";
  lastCompiledBlob = null;
  lastCompiledFilename = null;
  if (downloadAgainBtn) downloadAgainBtn.hidden = true;
  matchNextBtn?.classList.remove("match-ready");
  refreshTrackList();
  clearHistory();
  await clearSession();
  goToStep("upload");
  if (restartBtn) restartBtn.hidden = true;
  if (fetchChaptersBtn) fetchChaptersBtn.hidden = true;
};
clearAllButton.addEventListener("click", clearAll);

// Upload summary buttons
uploadAddMoreBtn.addEventListener("click", () => fileInput.click());
uploadClearBtn.addEventListener("click", clearAll);
uploadNextBtn.addEventListener("click", () => goToStep("match"));
restartBtn?.addEventListener("click", clearAll);

// Chapter search filter
chapterSearchInput?.addEventListener("input", () => {
  chapterFilter = chapterSearchInput.value;
  if (chapterSearchClear) chapterSearchClear.hidden = !chapterFilter;
  refreshTrackList();
});
chapterSearchClear?.addEventListener("click", () => {
  chapterFilter = "";
  if (chapterSearchInput) chapterSearchInput.value = "";
  if (chapterSearchClear) chapterSearchClear.hidden = true;
  refreshTrackList();
  chapterSearchInput?.focus();
});

// ---------------------------------------------------------------------------
// Fetch Chapters from Google Books / Open Library
// ---------------------------------------------------------------------------
fetchChaptersBtn?.addEventListener("click", async () => {
  if (!tracks.length) return;
  const query = [titleInput.value, authorInput.value].filter((v) => v && v !== DEFAULT_TITLE && v !== DEFAULT_AUTHOR).join(" ");
  if (!query.trim()) {
    toastWarning("Enter a title or author first.");
    return;
  }
  fetchChaptersBtn.disabled = true;
  updateStatus("Searching for chapter names…");
  try {
    const results = await searchBooks(query, 3);
    if (!results.length) {
      updateStatus("No matching book found", "error");
      toastWarning("No matching book found. Try searching in the Match step.");
      setTimeout(setIdle, 3000);
      return;
    }
    updateStatus("Fetching chapter list…");
    let chapters = null;
    for (const result of results) {
      const details = await fetchBookDetails(result);
      if (details.chapters?.length) {
        chapters = details.chapters;
        break;
      }
    }
    if (!chapters?.length) {
      updateStatus("No chapter list found for this book", "error");
      toastWarning("No chapter list found for this book.");
      setTimeout(setIdle, 3000);
      return;
    }
    const count = Math.min(chapters.length, tracks.length);
    for (let i = 0; i < count; i++) tracks[i].chapterName = chapters[i];
    for (let i = count; i < tracks.length; i++) tracks[i].chapterName = `Chapter ${i + 1}`;
    refreshTrackList();
    if (onSessionChange) onSessionChange();
    setIdle(`Applied ${count} chapter name${count !== 1 ? "s" : ""}`);
    toastSuccess(`Applied ${count} chapter name${count !== 1 ? "s" : ""} from the book database.`);
  } catch (err) {
    console.error("Fetch chapters failed:", err);
    updateStatus(err.message || "Failed to fetch chapters", "error");
    toastError(err.message || "Failed to fetch chapters.");
    setTimeout(setIdle, 3000);
  } finally {
    fetchChaptersBtn.disabled = false;
  }
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
  if (currentStep === "upload") {
    if (!dropZone.hidden) dropZone.classList.add("dragover");
    else uploadFileSummary.classList.add("dragover");
  }
});
document.body.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
    dropZone.classList.remove("dragover");
    uploadFileSummary.classList.remove("dragover");
  }
});
document.body.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  uploadFileSummary.classList.remove("dragover");
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
  if (!tracks.length) { toastError("Add audio files first."); return; }
  compileButton.disabled = true;
  setCompileSpinner(true);
  try {
    await doCompile();
  } catch (err) {
    console.error(err);
    updateStatus(err.message || "Conversion failed", "error");
    toastError(err.message || "Conversion failed — check the console for details.", 8000);
    hideProgress();
  } finally {
    compileButton.disabled = !tracks.length;
    setCompileSpinner(false);
    setTimeout(() => { if (!tracks.length) setIdle(); }, 4000);
  }
});


// ---------------------------------------------------------------------------
// Google Drive import / export (picker UI in drive-ui.js)
// ---------------------------------------------------------------------------
gdriveImportBtn.addEventListener("click", async () => {
  try {
    const files = await importFromDrive(ui);
    if (files === null) {
      // Auth failed or cancelled — importFromDrive already managed status
    } else if (files.length) {
      await addFiles(files);
      const n = tracks.length;
      setIdle(n > 0 ? `${n} file${n !== 1 ? "s" : ""} imported` : "Ready");
      if (n > 0) toastSuccess(`${n} file${n !== 1 ? "s" : ""} imported from Google Drive.`);
    } else {
      updateStatus("Download failed — check your Drive connection and try again.", "error");
      toastError("Download failed — check your Google Drive connection.");
      setTimeout(setIdle, 4000);
    }
  } catch (err) {
    console.error("Google Drive import failed:", err);
    updateStatus(err.message || "Google Drive import failed", "error");
    toastError(err.message || "Google Drive import failed.");
    setTimeout(setIdle, 3000);
  }
});

// Auto-resume Google Drive import after iOS OAuth redirect
if (handleRedirectReturn() && hasPendingRedirect()) {
  clearPendingRedirect();
  // Token is now stored — trigger the import flow automatically
  (async () => {
    try {
      const files = await importFromDrive(ui);
      if (files === null) {
        // Auth failed or user cancelled — importFromDrive already managed status
      } else if (files.length) {
        await addFiles(files);
        setIdle();
      } else {
        updateStatus("Download failed — check your Drive connection and try again.", "error");
        setTimeout(setIdle, 4000);
      }
    } catch (err) {
      console.error("Google Drive import (redirect resume) failed:", err);
      updateStatus(err.message || "Google Drive import failed", "error");
      setTimeout(setIdle, 3000);
    }
  })();
} else {
  // No redirect — clean up any stale pending flag
  clearPendingRedirect();
}

gdriveExportBtn.addEventListener("click", async () => {
  if (!lastCompiledBlob || !lastCompiledFilename) return;
  try {
    const result = await exportToDrive(lastCompiledBlob, lastCompiledFilename, ui);
    if (result.webViewLink) {
      toastSuccess("File saved to Google Drive!", 5000);
      window.open(result.webViewLink, "_blank", "noopener");
    }
    setTimeout(hideProgress, 1500);
  } catch (err) {
    console.error("Google Drive export failed:", err);
    hideProgress();
    updateStatus(err.message || "Google Drive upload failed", "error");
    toastError(err.message || "Google Drive upload failed.");
    setTimeout(setIdle, 3000);
  }
});

downloadAgainBtn?.addEventListener("click", () => {
  if (!lastCompiledBlob || !lastCompiledFilename) return;
  const url = URL.createObjectURL(lastCompiledBlob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = lastCompiledFilename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  toastInfo(`Re-downloading \u201c${lastCompiledFilename}\u201d\u2026`);
});
// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------
const gatherState = () => ({
  currentStep,
  formFields: {
    title: titleInput.value,
    author: authorInput.value,
    year: yearInput.value,
    genre: genreInput.value,
    narrator: narratorInput.value,
    series: seriesInput.value,
    booknum: booknumInput.value,
    description: descriptionInput.value,
  },
  inferredBook,
  coverBlob: coverFile || null,
  tracks: tracks.map((t) => ({
    fileKey: fileKey(t.file),
    fileName: t.file.name,
    fileType: t.file.type,
    fileLastModified: t.file.lastModified,
    chapterName: t.chapterName,
    chapterStart: t.chapterStart ?? null,
    chapterEnd: t.chapterEnd ?? null,
    meta: t.meta ? { ...t.meta, picture: null } : null,
  })),
});

const restoreState = (saved) => {
  // Reconstruct tracks with File objects
  tracks = saved.tracks.map((t) => {
    const blobSource = t.blob instanceof Blob ? t.blob : null;
    const file = blobSource
      ? new File([blobSource], t.fileName, {
          type: t.fileType || "audio/mpeg",
          lastModified: t.fileLastModified,
        })
      : new File([], t.fileName, {
          type: t.fileType || "audio/mpeg",
          lastModified: t.fileLastModified,
        });
    return {
      file,
      meta: t.meta,
      chapterName: t.chapterName,
      chapterStart: t.chapterStart ?? null,
      chapterEnd: t.chapterEnd ?? null,
    };
  });

  // Restore form fields
  const f = saved.formFields;
  if (f.title) titleInput.value = f.title;
  if (f.author) authorInput.value = f.author;
  if (f.year) yearInput.value = f.year;
  if (f.genre) genreInput.value = f.genre;
  if (f.narrator) narratorInput.value = f.narrator;
  if (f.series) seriesInput.value = f.series;
  if (f.booknum) booknumInput.value = f.booknum;
  if (f.description) descriptionInput.value = f.description;

  // Restore inferred book
  inferredBook = saved.inferredBook || null;

  // Restore cover
  if (saved.coverBlob) setCover(saved.coverBlob);

  // Refresh UI
  refreshTrackList();
  goToStep(saved.currentStep || "upload");
  savedTrackKeys = new Set(tracks.map((t) => fileKey(t.file)));
};

const scheduleSessionSave = () => {
  cancelScheduled(sessionSaveHandle);
  sessionSaveHandle = scheduleIdle(async () => {
    sessionSaveHandle = null;
    const state = gatherState();
    const currentKeys = new Set();
    const trackBlobs = [];
    state.tracks.forEach((trackMeta, index) => {
      currentKeys.add(trackMeta.fileKey);
      if (!savedTrackKeys.has(trackMeta.fileKey)) {
        trackBlobs.push({ key: trackMeta.fileKey, blob: tracks[index]?.file });
      }
    });
    const result = await saveSession({
      ...state,
      trackBlobs,
      pruneTrackStore: true,
    });
    if (result?.error === "QuotaExceededError") {
      updateStatus("Storage full — session not saved", "error");
      toastWarning("Storage full — session could not be saved. Free up space to persist your work.");
    }
    if (!result?.error) {
      savedTrackKeys = currentKeys;
    }
  }, 1200);
};

// ---------------------------------------------------------------------------
// Undo / Redo
// ---------------------------------------------------------------------------
const getUndoState = () => ({
  chapterNames: tracks.map((t) => t.chapterName),
  trackOrder: tracks.map((t) => t.file.name),
  form: {
    title: titleInput.value, author: authorInput.value, year: yearInput.value,
    genre: genreInput.value, narrator: narratorInput.value,
    series: seriesInput.value, booknum: booknumInput.value,
    description: descriptionInput.value,
  },
});

const applyUndoState = (state) => {
  // Reorder tracks to match saved order
  const byName = new Map(tracks.map((t) => [t.file.name, t]));
  const reordered = state.trackOrder.map((n) => byName.get(n)).filter(Boolean);
  // Keep any tracks not in saved order at the end
  const remaining = tracks.filter((t) => !state.trackOrder.includes(t.file.name));
  tracks = [...reordered, ...remaining];

  state.chapterNames.forEach((name, i) => { if (i < tracks.length) tracks[i].chapterName = name; });
  const f = state.form;
  titleInput.value = f.title; authorInput.value = f.author; yearInput.value = f.year;
  genreInput.value = f.genre; narratorInput.value = f.narrator;
  seriesInput.value = f.series; booknumInput.value = f.booknum;
  descriptionInput.value = f.description;
  refreshTrackList();
};

// Push initial state on any tracked change
const pushUndoState = () => pushState(getUndoState);
const scheduleUndoSnapshot = () => {
  cancelScheduled(undoScheduleHandle);
  undoScheduleHandle = scheduleIdle(() => {
    undoScheduleHandle = null;
    pushUndoState();
  }, 600);
};

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
    e.preventDefault();
    undo(getUndoState, applyUndoState);
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
    e.preventDefault();
    redo(getUndoState, applyUndoState);
  }
});

// Wire up the session change callback (used by goToStep, etc.)
onSessionChange = () => { scheduleUndoSnapshot(); scheduleSessionSave(); };

// Save on form field changes
[titleInput, authorInput, yearInput, genreInput, narratorInput, seriesInput, booknumInput, descriptionInput]
  .forEach((el) => {
    el.addEventListener("input", scheduleSessionSave);
    el.addEventListener("change", scheduleUndoSnapshot);
  });

// Init — restore session or start fresh
(async () => {
  const saved = await loadSession();
  if (saved && saved.tracks?.length > 0) {
    restoreState(saved);
  } else {
    goToStep("upload");
  }
})();
