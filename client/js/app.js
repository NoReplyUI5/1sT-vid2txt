/**
 * app.js — entry point, wires upload → editor
 */
import { initEditor } from "./editor.js";
import { parseErrorBody } from "./utils.js";

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const uploadProgress = document.getElementById("upload-progress");
const uploadStatus = document.getElementById("upload-status");
const progressBar = document.getElementById("progress-bar");
const screenUpload = document.getElementById("screen-upload");
const screenEditor = document.getElementById("screen-editor");

// Click or keyboard on drop zone → open file picker
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") fileInput.click();
});

// Drag and drop
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("border-indigo-400");
});
dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("border-indigo-400");
});
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("border-indigo-400");
  const file = e.dataTransfer?.files?.[0];
  if (file) uploadFile(file);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) uploadFile(file);
});

async function uploadFile(file) {
  uploadProgress.classList.remove("hidden");
  progressBar.style.width = "0%";
  uploadStatus.textContent = "Uploading…";

  const formData = new FormData();
  formData.append("video", file);

  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/process");

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 80);
          progressBar.style.width = pct + "%";
          uploadStatus.textContent = `Uploading… ${pct}%`;
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          progressBar.style.width = "100%";
          uploadStatus.textContent = "Processing…";
          resolve(JSON.parse(xhr.responseText));
        } else {
          let msg = "Upload failed";
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* non-JSON body */ }
          reject(new Error(msg));
        }
      });

      xhr.addEventListener("error", () => reject(new Error("Network error")));
      xhr.send(formData);
    });
  } catch (err) {
    uploadStatus.textContent = "Error: " + err.message;
    progressBar.classList.add("bg-red-500");
    progressBar.classList.remove("bg-indigo-500");
    return;
  }

  // Switch to editor
  screenUpload.classList.add("hidden");
  screenEditor.classList.remove("hidden");
  document.body.classList.add("editor-active");

  // Create a local object URL for the video element; revoked by editor on unload
  const videoUrl = URL.createObjectURL(file);
  initEditor({ ...result, videoUrl, revokeVideoUrl: () => URL.revokeObjectURL(videoUrl) });

  document.getElementById("btn-export").classList.remove("hidden");
}
