/**
 * book-lookup.js
 *
 * Searches Google Books and Open Library for book metadata + cover art.
 * Returns a unified result format from both sources.
 */

/**
 * @typedef {Object} BookResult
 * @property {string} title
 * @property {string|null} author
 * @property {string|null} year
 * @property {string|null} genre
 * @property {string|null} description
 * @property {string|null} coverUrl - URL to a cover image
 * @property {string|null} isbn
 * @property {string|null} publisher
 * @property {string} source - "google" or "openlibrary"
 */

// ---------------------------------------------------------------------------
// Google Books API
// ---------------------------------------------------------------------------

const searchGoogleBooks = async (query, maxResults = 5) => {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=${maxResults}&printType=books`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.items?.length) return [];

    return data.items.map((item) => {
      const v = item.volumeInfo || {};
      const isbn = v.industryIdentifiers?.find(
        (id) => id.type === "ISBN_13" || id.type === "ISBN_10"
      );
      // Prefer larger thumbnail
      let coverUrl = null;
      if (v.imageLinks) {
        coverUrl =
          v.imageLinks.thumbnail ||
          v.imageLinks.smallThumbnail ||
          null;
        // Google returns http URLs; upgrade to https and request larger size
        if (coverUrl) {
          coverUrl = coverUrl.replace(/^http:/, "https:");
          coverUrl = coverUrl.replace(/&edge=curl/i, "");
          coverUrl = coverUrl.replace(/zoom=\d/, "zoom=1");
        }
      }
      // Extract chapter names from table of contents if available
      let chapters = null;
      if (v.tableOfContents?.length) {
        chapters = v.tableOfContents.map((ch) => ch.title || ch);
      }

      return {
        title: v.title || "Unknown",
        subtitle: v.subtitle || null,
        author: v.authors?.join(", ") || null,
        year: v.publishedDate?.slice(0, 4) || null,
        genre: v.categories?.join(", ") || null,
        description: v.description || null,
        coverUrl,
        isbn: isbn?.identifier || null,
        publisher: v.publisher || null,
        chapters,
        volumeId: item.id,
        source: "google",
      };
    });
  } catch (err) {
    console.warn("Google Books search failed:", err);
    return [];
  }
};

// ---------------------------------------------------------------------------
// Open Library API
// ---------------------------------------------------------------------------

const searchOpenLibrary = async (query, maxResults = 5) => {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${maxResults}&fields=key,title,author_name,first_publish_year,subject,isbn,publisher,cover_i`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.docs?.length) return [];

    return data.docs.map((doc) => {
      const coverId = doc.cover_i;
      const coverUrl = coverId
        ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
        : null;
      return {
        title: doc.title || "Unknown",
        subtitle: null,
        author: doc.author_name?.join(", ") || null,
        year: doc.first_publish_year ? String(doc.first_publish_year) : null,
        genre: doc.subject?.slice(0, 3).join(", ") || null,
        description: null,
        coverUrl,
        isbn: doc.isbn?.[0] || null,
        publisher: doc.publisher?.[0] || null,
        chapters: null,
        workKey: doc.key || null,
        source: "openlibrary",
      };
    });
  } catch (err) {
    console.warn("Open Library search failed:", err);
    return [];
  }
};

// ---------------------------------------------------------------------------
// Combined search
// ---------------------------------------------------------------------------

/**
 * Search both Google Books and Open Library, deduplicate, and return
 * results sorted by relevance (Google first, then Open Library).
 *
 * @param {string} query - Search query (e.g. "The Hobbit Tolkien")
 * @param {number} maxResults - Max results per source
 * @returns {Promise<BookResult[]>}
 */
export const searchBooks = async (query, maxResults = 5) => {
  if (!query || query.trim().length < 2) return [];

  const [googleResults, olResults] = await Promise.all([
    searchGoogleBooks(query, maxResults),
    searchOpenLibrary(query, maxResults),
  ]);

  // Deduplicate: if a Google result has the same title+author as an OL result, skip the OL one
  const seen = new Set();
  for (const r of googleResults) {
    seen.add(`${r.title.toLowerCase()}|${(r.author || "").toLowerCase()}`);
  }

  const uniqueOL = olResults.filter((r) => {
    const key = `${r.title.toLowerCase()}|${(r.author || "").toLowerCase()}`;
    return !seen.has(key);
  });

  return [...googleResults, ...uniqueOL];
};

/**
 * Fetch chapter names for a specific book result.
 * For Google Books, uses the volumeId to get full details.
 * For Open Library, uses the work key to get the TOC.
 *
 * @param {BookResult} result
 * @returns {Promise<string[]|null>}
 */
export const fetchChapters = async (result) => {
  // If chapters were already included in search results
  if (result.chapters?.length) return result.chapters;

  if (result.source === "google" && result.volumeId) {
    try {
      const resp = await fetch(
        `https://www.googleapis.com/books/v1/volumes/${result.volumeId}`
      );
      if (resp.ok) {
        const data = await resp.json();
        const toc = data.volumeInfo?.tableOfContents;
        if (toc?.length) return toc.map((ch) => ch.title || ch);
      }
    } catch { /* ignore */ }
  }

  if (result.source === "openlibrary" && result.workKey) {
    try {
      const resp = await fetch(
        `https://openlibrary.org${result.workKey}.json`
      );
      if (resp.ok) {
        const data = await resp.json();
        if (data.table_of_contents?.length) {
          return data.table_of_contents.map(
            (ch) => ch.title || ch.label || String(ch)
          );
        }
      }
    } catch { /* ignore */ }
  }

  return null;
};

/**
 * Fetch a cover image as a Blob (for embedding into the M4B).
 * Tries direct fetch first. If CORS blocks it, renders through
 * a canvas to extract pixel data as a JPEG blob.
 *
 * @param {string} url
 * @returns {Promise<Blob|null>}
 */
export const fetchCoverBlob = async (url) => {
  if (!url) return null;

  // Try direct fetch first
  try {
    const resp = await fetch(url, { mode: "cors" });
    if (resp.ok) {
      const blob = await resp.blob();
      if (blob.size > 0) return blob;
    }
  } catch { /* CORS blocked, try canvas fallback */ }

  // Canvas fallback: load image with crossOrigin, draw to canvas, export
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(
          (blob) => resolve(blob),
          "image/jpeg",
          0.92
        );
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
};
