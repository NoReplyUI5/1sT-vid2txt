/**
 * textPanel.js — add/remove/edit text blocks, drag overlays on preview
 */
import { formatTime, clamp } from "./utils.js";

let _getBlocks;
let _setBlocks;
let _videoEl;
let _previewArea;
let _videoInfo;
let _getCrop;

let nextId = 1;

const list = document.getElementById("text-blocks-list");
const overlayLayer = document.getElementById("text-overlay-layer");

export function initTextPanel({ getTextBlocks, setTextBlocks, videoEl, previewAreaEl, videoInfo, getCrop }) {
  _getBlocks = getTextBlocks;
  _setBlocks = setTextBlocks;
  _videoEl = videoEl;
  _previewArea = previewAreaEl;
  _videoInfo = videoInfo;
  _getCrop = getCrop;

  document.getElementById("btn-add-text").addEventListener("click", addBlock);

  // Re-render overlays when video resizes — stored so caller can remove if needed
  const onResize = () => renderOverlays();
  window.addEventListener("resize", onResize);
  videoEl.addEventListener("loadedmetadata", renderOverlays);

  return () => window.removeEventListener("resize", onResize);
}

function addBlock() {
  const crop = _getCrop();
  const blocks = _getBlocks();
  const block = {
    id: nextId++,
    text: "Text",
    // Position in original video coordinates, within crop region
    x: crop.x + 20,
    y: crop.y + 20,
    fontSize: 32,
    color: "#ffffff",
  };
  blocks.push(block);
  _setBlocks(blocks);
  renderList();
  renderOverlays();
}

function removeBlock(id) {
  _setBlocks(_getBlocks().filter((b) => b.id !== id));
  renderList();
  renderOverlays();
}

function updateBlock(id, changes) {
  const blocks = _getBlocks().map((b) => (b.id === id ? { ...b, ...changes } : b));
  _setBlocks(blocks);
  renderList();
  renderOverlays();
}

/* ------------------------------------------------------------------ */
/* Sidebar list                                                         */
/* ------------------------------------------------------------------ */

function renderList() {
  list.innerHTML = "";
  for (const block of _getBlocks()) {
    const item = document.createElement("div");
    item.className = "text-block-item rounded p-2 flex flex-col gap-1 bg-zinc-800";
    item.dataset.id = block.id;

    // Row 1: text input + remove button
    const row1 = document.createElement("div");
    row1.className = "flex items-center gap-2";

    const textInput = document.createElement("input");
    textInput.type = "text";
    textInput.value = block.text;
    textInput.className = "flex-1 bg-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-100 min-w-0";
    textInput.setAttribute("aria-label", "Text content");

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove text-zinc-500 hover:text-red-400 text-xs px-1";
    removeBtn.setAttribute("aria-label", "Remove text block");
    removeBtn.textContent = "✕";

    row1.appendChild(textInput);
    row1.appendChild(removeBtn);

    // Row 2: size + color
    const row2 = document.createElement("div");
    row2.className = "flex items-center gap-2 text-xs text-zinc-400";

    const sizeLabel = document.createElement("label");
    sizeLabel.className = "flex items-center gap-1";
    sizeLabel.textContent = "Size ";
    const sizeInput = document.createElement("input");
    sizeInput.type = "number";
    sizeInput.value = block.fontSize;
    sizeInput.min = "8";
    sizeInput.max = "256";
    sizeInput.className = "w-14 bg-zinc-700 rounded px-1 py-0.5 text-zinc-100";
    sizeInput.setAttribute("aria-label", "Font size");
    sizeLabel.appendChild(sizeInput);

    const colorLabel = document.createElement("label");
    colorLabel.className = "flex items-center gap-1";
    colorLabel.textContent = "Color ";
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = block.color;
    colorInput.className = "w-7 h-5 rounded cursor-pointer bg-transparent border-0";
    colorInput.setAttribute("aria-label", "Text color");
    colorLabel.appendChild(colorInput);

    row2.appendChild(sizeLabel);
    row2.appendChild(colorLabel);

    item.appendChild(row1);
    item.appendChild(row2);

    textInput.addEventListener("input", () => {
      updateBlock(block.id, { text: textInput.value });
    });
    sizeInput.addEventListener("input", () => {
      updateBlock(block.id, { fontSize: parseInt(sizeInput.value) || 32 });
    });
    colorInput.addEventListener("input", () => {
      updateBlock(block.id, { color: colorInput.value });
    });
    removeBtn.addEventListener("click", () => removeBlock(block.id));

    list.appendChild(item);
  }
}

/* ------------------------------------------------------------------ */
/* Preview overlays (draggable)                                        */
/* ------------------------------------------------------------------ */

function videoToPreviewCoords(vx, vy) {
  const vRect = _videoEl.getBoundingClientRect();
  const pRect = _previewArea.getBoundingClientRect();
  const scaleX = vRect.width / _videoInfo.width;
  const scaleY = vRect.height / _videoInfo.height;
  return {
    px: vRect.left - pRect.left + vx * scaleX,
    py: vRect.top - pRect.top + vy * scaleY,
    scaleX,
    scaleY,
  };
}

function renderOverlays() {
  overlayLayer.innerHTML = "";
  for (const block of _getBlocks()) {
    const { px, py, scaleX, scaleY } = videoToPreviewCoords(block.x, block.y);

    const el = document.createElement("div");
    el.className = "text-overlay-block";
    el.dataset.id = block.id;
    el.textContent = block.text || " ";
    el.style.left = px + "px";
    el.style.top = py + "px";
    el.style.fontSize = block.fontSize * scaleX + "px";
    el.style.color = block.color;
    el.style.pointerEvents = "all";

    makeDraggableOverlay(el, block, scaleX, scaleY);
    overlayLayer.appendChild(el);
  }
}

function makeDraggableOverlay(el, block, scaleX, scaleY) {
  let startPointerX, startPointerY, startBlockX, startBlockY;
  let isDragging = false;

  el.addEventListener("pointerdown", (e) => {
    isDragging = true;
    el.setPointerCapture(e.pointerId);
    startPointerX = e.clientX;
    startPointerY = e.clientY;
    startBlockX = block.x;
    startBlockY = block.y;
    el.classList.add("selected");
    e.preventDefault();
  });

  el.addEventListener("pointermove", (e) => {
    if (!isDragging) return;
    const dx = (e.clientX - startPointerX) / scaleX;
    const dy = (e.clientY - startPointerY) / scaleY;
    const newX = Math.round(startBlockX + dx);
    const newY = Math.round(startBlockY + dy);
    // Update position without full re-render for performance
    block.x = newX;
    block.y = newY;
    const { px, py } = videoToPreviewCoords(newX, newY);
    el.style.left = px + "px";
    el.style.top = py + "px";
    // Sync to state
    updateBlockPosition(block.id, newX, newY);
  });

  el.addEventListener("pointerup", () => {
    isDragging = false;
    el.classList.remove("selected");
  });
}

function updateBlockPosition(id, x, y) {
  const blocks = _getBlocks().map((b) => (b.id === id ? { ...b, x, y } : b));
  _setBlocks(blocks);
}
