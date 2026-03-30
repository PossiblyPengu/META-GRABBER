// Helpers
const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
/**
 * drive-ui.js
 *
 * Google Drive file picker UI, download progress, and import/export handlers.
 */


import { ensureDriveAuth, listFolder, downloadFiles, uploadToDrive } from "./gdrive.js";

// DOM references
const $ = (id) => document.getElementById(id);
const gdrivePickerModal = $("gdrive-picker-modal");
const gdrivePickerClose = $("gdrive-picker-close");
const gdrivePickerCancel = $("gdrive-picker-cancel");
const gdrivePickerSelect = $("gdrive-picker-select");
const gdriveFileList = $("gdrive-file-list");
const gdriveBreadcrumb = $("gdrive-breadcrumb");
const gdriveSelectedCount = $("gdrive-selected-count");
const gdriveSelectAll = $("gdrive-select-all");
const gdriveSelectAllLabel = gdriveSelectAll.closest("label");
const gdrivePickerFooter = $("gdrive-picker-footer");
const gdriveDownloadProgress = $("gdrive-download-progress");
const gdriveDownloadList = $("gdrive-download-list");

// State
const pickerSelected = new Map();
let pickerResolve = null;
let pickerBreadcrumbs = [{ id: "root", name: "My Drive" }];
let pickerCurrentFiles = [];
export let gdriveDownloading = false;

// ---------------------------------------------------------------------------
/**
 * Import files from Google Drive. Returns File[] to be added to tracks.
 * @param {{ updateStatus: Function, setIdle: Function }} ui
 * @returns {Promise<File[]>}
 */

// ---------------------------------------------------------------------------
// Folder navigation
// ---------------------------------------------------------------------------
const navigateToFolder = async (folderId) => {
  gdriveFileList.textContent = "";
  const loadingDiv = document.createElement("div");
  loadingDiv.className = "gdrive-picker-empty";
  loadingDiv.textContent = "Loading...";
  gdriveFileList.appendChild(loadingDiv);
  gdriveSelectAll.checked = false;
  gdriveSelectAllLabel.hidden = true;
  pickerCurrentFiles = [];
  renderBreadcrumbs();

  try {
    const files = await listFolder(folderId);
    gdriveFileList.textContent = "";
    pickerCurrentFiles = files.filter((f) => f.mimeType !== "application/vnd.google-apps.folder");

    if (!files.length) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "gdrive-picker-empty";
      emptyDiv.textContent = "No MP3 files or folders here";
      gdriveFileList.appendChild(emptyDiv);
      return;
    }

    gdriveSelectAllLabel.hidden = pickerCurrentFiles.length === 0;

    for (const file of files) {
      const isFolder = file.mimeType === "application/vnd.google-apps.folder";
      const row = document.createElement("div");
      row.className = "gdrive-file-row";

      if (isFolder) {
        const iconSpan = document.createElement("span");
        iconSpan.className = "gdrive-file-icon gdrive-folder-icon";
        const folderSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        folderSvg.setAttribute("width", "18"); folderSvg.setAttribute("height", "18");
        folderSvg.setAttribute("viewBox", "0 0 24 24"); folderSvg.setAttribute("fill", "none");
        folderSvg.setAttribute("stroke", "currentColor"); folderSvg.setAttribute("stroke-width", "2");
        folderSvg.setAttribute("stroke-linecap", "round"); folderSvg.setAttribute("stroke-linejoin", "round");
        folderSvg.innerHTML = '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>';
        iconSpan.appendChild(folderSvg);
        const nameSpan = document.createElement("span");
        nameSpan.className = "gdrive-file-name";
        nameSpan.textContent = file.name;
        row.append(iconSpan, nameSpan);
        row.addEventListener("click", () => {
          pickerBreadcrumbs.push({ id: file.id, name: file.name });
          navigateToFolder(file.id);
        });
      } else {
        const checked = pickerSelected.has(file.id);
        const size = file.size ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : "";
        const checkLabel = document.createElement("label");
        checkLabel.className = "gdrive-file-check";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = checked;
        checkLabel.appendChild(checkbox);
        const fileIconSpan = document.createElement("span");
        fileIconSpan.className = "gdrive-file-icon";
        const musicSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        musicSvg.setAttribute("width", "18"); musicSvg.setAttribute("height", "18");
        musicSvg.setAttribute("viewBox", "0 0 24 24"); musicSvg.setAttribute("fill", "none");
        musicSvg.setAttribute("stroke", "currentColor"); musicSvg.setAttribute("stroke-width", "2");
        musicSvg.setAttribute("stroke-linecap", "round"); musicSvg.setAttribute("stroke-linejoin", "round");
        musicSvg.innerHTML = '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>';
        fileIconSpan.appendChild(musicSvg);
        const fileNameSpan = document.createElement("span");
        fileNameSpan.className = "gdrive-file-name";
        fileNameSpan.textContent = file.name;
        const fileSizeSpan = document.createElement("span");
        fileSizeSpan.className = "gdrive-file-size";
        fileSizeSpan.textContent = size;
        row.append(checkLabel, fileIconSpan, fileNameSpan, fileSizeSpan);
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
    gdriveFileList.textContent = "";
    const errDiv = document.createElement("div");
    errDiv.className = "gdrive-picker-empty";
    errDiv.textContent = `Error: ${err.message}`;
    gdriveFileList.appendChild(errDiv);
  }
};

// ---------------------------------------------------------------------------
// Picker open / close
// ---------------------------------------------------------------------------
const openDrivePicker = () => new Promise((resolve) => {
  console.debug("[DriveUI] openDrivePicker called", { time: new Date().toISOString(), stack: (new Error().stack) });
  pickerSelected.clear();
  pickerBreadcrumbs = [{ id: "root", name: "My Drive" }];
  pickerResolve = resolve;
  gdrivePickerModal.hidden = false;
  console.debug("[DriveUI] gdrivePickerModal.hidden set to false", { time: new Date().toISOString() });
  gdrivePickerClose.focus();
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

// ---------------------------------------------------------------------------
// Download progress UI
// ---------------------------------------------------------------------------
const showDownloadProgress = (items) => {
  gdriveFileList.hidden = true;
  gdriveBreadcrumb.hidden = true;
  gdrivePickerFooter.hidden = true;
  gdriveDownloadProgress.hidden = false;
  gdriveDownloadList.textContent = "";

  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const row = document.createElement("div");
    row.className = "gdrive-dl-item";

    const info = document.createElement("div");
    info.className = "gdrive-dl-info";
    const name = document.createElement("span");
    name.className = "gdrive-dl-name";
    name.textContent = items[i].name;
    const size = document.createElement("span");
    size.className = "gdrive-dl-size";
    size.textContent = "Waiting...";
    info.append(name, size);

    const bar = document.createElement("div");
    bar.className = "gdrive-dl-bar";
    const fill = document.createElement("div");
    fill.className = "gdrive-dl-fill";
    bar.appendChild(fill);

    row.append(info, bar);
    gdriveDownloadList.appendChild(row);
    rows.push({ row, fill, size });
  }
  return rows;
};

const hideDownloadProgress = () => {
  gdriveDownloadProgress.hidden = true;
  gdriveFileList.hidden = false;
  gdriveBreadcrumb.hidden = false;
  gdrivePickerFooter.hidden = false;
};

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
gdrivePickerClose.addEventListener("click", () => {
  if (gdriveDownloading) { gdrivePickerModal.hidden = true; return; }
  closeDrivePicker([]);
});
gdrivePickerCancel.addEventListener("click", () => {
  if (gdriveDownloading) { gdrivePickerModal.hidden = true; return; }
  closeDrivePicker([]);
});
gdrivePickerModal.addEventListener("click", (e) => {
  if (e.target !== gdrivePickerModal) return;
  if (gdriveDownloading) { gdrivePickerModal.hidden = true; return; }
  closeDrivePicker([]);
});
gdrivePickerSelect.addEventListener("click", () => closeDrivePicker([...pickerSelected.values()]));

// ESC key closes the modal
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !gdrivePickerModal.hidden) {
    if (gdriveDownloading) { gdrivePickerModal.hidden = true; return; }
    closeDrivePicker([]);
  }
});

// Focus trap — keep Tab inside the modal
gdrivePickerModal.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const focusable = gdrivePickerModal.querySelectorAll('button:not([hidden]):not([disabled]), input:not([hidden]), [tabindex]:not([tabindex="-1"])');
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

gdriveSelectAll.addEventListener("change", () => {
  const checkAll = gdriveSelectAll.checked;
  for (const file of pickerCurrentFiles) {
    if (checkAll) pickerSelected.set(file.id, { id: file.id, name: file.name });
    else pickerSelected.delete(file.id);
  }
  gdriveFileList.querySelectorAll(".gdrive-file-check input").forEach((cb) => { cb.checked = checkAll; });
  refreshPickerCount();
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Import files from Google Drive. Returns File[] to be added to tracks.
 * @param {{ updateStatus: Function, setIdle: Function }} ui
 * @returns {Promise<File[]>}
 */
export const importFromDrive = async (ui) => {
  console.debug("[DriveUI] importFromDrive called", { time: new Date().toISOString(), stack: (new Error().stack) });
  ui.updateStatus("To import files, BookForge needs permission to read your Google Drive. No files will be modified.", "info");
  await new Promise((r) => setTimeout(r, 1800));
  ui.updateStatus("Connecting to Google Drive...");
  try {
    console.debug("[DriveUI] Calling ensureAuth", { time: new Date().toISOString() });
    await ensureDriveAuth("https://www.googleapis.com/auth/drive.readonly");
    console.debug("[DriveUI] ensureAuth resolved", { time: new Date().toISOString() });
    ui.setIdle();
  } catch (err) {
    console.debug("[DriveUI] ensureAuth error", { error: err, time: new Date().toISOString(), stack: (new Error().stack) });
    // Special handling for GIS popup closed/cancelled
    if (err && (err.message === "Popup window closed" || err.message === "Failed to open popup window" || /popup/i.test(err.message))) {
      ui.updateStatus("Google sign-in was not completed. Please try again and complete the sign-in in the popup window.", "error");
    } else {
      ui.updateStatus(err.message || "Google Drive authentication failed", "error");
    }
    setTimeout(ui.setIdle, 4000);
    return [];
  }

  console.debug("[DriveUI] Calling openDrivePicker", { time: new Date().toISOString() });
  const selected = await openDrivePicker();
  console.debug("[DriveUI] openDrivePicker resolved", { selected, time: new Date().toISOString() });
  if (!selected.length) return [];

  const progressRows = showDownloadProgress(selected);

  gdrivePickerModal.hidden = false;
  gdriveDownloading = true;
  console.debug("[DriveUI] gdrivePickerModal.hidden set to false (download phase)", { time: new Date().toISOString() });

  ui.updateStatus(`Downloading ${selected.length} file${selected.length > 1 ? "s" : ""}...`);

  const files = await downloadFiles(selected, (index, _name, loaded, total, done) => {
    const pr = progressRows[index];
    if (!pr) return;
    if (total > 0) {
      const pct = Math.min(100, (loaded / total) * 100);
      pr.fill.style.width = `${pct}%`;
      pr.size.textContent = done ? formatBytes(total) : `${formatBytes(loaded)} / ${formatBytes(total)}`;
    } else if (done) {
      pr.fill.style.width = "100%";
      pr.size.textContent = loaded > 0 ? formatBytes(loaded) : "Failed";
    }
    if (done) pr.row.classList.add("done");
  });

  await new Promise((r) => setTimeout(r, 600));
  gdriveDownloading = false;
  gdrivePickerModal.hidden = true;
  hideDownloadProgress();

  return files;
};

/**
 * Export a compiled blob to Google Drive.
 * @param {Blob} blob
 * @param {string} filename
 * @param {{ updateStatus: Function, showProgress: Function, hideProgress: Function, setIdle: Function }} ui
 * @returns {Promise<{webViewLink?: string}>}
 */
export const exportToDrive = async (blob, filename, ui) => {
  ui.updateStatus("Uploading to Google Drive...");
  ui.showProgress(50);
  try {
    const result = await uploadToDrive(blob, filename);
    ui.showProgress(100);
    ui.setIdle("Saved to Google Drive!");
    return result;
  } catch (err) {
    ui.showProgress(0);
    ui.updateStatus(err.message || "Google Drive upload failed", "error");
    setTimeout(ui.setIdle, 3000);
    return {};
  }
};

/**
 * Whether the Drive picker modal is currently hidden.
 */
export const isPickerHidden = () => gdrivePickerModal.hidden;

/**
 * Show/hide the picker modal.
 */
export const setPickerVisible = (visible) => { gdrivePickerModal.hidden = !visible; };
