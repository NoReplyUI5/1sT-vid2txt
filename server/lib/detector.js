/**
 * Crop detector — ported from v.js.
 * Replaces sharp with ffmpeg rawvideo piping.
 * All frame data arrives as {data: Buffer, width: number, height: number}.
 */

/* ========================================================================== */
/* CONFIG                                                                     */
/* ========================================================================== */

const CONFIG = {
  samples: 20,
  analysisWidth: 640,
  backgroundTolerance: 28,
  rowVideoRatio: 0.2,
  columnVideoRatio: 0.2,
  temporalRatio: 0.25,
  motionThreshold: 20,
  edgeToleranceRatio: 0.008,
  ocrLanguage: "eng",
  refineMotionMinRatio: 0.04,
  consecutiveRequirement: 3,
  mergeGapRatio: 0.03,
  minRectangleSizeRatio: 0.1,
};

/* ========================================================================== */
/* PIXEL HELPERS                                                             */
/* ========================================================================== */

function pixelIndex(x, y, width) {
  return (y * width + x) * 3;
}

function getRGB(frame, x, y) {
  x = Math.max(0, Math.min(frame.width - 1, Math.round(x)));
  y = Math.max(0, Math.min(frame.height - 1, Math.round(y)));
  const index = pixelIndex(x, y, frame.width);
  return [frame.data[index], frame.data[index + 1], frame.data[index + 2]];
}

function colorDistanceSq(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/* ========================================================================== */
/* BACKGROUND COLOR                                                           */
/* ========================================================================== */

function getBackgroundColor(frames) {
  const samples = [];

  for (const frame of frames) {
    const w = frame.width;
    const h = frame.height;

    const points = [
      [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
      [Math.floor(w * 0.02), 0], [Math.floor(w * 0.98), 0],
      [Math.floor(w * 0.02), h - 1], [Math.floor(w * 0.98), h - 1],
      [0, Math.floor(h * 0.02)], [w - 1, Math.floor(h * 0.02)],
      [0, Math.floor(h * 0.98)], [w - 1, Math.floor(h * 0.98)],
      [Math.floor(w * 0.1), 0], [Math.floor(w * 0.9), 0],
      [Math.floor(w * 0.1), h - 1], [Math.floor(w * 0.9), h - 1],
    ];

    for (const [x, y] of points) {
      samples.push(getRGB(frame, x, y));
    }
  }

  // Find most common cluster by median
  const r = median(samples.map((s) => s[0]));
  const g = median(samples.map((s) => s[1]));
  const b = median(samples.map((s) => s[2]));

  return [r, g, b];
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/* ========================================================================== */
/* NON-BACKGROUND MAP                                                        */
/* ========================================================================== */

function buildNonBackgroundMap(frames, bgColor) {
  const w = frames[0].width;
  const h = frames[0].height;
  // counts[y][x] = number of frames where pixel is non-background
  const counts = Array.from({ length: h }, () => new Uint16Array(w));

  for (const frame of frames) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = getRGB(frame, x, y);
        if (colorDistanceSq(px, bgColor) > CONFIG.backgroundTolerance ** 2) {
          counts[y][x]++;
        }
      }
    }
  }

  const threshold = Math.ceil(frames.length * CONFIG.temporalRatio);
  // Boolean map: pixel is "non-background" if it appears so in enough frames
  const map = Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (__, x) => counts[y][x] >= threshold)
  );
  return map;
}

/* ========================================================================== */
/* MOTION MAP                                                                */
/* ========================================================================== */

function buildMotionMap(frames) {
  const w = frames[0].width;
  const h = frames[0].height;
  const counts = Array.from({ length: h }, () => new Uint16Array(w));

  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const curr = frames[i];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const pPrev = getRGB(prev, x, y);
        const pCurr = getRGB(curr, x, y);
        if (colorDistanceSq(pPrev, pCurr) > CONFIG.motionThreshold ** 2) {
          counts[y][x]++;
        }
      }
    }
  }

  const threshold = 1;
  const map = Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (__, x) => counts[y][x] >= threshold)
  );
  return map;
}

/* ========================================================================== */
/* PROJECTION                                                                */
/* ========================================================================== */

function buildProjection(nonBackgroundMap, motionMap) {
  const h = nonBackgroundMap.length;
  const w = nonBackgroundMap[0].length;

  const rowProjection = new Float32Array(h);
  const colProjection = new Float32Array(w);

  for (let y = 0; y < h; y++) {
    let nonBgCount = 0;
    let motionCount = 0;
    for (let x = 0; x < w; x++) {
      if (nonBackgroundMap[y][x]) nonBgCount++;
      if (motionMap[y][x]) motionCount++;
    }
    // Row score: combination of non-background presence and motion
    rowProjection[y] =
      (nonBgCount / w) * 0.4 + (motionCount / w) * 0.6;
  }

  for (let x = 0; x < w; x++) {
    let nonBgCount = 0;
    let motionCount = 0;
    for (let y = 0; y < h; y++) {
      if (nonBackgroundMap[y][x]) nonBgCount++;
      if (motionMap[y][x]) motionCount++;
    }
    colProjection[x] =
      (nonBgCount / h) * 0.4 + (motionCount / h) * 0.6;
  }

  return { rowProjection, colProjection };
}

/* ========================================================================== */
/* FIND INTERVALS                                                             */
/* ========================================================================== */

function findIntervals(projection, threshold) {
  const intervals = [];
  let start = -1;

  for (let i = 0; i < projection.length; i++) {
    if (projection[i] >= threshold) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      intervals.push({ start, end: i - 1, length: i - start });
      start = -1;
    }
  }

  if (start !== -1) {
    intervals.push({ start, end: projection.length - 1, length: projection.length - start });
  }

  return intervals;
}

/* ========================================================================== */
/* MERGE CLOSE INTERVALS                                                     */
/* ========================================================================== */

function mergeIntervals(intervals, gap) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const result = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const previous = result[result.length - 1];
    if (current.start - previous.end - 1 <= gap) {
      previous.end = Math.max(previous.end, current.end);
      previous.length = previous.end - previous.start + 1;
    } else {
      result.push({ ...current });
    }
  }

  return result;
}

/* ========================================================================== */
/* PICK BEST RECTANGLE                                                       */
/* ========================================================================== */

function pickBestRectangle(rowIntervals, colIntervals, w, h) {
  const minSize = CONFIG.minRectangleSizeRatio;
  const edgeTol = CONFIG.edgeToleranceRatio;

  const candidates = [];

  for (const row of rowIntervals) {
    for (const col of colIntervals) {
      const rw = col.length / w;
      const rh = row.length / h;
      if (rw < minSize || rh < minSize) continue;

      const atLeft = col.start / w < edgeTol;
      const atRight = (w - 1 - col.end) / w < edgeTol;
      const atTop = row.start / h < edgeTol;
      const atBottom = (h - 1 - row.end) / h < edgeTol;

      const edgeBonus =
        (atLeft ? 0.1 : 0) +
        (atRight ? 0.1 : 0) +
        (atTop ? 0.1 : 0) +
        (atBottom ? 0.1 : 0);

      const score = rw * rh + edgeBonus;

      candidates.push({
        x: col.start,
        y: row.start,
        width: col.length,
        height: row.length,
        score,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

/* ========================================================================== */
/* REFINE BOUNDARIES                                                         */
/* ========================================================================== */

function refineRectangle(rectangle, nonBackgroundMap, motionMap, width, height) {
  let { x, y, width: w, height: h } = rectangle;

  const originalRight = x + w - 1;
  const originalBottom = y + h - 1;

  const rowThreshold = Math.max(0.08, CONFIG.rowVideoRatio * 0.45);
  const columnThreshold = Math.max(0.08, CONFIG.columnVideoRatio * 0.45);

  function columnIsContent(col, startRow, endRow) {
    let nonBg = 0;
    let motion = 0;
    const len = endRow - startRow + 1;
    for (let row = startRow; row <= endRow; row++) {
      if (nonBackgroundMap[row]?.[col]) nonBg++;
      if (motionMap[row]?.[col]) motion++;
    }
    return (
      nonBg / len >= columnThreshold &&
      motion / len >= CONFIG.refineMotionMinRatio
    );
  }

  function rowIsContent(row, startCol, endCol) {
    let nonBg = 0;
    let motion = 0;
    const len = endCol - startCol + 1;
    for (let col = startCol; col <= endCol; col++) {
      if (nonBackgroundMap[row]?.[col]) nonBg++;
      if (motionMap[row]?.[col]) motion++;
    }
    return (
      nonBg / len >= rowThreshold &&
      motion / len >= CONFIG.refineMotionMinRatio
    );
  }

  const req = CONFIG.consecutiveRequirement;

  // Trim top
  let newTop = y;
  outer: for (let row = y; row <= originalBottom; row++) {
    for (let c = 0; c < req; c++) {
      if (!rowIsContent(row + c, x, x + w - 1)) continue outer;
    }
    newTop = row;
    break;
  }

  // Trim bottom
  let newBottom = originalBottom;
  outer: for (let row = originalBottom; row >= newTop; row--) {
    for (let c = 0; c < req; c++) {
      if (!rowIsContent(row - c, x, x + w - 1)) continue outer;
    }
    newBottom = row;
    break;
  }

  // Trim left
  let newLeft = x;
  outer: for (let col = x; col <= originalRight; col++) {
    for (let c = 0; c < req; c++) {
      if (!columnIsContent(col + c, newTop, newBottom)) continue outer;
    }
    newLeft = col;
    break;
  }

  // Trim right
  let newRight = originalRight;
  outer: for (let col = originalRight; col >= newLeft; col--) {
    for (let c = 0; c < req; c++) {
      if (!columnIsContent(col - c, newTop, newBottom)) continue outer;
    }
    newRight = col;
    break;
  }

  return {
    x: newLeft,
    y: newTop,
    width: newRight - newLeft + 1,
    height: newBottom - newTop + 1,
  };
}

/* ========================================================================== */
/* MAIN DETECT                                                               */
/* ========================================================================== */

/**
 * Detect crop region from an array of frame buffers.
 *
 * @param {Array<{data:Buffer, width:number, height:number}|null>} frames
 *   Frames piped from ffmpeg rawvideo (rgb24). Nulls (failed extractions) are filtered.
 * @param {{width:number, height:number}} videoInfo  original video dimensions
 * @returns {{ x:number, y:number, width:number, height:number }|null}
 *   Crop rectangle in ORIGINAL video pixel coordinates, or null if detection failed.
 */
export function detectCrop(frames, videoInfo) {
  const validFrames = frames.filter(Boolean);
  if (validFrames.length < 2) return null;

  const w = validFrames[0].width;   // analysis width (scaled)
  const h = validFrames[0].height;  // analysis height (scaled)

  const bgColor = getBackgroundColor(validFrames);
  const nonBackgroundMap = buildNonBackgroundMap(validFrames, bgColor);
  const motionMap = buildMotionMap(validFrames);

  const { rowProjection, colProjection } = buildProjection(
    nonBackgroundMap,
    motionMap
  );

  const rowThreshold = CONFIG.rowVideoRatio;
  const colThreshold = CONFIG.columnVideoRatio;
  const mergeGap = Math.round(Math.max(w, h) * CONFIG.mergeGapRatio);

  const rawRowIntervals = findIntervals(rowProjection, rowThreshold);
  const rawColIntervals = findIntervals(colProjection, colThreshold);

  const rowIntervals = mergeIntervals(rawRowIntervals, mergeGap);
  const colIntervals = mergeIntervals(rawColIntervals, mergeGap);

  const rough = pickBestRectangle(rowIntervals, colIntervals, w, h);
  if (!rough) return null;

  const refined = refineRectangle(rough, nonBackgroundMap, motionMap, w, h);

  // Scale from analysis dimensions back to original video dimensions
  const scaleX = videoInfo.width / w;
  const scaleY = videoInfo.height / h;

  return {
    x: Math.round(refined.x * scaleX),
    y: Math.round(refined.y * scaleY),
    width: Math.round(refined.width * scaleX),
    height: Math.round(refined.height * scaleY),
  };
}
