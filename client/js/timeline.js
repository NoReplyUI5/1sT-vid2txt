/**
 * timeline.js — trim handle drag logic + playhead sync
 */
import { formatTime, clamp } from "./utils.js";

export function initTimeline({ duration, onTrimChange, videoEl }) {
  const track = document.getElementById("timeline-track");
  const handleStart = document.getElementById("handle-start");
  const handleEnd = document.getElementById("handle-end");
  const range = document.getElementById("timeline-range");
  const playhead = document.getElementById("playhead");
  const labelStart = document.getElementById("trim-start-label");
  const labelEnd = document.getElementById("trim-end-label");

  let trimStart = 0;
  let trimEnd = duration;

  function update() {
    const startPct = (trimStart / duration) * 100;
    const endPct = (trimEnd / duration) * 100;
    const widthPct = endPct - startPct;

    handleStart.style.left = startPct + "%";
    handleEnd.style.left = `calc(${endPct}% - 12px)`;
    range.style.left = startPct + "%";
    range.style.width = widthPct + "%";

    labelStart.textContent = formatTime(trimStart);
    labelEnd.textContent = formatTime(trimEnd);

    onTrimChange(trimStart, trimEnd);
  }

  function getTrackRect() {
    return track.getBoundingClientRect();
  }

  function makeDraggable(handle, onMove) {
    let dragging = false;

    handle.addEventListener("pointerdown", (e) => {
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const { left, width } = getTrackRect();
      const x = e.clientX - left;
      const pct = clamp(x / width, 0, 1);
      onMove(pct * duration);
    });

    handle.addEventListener("pointerup", () => {
      dragging = false;
    });
  }

  makeDraggable(handleStart, (t) => {
    trimStart = clamp(t, 0, trimEnd - 0.1);
    update();
    videoEl.currentTime = trimStart;
  });

  makeDraggable(handleEnd, (t) => {
    trimEnd = clamp(t, trimStart + 0.1, duration);
    update();
    videoEl.currentTime = trimEnd;
  });

  // Playhead sync
  videoEl.addEventListener("timeupdate", () => {
    if (!duration) return;
    const pct = (videoEl.currentTime / duration) * 100;
    playhead.style.left = pct + "%";
  });

  // Click on track to seek
  track.addEventListener("click", (e) => {
    if (e.target === handleStart || e.target === handleEnd) return;
    const { left, width } = getTrackRect();
    const x = e.clientX - left;
    const pct = clamp(x / width, 0, 1);
    videoEl.currentTime = pct * duration;
  });

  // Enforce trim bounds during playback
  videoEl.addEventListener("timeupdate", () => {
    if (videoEl.currentTime < trimStart) videoEl.currentTime = trimStart;
    if (videoEl.currentTime > trimEnd) {
      videoEl.pause();
      videoEl.currentTime = trimStart;
    }
  });

  labelEnd.textContent = formatTime(duration);
  update();
}
