/**
 * book-parser.js
 *
 * Infers audiobook title, author, and chapter names from a combination of:
 *   1. Filename patterns (common audiobook naming conventions)
 *   2. ID3 tag consensus across all tracks
 *   3. Smart chapter name cleanup
 */

// ---------------------------------------------------------------------------
// 1. Filename pattern parser
// ---------------------------------------------------------------------------

/**
 * Common audiobook filename patterns (ordered by specificity):
 *   "Author - Title - Chapter 01.mp3"
 *   "Author - Title - 01.mp3"
 *   "Title - Chapter 01.mp3"
 *   "Title - 01 - Chapter Name.mp3"
 *   "01 - Chapter Name.mp3"
 *   "Title_Chapter_01.mp3"
 *   "Title Ch01.mp3"
 *   "01.mp3" / "Chapter 01.mp3"
 */
const FILENAME_PATTERNS = [
  // Author - Title - Chapter 01  OR  Author - Title - 01 - Chapter Name
  {
    re: /^(.+?)\s*[-–—]\s*(.+?)\s*[-–—]\s*(?:(?:ch(?:apter)?\.?\s*)?(\d+)\s*[-–—.]?\s*(.+?))?\.mp3$/i,
    extract: (m) => ({
      author: m[1].trim(),
      title: m[2].trim(),
      chapterNum: m[3] ? parseInt(m[3], 10) : null,
      chapterName: m[4]?.trim() || null,
    }),
  },
  // Title - 01 - Chapter Name  OR  Title - Chapter 01
  {
    re: /^(.+?)\s*[-–—]\s*(?:ch(?:apter)?\.?\s*)?(\d+)\s*(?:[-–—.]\s*(.+?))?\.mp3$/i,
    extract: (m) => ({
      author: null,
      title: m[1].trim(),
      chapterNum: parseInt(m[2], 10),
      chapterName: m[3]?.trim() || null,
    }),
  },
  // Title Ch01.mp3  OR  Title Chapter01.mp3
  {
    re: /^(.+?)\s+ch(?:apter)?\.?\s*(\d+)\.mp3$/i,
    extract: (m) => ({
      author: null,
      title: m[1].trim(),
      chapterNum: parseInt(m[2], 10),
      chapterName: null,
    }),
  },
  // 01 - Chapter Name.mp3
  {
    re: /^(\d+)\s*[-–—.]\s*(.+?)\.mp3$/i,
    extract: (m) => ({
      author: null,
      title: null,
      chapterNum: parseInt(m[1], 10),
      chapterName: m[2].trim(),
    }),
  },
  // Chapter 01.mp3  OR  Ch01.mp3
  {
    re: /^ch(?:apter)?\.?\s*(\d+)\.mp3$/i,
    extract: (m) => ({
      author: null,
      title: null,
      chapterNum: parseInt(m[1], 10),
      chapterName: null,
    }),
  },
  // Just a number: 01.mp3
  {
    re: /^(\d+)\.mp3$/i,
    extract: (m) => ({
      author: null,
      title: null,
      chapterNum: parseInt(m[1], 10),
      chapterName: null,
    }),
  },
];

/**
 * Try to find the common directory/prefix across filenames.
 * Many audiobooks are in a folder like "Author - Title/" and the files
 * are just "01.mp3", "02.mp3", etc.  We can't see the folder from the
 * File API, but we can look for a shared prefix.
 */
const findCommonPrefix = (names) => {
  if (names.length < 2) return "";
  const sorted = [...names].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  let i = 0;
  while (i < first.length && first[i] === last[i]) i++;
  const prefix = first.slice(0, i);
  // Trim to last separator
  const sepIdx = Math.max(prefix.lastIndexOf("-"), prefix.lastIndexOf("_"), prefix.lastIndexOf(" "));
  return sepIdx > 0 ? prefix.slice(0, sepIdx).trim() : "";
};

/**
 * Parse a single filename and return extracted parts.
 */
export const parseFilename = (filename) => {
  const basename = filename.replace(/^.*[\\/]/, ""); // strip path
  for (const pattern of FILENAME_PATTERNS) {
    const m = basename.match(pattern.re);
    if (m) return pattern.extract(m);
  }
  // Fallback: use filename without extension as chapter name
  return {
    author: null,
    title: null,
    chapterNum: null,
    chapterName: basename.replace(/\.mp3$/i, "").replace(/[_]/g, " ").trim(),
  };
};

/**
 * Parse all filenames and return aggregated book info.
 */
export const parseFilenames = (filenames) => {
  const parsed = filenames.map(parseFilename);
  const titles = parsed.map((p) => p.title).filter(Boolean);
  const authors = parsed.map((p) => p.author).filter(Boolean);

  // Also try common prefix if no title was found
  let prefixTitle = null;
  if (!titles.length) {
    const prefix = findCommonPrefix(filenames);
    if (prefix.length > 2) prefixTitle = cleanupString(prefix);
  }

  return {
    title: mostCommon(titles) || prefixTitle,
    author: mostCommon(authors),
    chapters: parsed,
  };
};

// ---------------------------------------------------------------------------
// 2. ID3 tag consensus
// ---------------------------------------------------------------------------

/**
 * Given an array of track metadata objects (from extractMetadata),
 * find the most common album/artist across all tracks.
 */
export const id3Consensus = (metadataList) => {
  const albums = metadataList.map((m) => m?.album).filter(Boolean);
  const artists = metadataList.map((m) => m?.artist).filter(Boolean);
  const titles = metadataList.map((m) => m?.title).filter(Boolean);

  return {
    album: mostCommon(albums),
    artist: mostCommon(artists),
    // Individual track titles (for chapter naming)
    trackTitles: titles,
  };
};

// ---------------------------------------------------------------------------
// 3. Smart chapter naming
// ---------------------------------------------------------------------------

const CHAPTER_NOISE = [
  /^\d+\s*[-–—.)\]]\s*/,     // leading "01 - ", "01. ", "01) "
  /^ch(?:apter)?\.?\s*/i,     // leading "Chapter ", "Ch. ", "Ch"
  /^track\s*\d*\s*[-–—.]?\s*/i, // leading "Track 01 - "
  /^part\s+/i,                 // leading "Part "
];

/**
 * Clean a raw chapter string into a presentable name.
 */
const cleanChapterName = (raw) => {
  if (!raw) return null;
  let cleaned = raw.trim();
  // Remove common noise prefixes
  for (const noise of CHAPTER_NOISE) {
    cleaned = cleaned.replace(noise, "");
  }
  // Remove trailing track numbers like " (1)" or " [01]"
  cleaned = cleaned.replace(/\s*[(\[]\d+[)\]]\s*$/, "");
  // Collapse underscores / hyphens used as separators
  cleaned = cleaned.replace(/[_]+/g, " ").trim();
  // Title-case if all lowercase
  if (cleaned === cleaned.toLowerCase() && cleaned.length > 0) {
    cleaned = cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return cleaned || null;
};

/**
 * Build final chapter names by merging filename info, ID3 titles,
 * and falling back to "Chapter N".
 *
 * @param {Array} filenameParsed - from parseFilenames().chapters
 * @param {Array} metadataList  - from extractMetadata() per track
 * @returns {Array<string>} chapter names in order
 */
export const buildChapterNames = (filenameParsed, metadataList) => {
  return filenameParsed.map((fp, i) => {
    const meta = metadataList[i];
    const num = fp.chapterNum ?? i + 1;

    // Priority: ID3 title > filename chapter name > generic
    const rawName =
      cleanChapterName(meta?.title) ||
      cleanChapterName(fp.chapterName) ||
      null;

    if (rawName) {
      // Prepend chapter number if not already in the name
      const hasNum = /^\d/.test(rawName) || /chapter\s*\d/i.test(rawName);
      return hasNum ? rawName : `Chapter ${num}: ${rawName}`;
    }

    return `Chapter ${num}`;
  });
};

// ---------------------------------------------------------------------------
// 4. Combined inference
// ---------------------------------------------------------------------------

/**
 * Main entry: given files (with .name) and their metadata, return the
 * best guess for the book.
 *
 * @param {Array<{name: string}>} files
 * @param {Array<object>} metadataList - ID3/audio metadata per file
 * @returns {{ title: string, author: string, chapters: string[] }}
 */
export const inferBook = (files, metadataList) => {
  const filenames = files.map((f) => f.name || f.file?.name || "");
  const fnResult = parseFilenames(filenames);
  const id3Result = id3Consensus(metadataList);
  const chapters = buildChapterNames(fnResult.chapters, metadataList);

  // Title priority: ID3 album > filename title > first ID3 track title
  const title =
    id3Result.album ||
    fnResult.title ||
    (id3Result.trackTitles.length ? guessBookFromTrackTitles(id3Result.trackTitles) : null);

  // Author priority: ID3 artist > filename author
  const author = id3Result.artist || fnResult.author;

  return { title, author, chapters };
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const mostCommon = (arr) => {
  if (!arr.length) return null;
  const counts = {};
  for (const val of arr) {
    const key = val.trim().toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
  }
  let best = null;
  let bestCount = 0;
  // Return the original-cased version of the most common
  const originals = {};
  for (const val of arr) {
    originals[val.trim().toLowerCase()] = val.trim();
  }
  for (const [key, count] of Object.entries(counts)) {
    if (count > bestCount) {
      bestCount = count;
      best = originals[key];
    }
  }
  return best;
};

const cleanupString = (str) => {
  return str
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

/**
 * If track titles share a common book name prefix, extract it.
 * e.g. ["The Hobbit - Ch1", "The Hobbit - Ch2"] -> "The Hobbit"
 */
const guessBookFromTrackTitles = (titles) => {
  if (titles.length < 2) return null;
  // Look for a common prefix before a separator
  const prefixes = titles.map((t) => {
    const sepMatch = t.match(/^(.+?)\s*[-–—:]\s*/);
    return sepMatch ? sepMatch[1].trim() : null;
  }).filter(Boolean);
  if (prefixes.length >= titles.length * 0.6) {
    return mostCommon(prefixes);
  }
  return null;
};
