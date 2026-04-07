const SUPPORTED_EXTENSIONS = ["m4b", "epub", "pdf"];
const EPUB_MIME = "application/epub+zip";

const fileTypeMatches = (file, typePrefix) => file.type?.startsWith(typePrefix);

const decodeXmlEntities = (text) =>
  text
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

const stripHtml = (text) => text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const extractAttributes = (tagSource) => {
  const attrRegex = /(\w[\w:-]*)\s*=\s*("[^"]*"|'[^']*')/g;
  const attrs = {};
  let match;
  while ((match = attrRegex.exec(tagSource))) {
    const [, name, rawValue] = match;
    attrs[name.toLowerCase()] = rawValue.slice(1, -1);
  }
  return attrs;
};

const readTag = (xml, tagName) => {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i");
  const match = xml.match(regex);
  if (!match) return null;
  return decodeXmlEntities(match[1].trim());
};

const findCoverMeta = (xml) => {
  const match = xml.match(/<meta[^>]+name=["']cover["'][^>]*content=["']([^"']+)["'][^>]*>/i);
  return match ? match[1] : null;
};

const buildManifestIndex = (xml) => {
  const entries = [...xml.matchAll(/<item\b[^>]*>/gi)];
  const index = new Map();
  for (const entry of entries) {
    const attrs = extractAttributes(entry[0]);
    if (!attrs.id) continue;
    index.set(attrs.id, {
      href: attrs.href || "",
      mediaType: attrs["media-type"] || "",
    });
  }
  return index;
};

export const parseOpfMetadata = (opfText) => {
  if (!opfText) return { title: null, author: null, description: null, manifest: new Map(), coverId: null };
  const metadataSectionMatch = opfText.match(/<metadata[\s\S]*?<\/metadata>/i);
  const metadataSection = metadataSectionMatch ? metadataSectionMatch[0] : opfText;
  const title = readTag(metadataSection, "dc:title") || readTag(metadataSection, "title");
  const creator = readTag(metadataSection, "dc:creator") || readTag(metadataSection, "creator");
  const descriptionRaw = readTag(metadataSection, "dc:description") || readTag(metadataSection, "description") || null;
  const description = descriptionRaw ? stripHtml(descriptionRaw) : null;
  const coverId = findCoverMeta(metadataSection);
  const manifestMatch = opfText.match(/<manifest[\s\S]*?<\/manifest>/i);
  const manifestXml = manifestMatch ? manifestMatch[0] : "";
  const manifest = buildManifestIndex(manifestXml);
  return {
    title: title || null,
    author: creator || null,
    description: description || null,
    manifest,
    coverId: coverId || null,
  };
};

const loadMusicMetadata = (() => {
  let promise;
  return () => {
    if (!promise) {
      promise = import("https://esm.sh/music-metadata-browser@2.5.9?bundle");
    }
    return promise;
  };
})();

const loadJSZip = (() => {
  let promise;
  return () => {
    if (!promise) {
      promise = import("https://esm.sh/jszip@3.10.1").then((mod) => mod.default || mod);
    }
    return promise;
  };
})();

const loadPdfJs = (() => {
  let promise;
  return () => {
    if (!promise) {
      promise = import("https://esm.sh/pdfjs-dist@4.6.82?bundle").then((pdfjsLib) => {
        if (pdfjsLib.GlobalWorkerOptions) {
          pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.js";
        }
        return pdfjsLib;
      });
    }
    return promise;
  };
})();

const readM4BFile = async (file) => {
  const { parseBlob } = await loadMusicMetadata();
  const metadata = await parseBlob(file);
  const common = metadata.common || {};
  const picture = Array.isArray(common.picture) ? common.picture[0] : null;
  const coverBlob = picture ? new Blob([picture.data], { type: picture.format || "image/jpeg" }) : null;

  // Extract embedded chapter list if present (music-metadata-browser exposes
  // chapter markers as common.chapter[] — each entry has a .title property)
  let chapters = null;
  const rawChapters = common.chapter || common.chapters;
  if (Array.isArray(rawChapters) && rawChapters.length > 0) {
    const titles = rawChapters.map((c) => c.title || c.name || null).filter(Boolean);
    if (titles.length) chapters = titles;
  }

  return {
    title: common.album || common.title || null,
    author: common.artist || common.artists?.[0] || null,
    description: (Array.isArray(common.comment) ? common.comment.join("\n").trim() : (typeof common.comment === "string" ? common.comment.trim() : null)) || null,
    narrator: common.performer || null,
    coverBlob,
    chapters,
  };
};

const readEpubFile = async (file) => {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const containerEntry = zip.file("META-INF/container.xml");
  if (!containerEntry) throw new Error("Missing EPUB container");
  const containerXml = await containerEntry.async("string");
  const rootMatch = containerXml.match(/full-path=["']([^"']+)["']/i);
  const rootPath = rootMatch ? rootMatch[1] : null;
  if (!rootPath) throw new Error("EPUB root file not found");
  const opfEntry = zip.file(rootPath);
  if (!opfEntry) throw new Error("EPUB package file missing");
  const opfText = await opfEntry.async("string");
  const opfMeta = parseOpfMetadata(opfText);
  const baseDir = rootPath.includes("/") ? rootPath.slice(0, rootPath.lastIndexOf("/") + 1) : "";
  let coverBlob = null;
  if (opfMeta.coverId) {
    const coverItem = opfMeta.manifest.get(opfMeta.coverId);
    if (coverItem) {
      const coverPath = `${baseDir}${coverItem.href}`.replace(/\\/g, "/");
      const coverFile = zip.file(coverPath);
      if (coverFile) {
        coverBlob = await coverFile.async("blob");
      }
    }
  }
  if (!coverBlob) {
    for (const item of opfMeta.manifest.values()) {
      if (item.mediaType?.startsWith("image/")) {
        const imgPath = `${baseDir}${item.href}`.replace(/\\/g, "/");
        const imgFile = zip.file(imgPath);
        if (imgFile) {
          coverBlob = await imgFile.async("blob");
          break;
        }
      }
    }
  }
  return {
    title: opfMeta.title,
    author: opfMeta.author,
    description: opfMeta.description,
    coverBlob,
  };
};

const renderPdfCover = async (pdfjsLib, pdf) => {
  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    const renderTask = page.render({ canvasContext: context, viewport });
    await renderTask.promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    return blob || null;
  } catch (err) {
    console.warn("PDF cover render failed", err);
    return null;
  }
};

const readPdfFile = async (file) => {
  const pdfjsLib = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;
  const meta = await pdf.getMetadata().catch(() => null);
  const info = meta?.info || {};
  const metadataMap = meta?.metadata || null;
  const title = info.Title || metadataMap?.get?.("dc:title") || null;
  const author = info.Author || metadataMap?.get?.("dc:creator") || null;
  const description = metadataMap?.get?.("dc:description") || null;
  const coverBlob = typeof document !== "undefined" ? await renderPdfCover(pdfjsLib, pdf) : null;
  pdf.cleanup();
  pdf.destroy();
  return { title, author, description, coverBlob };
};

const extensionFromFile = (file) => {
  const match = file.name?.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : "";
};

export const isSupportedBookFile = (file) => {
  const ext = extensionFromFile(file);
  if (SUPPORTED_EXTENSIONS.includes(ext)) return true;
  if (file.type === EPUB_MIME) return true;
  if (fileTypeMatches(file, "audio/")) {
    return ext === "m4b" || file.type === "audio/x-m4b";
  }
  if (file.type === "application/pdf") return true;
  return false;
};

export const extractMetadataFromBookFile = async (file) => {
  const ext = extensionFromFile(file);
  if (ext === "m4b" || file.type === "audio/x-m4b" || fileTypeMatches(file, "audio/")) {
    return readM4BFile(file);
  }
  if (ext === "epub" || file.type === EPUB_MIME) {
    return readEpubFile(file);
  }
  if (ext === "pdf" || file.type === "application/pdf") {
    return readPdfFile(file);
  }
  throw new Error("Unsupported file type");
};

export const supportedBookFileGlobs = SUPPORTED_EXTENSIONS.map((ext) => `*.${ext}`);
