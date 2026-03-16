import { FFmpeg } from "https://esm.sh/@ffmpeg/ffmpeg@0.12.10";
import { fetchFile, toBlobURL } from "https://esm.sh/@ffmpeg/util@0.12.1";
import { inferBook, buildChapterNames } from "./book-parser.js";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const form = document.getElementById("compile-form");
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const trackList = document.getElementById("track-list");
const clearAllButton = document.getElementById("clear-all");
const compileButton = document.getElementById("compile-button");
const statusValue = document.getElementById("status-value");
const progressBar = document.getElementById("progress-bar");
const progressFill = document.getElementById("progress-fill");
const titleInput = form.elements.namedItem("title");
const authorInput = form.elements.namedItem("author");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let tracks = []; // { file: File, meta: null | { duration, bitrate, title, artist, album }, chapterName: null | string }
let ffmpeg = null;
let ffmpegReady = false;
let inferredBook = null; // result from inferBook()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const updateStatus = (label) => {
  statusValue.textContent = label;
};

const showProgress = (pct) => {
  progressBar.hidden = false;
  progressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
};

const hideProgress = () => {
  progressBar.hidden = true;
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
// Client-side ID3 metadata extraction via jsmediatags
// ---------------------------------------------------------------------------
const readID3 = (file) =>
  new Promise((resolve) => {
    // Dynamically load jsmediatags if not cached
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
      resolve({
        title: t.title || null,
        artist: t.artist || null,
        album: t.album || null,
        year: t.year || null,
        track: t.track ? String(t.track) : null,
      });
    },
    onError: () => resolve(null),
  });
};

// Get duration + bitrate via Web Audio / Audio element
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
          duration > 0
            ? Math.round((file.size * 8) / duration / 1000)
            : 0;
        URL.revokeObjectURL(url);
        resolve({ duration: Math.round(duration * 100) / 100, bitrate });
      },
      { once: true }
    );
    audio.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      resolve({ duration: 0, bitrate: 0 });
    }, { once: true });
  });

const extractMetadata = async (file) => {
  const [id3, audioInfo] = await Promise.all([readID3(file), readAudioInfo(file)]);
  return {
    title: id3?.title || null,
    artist: id3?.artist || null,
    album: id3?.album || null,
    year: id3?.year || null,
    track: id3?.track || null,
    duration: audioInfo.duration,
    bitrate: audioInfo.bitrate,
  };
};

// ---------------------------------------------------------------------------
// FFmpeg.wasm setup
// ---------------------------------------------------------------------------
const loadFFmpeg = async () => {
  if (ffmpegReady) return;
  updateStatus("Loading FFmpeg…");
  showProgress(10);

  ffmpeg = new FFmpeg();

  ffmpeg.on("progress", ({ progress }) => {
    showProgress(20 + progress * 70);
  });

  const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
  });

  ffmpegReady = true;
  hideProgress();
  updateStatus("Idle");
};

// ---------------------------------------------------------------------------
// Track list UI
// ---------------------------------------------------------------------------
const refreshTrackList = () => {
  trackList.innerHTML = "";

  if (!tracks.length) {
    trackList.innerHTML = '<li class="empty">No tracks added yet.</li>';
    compileButton.disabled = true;
    return;
  }

  compileButton.disabled = false;

  tracks.forEach((track, index) => {
    const li = document.createElement("li");
    li.className = "track-row";

    const order = document.createElement("strong");
    order.textContent = String(index + 1).padStart(2, "0");

    const info = document.createElement("div");
    info.className = "track-info";

    const nameEl = document.createElement("span");
    nameEl.className = "track-name";
    nameEl.textContent = track.chapterName || track.file.name;

    const details = document.createElement("small");
    details.className = "track-meta";
    const megabytes = (track.file.size / (1024 * 1024)).toFixed(1);
    const detailParts = [];
    if (track.chapterName) detailParts.push(track.file.name);
    if (track.meta) {
      if (track.meta.artist && !track.chapterName) detailParts.push(track.meta.artist);
      detailParts.push(formatDuration(track.meta.duration));
      detailParts.push(`${track.meta.bitrate || "?"}kbps`);
    }
    detailParts.push(`${megabytes} MB`);
    details.textContent = detailParts.join(" \u00b7 ");

    info.append(nameEl, details);

    const actions = document.createElement("div");
    actions.className = "track-actions";

    const upButton = document.createElement("button");
    upButton.type = "button";
    upButton.className = "ghost icon";
    upButton.textContent = "\u2191";
    upButton.disabled = index === 0;
    upButton.addEventListener("click", () => moveTrack(index, index - 1));

    const downButton = document.createElement("button");
    downButton.type = "button";
    downButton.className = "ghost icon";
    downButton.textContent = "\u2193";
    downButton.disabled = index === tracks.length - 1;
    downButton.addEventListener("click", () => moveTrack(index, index + 1));

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "ghost icon";
    removeButton.textContent = "\u2715";
    removeButton.addEventListener("click", () => removeTrack(index));

    actions.append(upButton, downButton, removeButton);
    li.append(order, info, actions);
    trackList.append(li);
  });
};

// ---------------------------------------------------------------------------
// Track management
// ---------------------------------------------------------------------------
const addFiles = async (fileList) => {
  const mp3Files = Array.from(fileList).filter(
    (file) =>
      file.type === "audio/mpeg" || file.name.toLowerCase().endsWith(".mp3")
  );

  const newTracks = mp3Files.map((file) => ({ file, meta: null, chapterName: null }));
  tracks = [...tracks, ...newTracks];
  refreshTrackList();

  // Extract metadata in parallel
  const metaPromises = newTracks.map(async (t) => {
    t.meta = await extractMetadata(t.file);
  });
  await Promise.all(metaPromises);

  // Run book inference across ALL tracks (filenames + ID3 consensus)
  const allMeta = tracks.map((t) => t.meta);
  inferredBook = inferBook(tracks, allMeta);

  // Apply inferred chapter names
  if (inferredBook.chapters) {
    inferredBook.chapters.forEach((name, i) => {
      if (i < tracks.length) tracks[i].chapterName = name;
    });
  }

  // Auto-populate title/author if still at defaults
  if (inferredBook.title && titleInput.value === "Untitled Audiobook") {
    titleInput.value = inferredBook.title;
  }
  if (inferredBook.author && authorInput.value === "Unknown") {
    authorInput.value = inferredBook.author;
  }

  refreshTrackList();
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
// Compile to M4B (fully in-browser)
// ---------------------------------------------------------------------------
const compileM4B = async () => {
  await loadFFmpeg();

  const titleVal = titleInput.value.trim() || "Untitled Audiobook";
  const authorVal = authorInput.value.trim() || "Unknown";

  updateStatus("Reading files…");
  showProgress(5);

  // Write each MP3 into the virtual FS
  const filenames = [];
  for (let i = 0; i < tracks.length; i++) {
    const fname = `input_${String(i).padStart(3, "0")}.mp3`;
    filenames.push(fname);
    await ffmpeg.writeFile(fname, await fetchFile(tracks[i].file));
    showProgress(5 + ((i + 1) / tracks.length) * 10);
  }

  // Build concat list
  const listContent = filenames.map((f) => `file '${f}'`).join("\n");
  await ffmpeg.writeFile(
    "inputs.txt",
    new TextEncoder().encode(listContent)
  );

  // Build chapter metadata file using inferred chapter names
  let chapterMeta = ";FFMETADATA1\n";
  chapterMeta += `title=${titleVal}\n`;
  chapterMeta += `artist=${authorVal}\n`;
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
      chapterMeta += "\n[CHAPTER]\nTIMEBASE=1/1000\n";
      chapterMeta += `START=${cursorMs}\n`;
      chapterMeta += `END=${cursorMs + durationMs}\n`;
      chapterMeta += `title=${chTitle}\n`;
      cursorMs += durationMs;
    }
  }
  await ffmpeg.writeFile(
    "chapters.txt",
    new TextEncoder().encode(chapterMeta)
  );

  // Step 1: concatenate MP3s
  updateStatus("Concatenating…");
  showProgress(18);
  await ffmpeg.exec([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", "inputs.txt",
    "-c", "copy",
    "combined.mp3",
  ]);

  // Step 2: convert to AAC/M4B with metadata + chapters
  updateStatus("Converting to M4B…");
  showProgress(25);
  await ffmpeg.exec([
    "-y",
    "-i", "combined.mp3",
    "-i", "chapters.txt",
    "-map_metadata", "1",
    "-map_chapters", "1",
    "-c:a", "aac",
    "-b:a", "96k",
    "-vn",
    "-movflags", "+faststart",
    "-f", "mp4",
    "audiobook.m4b",
  ]);

  updateStatus("Preparing download…");
  showProgress(95);
  const data = await ffmpeg.readFile("audiobook.m4b");

  // Cleanup virtual FS
  for (const f of filenames) {
    await ffmpeg.deleteFile(f).catch(() => {});
  }
  await ffmpeg.deleteFile("inputs.txt").catch(() => {});
  await ffmpeg.deleteFile("chapters.txt").catch(() => {});
  await ffmpeg.deleteFile("combined.mp3").catch(() => {});
  await ffmpeg.deleteFile("audiobook.m4b").catch(() => {});

  // Trigger download
  const slug = titleVal
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
  updateStatus("Complete");
  setTimeout(hideProgress, 1500);
};

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
clearAllButton.addEventListener("click", () => {
  tracks = [];
  inferredBook = null;
  titleInput.value = "Untitled Audiobook";
  authorInput.value = "Unknown";
  refreshTrackList();
});

dropZone.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragover");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragover");
  if (event.dataTransfer?.files?.length) {
    addFiles(event.dataTransfer.files);
  }
});

fileInput.addEventListener("change", (event) => {
  if (event.target.files?.length) {
    addFiles(event.target.files);
    fileInput.value = "";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!tracks.length) {
    updateStatus("Add MP3 files first");
    return;
  }

  compileButton.disabled = true;

  try {
    await compileM4B();
  } catch (err) {
    console.error(err);
    updateStatus(err.message || "Conversion failed");
    hideProgress();
  } finally {
    compileButton.disabled = !tracks.length;
    setTimeout(() => {
      if (!tracks.length) {
        updateStatus("Idle");
      }
    }, 4000);
  }
});

refreshTrackList();
