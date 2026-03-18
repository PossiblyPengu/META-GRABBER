/**
 * compiler.js
 *
 * FFmpeg WASM loading and M4B compilation logic.
 */

// FFmpeg modules are loaded dynamically on first compile to avoid
// downloading ~31 MB of WASM + JS on page load.
let FFmpeg = null;
let fetchFile = null;
let toBlobURL = null;

let ffmpeg = null;
let ffmpegReady = false;
let ffmpegLoadingPromise = null;

/**
 * Load FFmpeg WASM (downloads ~31 MB on first run).
 * @param {{ updateStatus: Function, showProgress: Function, hideProgress: Function, setIdle: Function }} ui
 */
export const loadFFmpeg = async (ui) => {
  if (ffmpegReady) return;
  if (ffmpegLoadingPromise) { await ffmpegLoadingPromise; return; }

  ffmpegLoadingPromise = (async () => {
    ui.updateStatus("Loading FFmpeg...");
    ui.showProgress(5);

    // Lazy-load FFmpeg modules only when needed
    if (!FFmpeg) {
      const [ffmpegMod, utilMod] = await Promise.all([
        import("https://esm.sh/@ffmpeg/ffmpeg@0.12.10"),
        import("https://esm.sh/@ffmpeg/util@0.12.1"),
      ]);
      FFmpeg = ffmpegMod.FFmpeg;
      fetchFile = utilMod.fetchFile;
      toBlobURL = utilMod.toBlobURL;
    }

    ui.showProgress(10);
    ffmpeg = new FFmpeg();
    ffmpeg.on("progress", ({ progress }) => ui.showProgress(20 + progress * 70));
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";
    try {
      const [coreURL, wasmURL, workerURL] = await Promise.all([
        toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
        toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, "text/javascript"),
      ]);
      await ffmpeg.load({ coreURL, wasmURL, workerURL });
      ffmpegReady = true;
      ui.hideProgress();
      ui.setIdle("FFmpeg ready");
    } catch (err) {
      console.error("FFmpeg failed to load", err);
      ui.hideProgress();
      ui.updateStatus("FFmpeg failed to load", "error");
      throw err;
    } finally {
      ffmpegLoadingPromise = null;
    }
  })();
  return ffmpegLoadingPromise;
};

/**
 * Compile tracks into an M4B audiobook.
 * @param {object} opts
 * @param {Array} opts.tracks
 * @param {Blob|null} opts.coverFile
 * @param {object} opts.formValues - { title, author, year, genre, narrator, description }
 * @param {string} [opts.bitrate="96k"] - Audio bitrate (e.g. "64k", "96k", "128k", "192k")
 * @param {Function} [opts.onChapterProgress] - Called with (chapterIndex, totalChapters, phase) for per-chapter updates
 * @param {{ updateStatus: Function, showProgress: Function, hideProgress: Function, setIdle: Function }} opts.ui
 * @returns {Promise<{ blob: Blob, filename: string }>}
 */
export const compileM4B = async ({ tracks, coverFile, formValues, bitrate = "96k", onChapterProgress, ui }) => {
  await loadFFmpeg(ui);

  // eslint-disable-next-line no-control-regex
  const sanitizeMeta = (s) => s.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  const titleVal = sanitizeMeta(formValues.title) || "Untitled Audiobook";
  const authorVal = sanitizeMeta(formValues.author) || "Unknown";
  const yearVal = sanitizeMeta(formValues.year);
  const genreVal = sanitizeMeta(formValues.genre);
  const descVal = sanitizeMeta(formValues.description);

  ui.updateStatus("Reading files...");
  ui.showProgress(5);

  const filenames = [];
  for (let i = 0; i < tracks.length; i++) {
    const fname = `input_${String(i).padStart(3, "0")}.mp3`;
    filenames.push(fname);
    await ffmpeg.writeFile(fname, await fetchFile(tracks[i].file));
    if (onChapterProgress) onChapterProgress(i, tracks.length, "reading");
    ui.showProgress(5 + ((i + 1) / tracks.length) * 10);
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

  ui.updateStatus("Concatenating...");
  ui.showProgress(18);
  await ffmpeg.exec(["-y", "-f", "concat", "-safe", "0", "-i", "inputs.txt", "-c", "copy", "combined.mp3"]);

  ui.updateStatus("Converting to M4B...");
  ui.showProgress(25);

  const args = ["-y", "-i", "combined.mp3", "-i", "chapters.txt"];
  if (hasCover) {
    args.push("-i", "cover.jpg", "-map", "0:a", "-map", "2:v");
    args.push("-c:v", "mjpeg", "-disposition:v", "attached_pic");
  }
  args.push("-map_metadata", "1", "-map_chapters", "1", "-c:a", "aac", "-b:a", bitrate, "-movflags", "+faststart", "-f", "mp4", "audiobook.m4b");
  if (!hasCover) args.splice(args.indexOf("-f"), 0, "-vn");
  await ffmpeg.exec(args);

  ui.updateStatus("Preparing download...");
  ui.showProgress(95);
  const data = await ffmpeg.readFile("audiobook.m4b");

  // Cleanup
  const cleanup = [...filenames, "inputs.txt", "chapters.txt", "combined.mp3", "audiobook.m4b"];
  if (hasCover) cleanup.push("cover.jpg");
  for (const f of cleanup) {
    await ffmpeg.deleteFile(f).catch((err) => console.warn(`cleanup: failed to delete ${f}`, err));
  }

  const slug = titleVal.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "audiobook";
  const blob = new Blob([data.buffer], { type: "audio/x-m4b" });
  const filename = `${slug}.m4b`;

  return { blob, filename };
};
