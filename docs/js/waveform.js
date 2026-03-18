/**
 * waveform.js
 *
 * Generates mini waveform visualizations for audio files using Web Audio API.
 * Renders to a canvas element for lightweight display in track rows.
 *
 * Peaks are cached by file identity (name + size + lastModified) so that
 * re-rendering the track list doesn't re-decode every audio file.
 */

const CANVAS_WIDTH = 200;
const CANVAS_HEIGHT = 32;
const BAR_WIDTH = 2;
const BAR_GAP = 1;
const NUM_BARS = Math.floor(CANVAS_WIDTH / (BAR_WIDTH + BAR_GAP));

// ---------------------------------------------------------------------------
// Peak cache — avoids re-decoding audio files on every refreshTrackList()
// ---------------------------------------------------------------------------
const peakCache = new Map();

/** Build a stable cache key from a File's identity. */
const fileKey = (file) => `${file.name}|${file.size}|${file.lastModified}`;

/**
 * Decode an audio file and extract peak amplitude data.
 * Results are cached so subsequent calls for the same file return instantly.
 * @param {File|Blob} file
 * @returns {Promise<Float32Array>} Normalized peak values (0-1)
 */
const extractPeaks = async (file) => {
  const key = fileKey(file);

  // Return cached peaks immediately
  const cached = peakCache.get(key);
  if (cached) return cached;

  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new OfflineAudioContext(1, 1, 44100);
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    // Release audio context resources immediately
    await audioCtx.startRendering().catch(() => {});
    if (typeof audioCtx.close === "function") {
      await audioCtx.close().catch(() => {});
    }
  }
  const channelData = audioBuffer.getChannelData(0);
  const samplesPerBar = Math.floor(channelData.length / NUM_BARS);
  const peaks = new Float32Array(NUM_BARS);

  for (let i = 0; i < NUM_BARS; i++) {
    let max = 0;
    const start = i * samplesPerBar;
    const end = Math.min(start + samplesPerBar, channelData.length);
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channelData[j]);
      if (abs > max) max = abs;
    }
    peaks[i] = max;
  }

  peakCache.set(key, peaks);
  return peaks;
};

/**
 * Render peaks data onto a canvas element.
 * @param {HTMLCanvasElement} canvas
 * @param {Float32Array} peaks
 * @param {string} [color="#f0a040"]
 */
const renderPeaks = (canvas, peaks, color = "#f0a040") => {
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.fillStyle = color;

  const mid = CANVAS_HEIGHT / 2;
  for (let i = 0; i < peaks.length; i++) {
    const h = Math.max(1, peaks[i] * (CANVAS_HEIGHT - 2));
    const x = i * (BAR_WIDTH + BAR_GAP);
    ctx.fillRect(x, mid - h / 2, BAR_WIDTH, h);
  }
};

/**
 * Generate and render a waveform for a file.
 * Returns the canvas element.
 * @param {File|Blob} file
 * @returns {Promise<HTMLCanvasElement|null>}
 */
export const createWaveform = async (file) => {
  try {
    const peaks = await extractPeaks(file);
    const canvas = document.createElement("canvas");
    canvas.className = "track-waveform";
    // Read accent color from CSS custom property
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#f0a040";
    renderPeaks(canvas, peaks, accent);
    return canvas;
  } catch {
    return null;
  }
};

/**
 * Remove cached peaks for files that are no longer in the track list.
 * Call this after tracks change to prevent unbounded cache growth.
 * @param {File[]} currentFiles - The files still in the track list
 */
export const pruneWaveformCache = (currentFiles) => {
  const activeKeys = new Set(currentFiles.map(fileKey));
  for (const key of peakCache.keys()) {
    if (!activeKeys.has(key)) peakCache.delete(key);
  }
};
