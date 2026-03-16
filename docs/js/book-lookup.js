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
      return {
        title: v.title || "Unknown",
        author: v.authors?.join(", ") || null,
        year: v.publishedDate?.slice(0, 4) || null,
        genre: v.categories?.join(", ") || null,
        description: v.description || null,
        coverUrl,
        isbn: isbn?.identifier || null,
        publisher: v.publisher || null,
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
        author: doc.author_name?.join(", ") || null,
        year: doc.first_publish_year ? String(doc.first_publish_year) : null,
        genre: doc.subject?.slice(0, 3).join(", ") || null,
        description: null, // Open Library search doesn't return descriptions inline
        coverUrl,
        isbn: doc.isbn?.[0] || null,
        publisher: doc.publisher?.[0] || null,
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
 * Fetch a cover image as a Blob (for embedding into the M4B).
 * Uses a proxy-free approach; falls back gracefully.
 *
 * @param {string} url
 * @returns {Promise<Blob|null>}
 */
export const fetchCoverBlob = async (url) => {
  if (!url) return null;
  try {
    const resp = await fetch(url, { mode: "cors" });
    if (!resp.ok) return null;
    return await resp.blob();
  } catch {
    // CORS blocked — try no-cors (can't read body, but some CDNs allow it)
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      return await resp.blob();
    } catch {
      return null;
    }
  }
};
