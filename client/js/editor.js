/**
 * editor.js — coordinates all editor modules
 */
import { initTimeline } from "./timeline.js";
import { initTextPanel } from "./textPanel.js";
import { startExport } from "./exporter.js";

let state = {
  jobId: null,
  info: null,       // { width, height, duration, fps }
  crop: null,       // { x, y, width, height }
  trim: null,       // { start, end }
  textBlocks: [],   // [{ id, text, x, y, fontSize, color }]
};

const video = document.getElementById("video-preview");
const cropCanvas = document.getElementById("crop-canvas");
const ctx = cropCanvas.getContext("2d");

const cropX = document.getElementById("crop-x");
const cropY = document.getElementById("crop-y");
const cropW = document.getElementById("crop-w");
const cropH = document.getElementById("crop-h");
const btnResetCrop = document.getElementById("btn-reset-crop");
const btnExport = document.getElementById("btn-export");
const ocrOutput = document.getElementById("ocr-output");

export function initEditor({ jobId, info, crop, ocrText, videoUrl, revokeVideoUrl }) {
  state.jobId = jobId;
  state.info = info;
  state.crop = { ...crop };
  state.trim = { start: 0, end: info.duration };
  state.textBlocks = [];

  // Load video
  video.src = videoUrl;
  video.load();
  // Release the blob URL once the browser has loaded the video
  video.addEventListener("canplay", () => revokeVideoUrl?.(), { once: true });

  // OCR text
  ocrOutput.textContent = ocrText || "(none detected)";

  // Crop inputs
  setCropInputs(state.crop);

  cropX.addEventListener("input", () => updateCropFromInputs());
  cropY.addEventListener("input", () => updateCropFromInputs());
  cropW.addEventListener("input", () => updateCropFromInputs());
  cropH.addEventListener("input", () => updateCropFromInputs());

  btnResetCrop.addEventListener("click", () => {
    state.crop = {
      x: 0,
      y: 0,
      width: info.width,
      height: info.height,
    };
    setCropInputs(state.crop);
    drawCropOverlay();
  });

  // Draw overlay on video resize / metadata load
  video.addEventListener("loadedmetadata", () => {
    resizeCropCanvas();
    drawCropOverlay();
  });
  window.addEventListener("resize", () => {
    resizeCropCanvas();
    drawCropOverlay();
  });

  // Timeline
  initTimeline({
    duration: info.duration,
    onTrimChange: (start, end) => {
      state.trim = { start, end };
    },
    videoEl: video,
  });

  // Text panel
  initTextPanel({
    getTextBlocks: () => state.textBlocks,
    setTextBlocks: (blocks) => {
      state.textBlocks = blocks;
    },
    videoEl: video,
    previewAreaEl: document.getElementById("preview-area"),
    videoInfo: info,
    getCrop: () => state.crop,
  });

  // Export
  btnExport.addEventListener("click", () => {
    startExport({
      jobId: state.jobId,
      crop: state.crop,
      trim: state.trim,
      textBlocks: state.textBlocks,
    });
  });
}

function setCropInputs(crop) {
  cropX.value = crop.x;
  cropY.value = crop.y;
  cropW.value = crop.width;
  cropH.value = crop.height;
}

function updateCropFromInputs() {
  const info = state.info;
  state.crop = {
    x: Math.max(0, Math.min(info.width - 1, parseInt(cropX.value) || 0)),
    y: Math.max(0, Math.min(info.height - 1, parseInt(cropY.value) || 0)),
    width: Math.max(1, Math.min(info.width, parseInt(cropW.value) || info.width)),
    height: Math.max(1, Math.min(info.height, parseInt(cropH.value) || info.height)),
  };
  drawCropOverlay();
}

function resizeCropCanvas() {
  const rect = video.getBoundingClientRect();
  cropCanvas.width = rect.width;
  cropCanvas.height = rect.height;
  cropCanvas.style.left = rect.left - video.parentElement.getBoundingClientRect().left + "px";
  cropCanvas.style.top = rect.top - video.parentElement.getBoundingClientRect().top + "px";
  cropCanvas.style.width = rect.width + "px";
  cropCanvas.style.height = rect.height + "px";
}

function drawCropOverlay() {
  if (!state.crop || !state.info) return;
  const { width: vw, height: vh } = state.info;
  const { width: cw, height: ch } = cropCanvas;

  const scaleX = cw / vw;
  const scaleY = ch / vh;

  const { x, y, width, height } = state.crop;
  const px = x * scaleX;
  const py = y * scaleY;
  const pw = width * scaleX;
  const ph = height * scaleY;

  ctx.clearRect(0, 0, cw, ch);

  // Darken outside crop
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, cw, ch);

  // Clear inside crop
  ctx.clearRect(px, py, pw, ph);

  // Crop border
  ctx.strokeStyle = "rgba(99,102,241,0.9)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(px, py, pw, ph);

  // Rule-of-thirds guides inside crop
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 0.5;
  for (let i = 1; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(px + (pw / 3) * i, py);
    ctx.lineTo(px + (pw / 3) * i, py + ph);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px, py + (ph / 3) * i);
    ctx.lineTo(px + pw, py + (ph / 3) * i);
    ctx.stroke();
  }
}
