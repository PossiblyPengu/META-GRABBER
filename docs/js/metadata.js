/**
 * metadata.js
 *
 * Audio tag reading and duration/bitrate extraction.
 *
 * - MP3: jsmediatags (ID3) + HTMLAudioElement for duration
 * - All other formats (M4A, M4B, FLAC, OGG, OPUS, WAV, AAC):
 *   music-metadata-browser, which returns tags + duration in one pass.
 */

// ---------------------------------------------------------------------------
// Lazy loaders
// ---------------------------------------------------------------------------

let jsmediatagsLoadPromise = null;

const ensureJsmediatags = () => {
  if (window.jsmediatags) return Promise.resolve();
  if (jsmediatagsLoadPromise) return jsmediatagsLoadPromise;
  jsmediatagsLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.7/jsmediatags.min.js";
    script.onload = () => resolve();
    script.onerror = () => {
      jsmediatagsLoadPromise = null;
      reject(new Error("jsmediatags failed to load"));
    };
    document.head.appendChild(script);
  });
  return jsmediatagsLoadPromise;
};

let musicMetaPromise = null;
const loadMusicMetadata = () => {
  if (!musicMetaPromise) {
    musicMetaPromise = import("https://esm.sh/music-metadata-browser@2.5.9?bundle");
  }
  return musicMetaPromise;
};

// ---------------------------------------------------------------------------
// MP3 path — jsmediatags + HTMLAudioElement
// ---------------------------------------------------------------------------

const readID3 = (file) =>
  new Promise((resolve) => {
    ensureJsmediatags()
      .then(() => parseTag(file, resolve))
      .catch(() => resolve(null));
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

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      audio.src = "";
      resolve(result);
    };
    const timer = setTimeout(() => finish({ duration: 0, bitrate: 0 }), 10000);

    audio.addEventListener(
      "loadedmetadata",
      () => {
        const duration = audio.duration || 0;
        const bitrate =
          duration > 0 ? Math.round((file.size * 8) / duration / 1000) : 0;
        finish({ duration: Math.round(duration * 100) / 100, bitrate });
      },
      { once: true }
    );
    audio.addEventListener(
      "error",
      () => finish({ duration: 0, bitrate: 0 }),
      { once: true }
    );
  });

// ---------------------------------------------------------------------------
// Non-MP3 path — music-metadata-browser (handles M4A, M4B, FLAC, OGG, WAV…)
// ---------------------------------------------------------------------------

const readMusicMetadata = async (file) => {
  try {
    const { parseBlob } = await loadMusicMetadata();
    const metadata = await parseBlob(file);
    const common = metadata.common || {};
    const fmt = metadata.format || {};

    const picRaw = Array.isArray(common.picture) ? common.picture[0] : null;
    const picture = picRaw
      ? new Blob([picRaw.data], { type: picRaw.format || "image/jpeg" })
      : null;

    const description =
      (Array.isArray(common.comment) ? common.comment.join("\n").trim() : null) ||
      (typeof common.comment === "string" ? common.comment.trim() : null) ||
      null;

    const year = common.year
      ? String(common.year)
      : common.date
        ? String(common.date).slice(0, 4)
        : null;

    const trackNo = common.track?.no != null ? String(common.track.no) : null;

    const duration = fmt.duration != null
      ? Math.round(fmt.duration * 100) / 100
      : 0;
    const bitrate = fmt.bitrate != null
      ? Math.round(fmt.bitrate / 1000)
      : (duration > 0 ? Math.round((file.size * 8) / duration / 1000) : 0);

    return {
      title: common.title || null,
      artist: common.artist || common.albumartist || (Array.isArray(common.artists) ? common.artists[0] : null) || null,
      album: common.album || null,
      year,
      track: trackNo,
      genre: Array.isArray(common.genre) ? common.genre[0] || null : common.genre || null,
      description,
      picture,
      duration,
      bitrate,
    };
  } catch (err) {
    console.warn("music-metadata-browser failed for", file.name, err);
    // Fall back to duration-only via HTMLAudioElement
    const audioInfo = await readAudioInfo(file);
    return {
      title: null, artist: null, album: null, year: null, track: null,
      genre: null, description: null, picture: null,
      duration: audioInfo.duration,
      bitrate: audioInfo.bitrate,
    };
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const isMp3 = (file) =>
  file?.type === "audio/mpeg" || file?.name?.toLowerCase().endsWith(".mp3");

/**
 * Extract tags and audio info from any supported audio file.
 * @param {File} file
 * @returns {Promise<{title, artist, album, year, track, genre, description, picture, duration, bitrate}>}
 */
export const extractMetadata = async (file) => {
  if (isMp3(file)) {
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
  }

  // All other formats: music-metadata-browser handles tags + duration together
  return readMusicMetadata(file);
};
