/** @format */

import ffmpeg from "fluent-ffmpeg";
import Tesseract from "tesseract.js";
import sharp from "sharp";
import fs from "fs/promises";
import os from "os";
import path from "path";

/* ========================================================================== */
/* CONFIG                                                                     */
/* ========================================================================== */

const CONFIG = {
  samples: 20,

  /*
   * Analysis resolution.
   * Higher = more accurate, slower.
   */
  analysisWidth: 640,

  /*
   * Background detection.
   */
  backgroundTolerance: 28,

  /*
   * How much of a row/column must be different from
   * the detected background before we consider it part
   * of the video.
   */
  rowVideoRatio: 0.2,
  columnVideoRatio: 0.2,

  /*
   * Temporal consistency.
   *
   * A pixel/region must be considered non-background
   * in this fraction of sampled frames.
   */
  temporalRatio: 0.25,

  /*
   * Motion.
   */
  motionThreshold: 20,

  /*
   * Small safety tolerance when deciding whether
   * a boundary is really at the frame edge.
   */
  edgeToleranceRatio: 0.008,

  /*
   * OCR.
   */
  ocrLanguage: "eng",

  /*
   * Minimum fraction of a row/column that must show actual
   * MOTION (not just "differs from background") for it to be
   * treated as real video content during refinement.
   *
   * Static text/captions are non-background but have ~0 motion,
   * so this is what keeps them from being counted as part of the
   * video rectangle.
   */
  refineMotionMinRatio: 0.04,

  /*
   * How many consecutive rows/columns must satisfy the content
   * threshold before we accept that as the true edge during
   * refinement. Prevents a single noisy border/text row from
   * halting the trim prematurely.
   */
  refineConsecutive: 3,
};

/* ========================================================================== */
/* VIDEO INFO                                                                 */
/* ========================================================================== */

function getVideoInfo(input) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(input, (error, metadata) => {
      if (error) {
        reject(error);
        return;
      }

      const stream = metadata.streams.find(
        (stream) => stream.codec_type === "video",
      );

      if (!stream) {
        reject(new Error("Input contains no video stream."));

        return;
      }

      resolve({
        width: Number(stream.width),
        height: Number(stream.height),

        duration: Number(stream.duration ?? metadata.format.duration ?? 0),

        fps: parseFPS(stream.r_frame_rate),
      });
    });
  });
}

function parseFPS(value) {
  if (!value) {
    return 30;
  }

  const parts = String(value).split("/").map(Number);

  if (parts.length !== 2) {
    return Number(value) || 30;
  }

  return (parts[1] ? parts[0] / parts[1] : parts[0]) || 30;
}

/* ========================================================================== */
/* EXTRACT FRAMES                                                            */
/* ========================================================================== */

async function extractFrames(input, directory, duration, count) {
  const outputPattern = path.join(directory, "sample-%03d.jpg");

  /*
   * fps filter instead of repeated seeking.
   *
   * This is also much less likely to trigger the
   * previous FFmpeg exit-code problem.
   */
  const fps = count / Math.max(duration, 0.1);

  console.log(`\nSampling ${count} frames...`);

  await new Promise((resolve, reject) => {
    ffmpeg(input)
      .videoFilters(`fps=${fps}`)

      .outputOptions(["-frames:v", String(count), "-q:v", "2"])

      .output(outputPattern)

      .on("start", (command) => {
        console.log("\nFFmpeg sample command:");

        console.log(command);
      })

      .on("error", reject)

      .on("end", resolve)

      .run();
  });

  const files = [];

  for (let i = 1; i <= count; i++) {
    const filename = path.join(
      directory,
      `sample-${String(i).padStart(3, "0")}.jpg`,
    );

    try {
      await fs.access(filename);

      files.push(filename);
    } catch {
      // FFmpeg may output fewer frames.
    }
  }

  if (files.length < 2) {
    throw new Error(`Only ${files.length} sample frames could be extracted.`);
  }

  return files;
}

/* ========================================================================== */
/* LOAD FRAME                                                                */
/* ========================================================================== */

async function loadFrame(filename, width, height) {
  const result = await sharp(filename)
    .resize(width, height, {
      fit: "fill",
    })
    .removeAlpha()
    .raw()
    .toBuffer({
      resolveWithObject: true,
    });

  return {
    data: result.data,
    width: result.info.width,
    height: result.info.height,
  };
}

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

function colorDistance(a, b) {
  return Math.sqrt(
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2,
  );
}

/* ========================================================================== */
/* BACKGROUND COLOR                                                           */
/* ========================================================================== */

/*
 * We deliberately use the corners and several points close to
 * the outer edges.
 *
 * Text normally won't occupy all of these locations.
 */

function getBackgroundColor(frames) {
  const samples = [];

  for (const frame of frames) {
    const w = frame.width;
    const h = frame.height;

    const points = [
      [0, 0],
      [w - 1, 0],
      [0, h - 1],
      [w - 1, h - 1],

      [Math.floor(w * 0.02), 0],
      [Math.floor(w * 0.98), 0],

      [Math.floor(w * 0.02), h - 1],
      [Math.floor(w * 0.98), h - 1],

      [0, Math.floor(h * 0.02)],
      [w - 1, Math.floor(h * 0.02)],

      [0, Math.floor(h * 0.98)],
      [w - 1, Math.floor(h * 0.98)],
    ];

    for (const [x, y] of points) {
      samples.push(getRGB(frame, x, y));
    }
  }

  /*
   * Median channel value.
   *
   * This is much more robust than simply using
   * the first pixel.
   */

  const channels = [[], [], []];

  for (const rgb of samples) {
    channels[0].push(rgb[0]);
    channels[1].push(rgb[1]);
    channels[2].push(rgb[2]);
  }

  const median = (array) => {
    array.sort((a, b) => a - b);

    return array[Math.floor(array.length / 2)];
  };

  return [median(channels[0]), median(channels[1]), median(channels[2])];
}

/* ========================================================================== */
/* BACKGROUND MASK                                                            */
/* ========================================================================== */

/*
 * For every frame, determine whether each pixel belongs to
 * the outer background.
 */

function createBackgroundMask(frame, background) {
  const size = frame.width * frame.height;

  const mask = new Uint8Array(size);

  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const rgb = getRGB(frame, x, y);

      const distance = colorDistance(rgb, background);

      if (distance <= CONFIG.backgroundTolerance) {
        mask[y * frame.width + x] = 1;
      }
    }
  }

  return mask;
}

/* ========================================================================== */
/* TEMPORAL NON-BACKGROUND MAP                                               */
/* ========================================================================== */

/*
 * This is the key part.
 *
 * A static padding region stays background in almost every frame.
 *
 * The actual video region will usually contain pixels that differ
 * from the padding background across time.
 */

function buildTemporalNonBackgroundMap(frames, background) {
  const width = frames[0].width;

  const height = frames[0].height;

  const size = width * height;

  const counts = new Uint16Array(size);

  for (const frame of frames) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const rgb = getRGB(frame, x, y);

        const distance = colorDistance(rgb, background);

        if (distance > CONFIG.backgroundTolerance) {
          counts[y * width + x]++;
        }
      }
    }
  }

  const required = Math.max(1, Math.ceil(frames.length * CONFIG.temporalRatio));

  const result = new Uint8Array(size);

  for (let i = 0; i < size; i++) {
    if (counts[i] >= required) {
      result[i] = 1;
    }
  }

  return result;
}

/* ========================================================================== */
/* MOTION MAP                                                                 */
/* ========================================================================== */

function createMotionMap(frames) {
  const width = frames[0].width;

  const height = frames[0].height;

  const size = width * height;

  const counts = new Uint16Array(size);

  for (let f = 1; f < frames.length; f++) {
    const previous = frames[f - 1];

    const current = frames[f];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = getRGB(previous, x, y);

        const c = getRGB(current, x, y);

        const difference =
          (Math.abs(p[0] - c[0]) +
            Math.abs(p[1] - c[1]) +
            Math.abs(p[2] - c[2])) /
          3;

        if (difference >= CONFIG.motionThreshold) {
          counts[y * width + x]++;
        }
      }
    }
  }

  const required = Math.max(1, Math.ceil((frames.length - 1) * 0.15));

  const result = new Uint8Array(size);

  for (let i = 0; i < size; i++) {
    if (counts[i] >= required) {
      result[i] = 1;
    }
  }

  return result;
}

/* ========================================================================== */
/* PROJECTION                                                                */
/* ========================================================================== */

/*
 * Calculate how much of every row/column is actual content.
 *
 * This is considerably more reliable than detecting individual edges.
 */

function rowProjection(map, width, height) {
  const result = new Float64Array(height);

  for (let y = 0; y < height; y++) {
    let count = 0;

    for (let x = 0; x < width; x++) {
      if (map[y * width + x]) {
        count++;
      }
    }

    result[y] = count / width;
  }

  return result;
}

function columnProjection(map, width, height) {
  const result = new Float64Array(width);

  for (let x = 0; x < width; x++) {
    let count = 0;

    for (let y = 0; y < height; y++) {
      if (map[y * width + x]) {
        count++;
      }
    }

    result[x] = count / height;
  }

  return result;
}

/* ========================================================================== */
/* SMOOTH PROJECTION                                                          */
/* ========================================================================== */

function smooth(values, radius = 4) {
  const result = new Float64Array(values.length);

  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;

    for (
      let j = Math.max(0, i - radius);
      j <= Math.min(values.length - 1, i + radius);
      j++
    ) {
      sum += values[j];
      count++;
    }

    result[i] = sum / count;
  }

  return result;
}

/* ========================================================================== */
/* FIND INTERVALS                                                             */
/* ========================================================================== */

function findIntervals(projection, threshold) {
  const intervals = [];

  let start = -1;

  for (let i = 0; i < projection.length; i++) {
    if (projection[i] >= threshold) {
      if (start === -1) {
        start = i;
      }
    } else if (start !== -1) {
      intervals.push({
        start,
        end: i - 1,

        length: i - start,
      });

      start = -1;
    }
  }

  if (start !== -1) {
    intervals.push({
      start,

      end: projection.length - 1,

      length: projection.length - start,
    });
  }

  return intervals;
}

/* ========================================================================== */
/* MERGE CLOSE INTERVALS                                                      */
/* ========================================================================== */

function mergeIntervals(intervals, gap) {
  if (!intervals.length) {
    return [];
  }

  const sorted = [...intervals].sort((a, b) => a.start - b.start);

  const result = [
    {
      ...sorted[0],
    },
  ];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];

    const previous = result[result.length - 1];

    if (current.start - previous.end - 1 <= gap) {
      previous.end = Math.max(previous.end, current.end);

      previous.length = previous.end - previous.start + 1;
    } else {
      result.push({
        ...current,
      });
    }
  }

  return result;
}

/* ========================================================================== */
/* RECTANGLE SEARCH                                                           */
/* ========================================================================== */

/*
 * We now have:
 *
 *   background map
 *   +
 *   motion map
 *
 * Combine them.
 *
 * Background map is dominant because it tells us where the
 * actual embedded video is.
 *
 * Motion is only used to prevent a text line from becoming
 * the video rectangle.
 */

function combineMaps(backgroundMap, motionMap, width, height) {
  const result = new Uint8Array(width * height);

  for (let i = 0; i < result.length; i++) {
    if (backgroundMap[i] || motionMap[i]) {
      result[i] = 1;
    }
  }

  return result;
}

/* ========================================================================== */
/* SCORE RECTANGLE                                                            */
/* ========================================================================== */

function rectangleScore(map, width, height, x1, y1, x2, y2) {
  const rectWidth = x2 - x1 + 1;

  const rectHeight = y2 - y1 + 1;

  if (rectWidth <= 0 || rectHeight <= 0) {
    return -Infinity;
  }

  /*
   * Calculate occupancy.
   */

  let inside = 0;
  let total = 0;

  for (let y = y1; y <= y2; y += 2) {
    for (let x = x1; x <= x2; x += 2) {
      total++;

      if (map[y * width + x]) {
        inside++;
      }
    }
  }

  const occupancy = inside / Math.max(1, total);

  /*
   * Prefer large rectangles.
   *
   * But don't simply choose the entire frame.
   */

  const areaRatio = (rectWidth * rectHeight) / (width * height);

  /*
   * Strong penalty for extremely tiny rectangles.
   */

  if (areaRatio < 0.02) {
    return -Infinity;
  }

  return occupancy * 100 + areaRatio * 8;
}

/* ========================================================================== */
/* DETECT VIDEO RECTANGLE                                                     */
/* ========================================================================== */

function detectVideoRectangle(nonBackgroundMap, motionMap, width, height) {
  /*
   * First get projections of persistent non-background pixels.
   */

  const rows = smooth(
    rowProjection(nonBackgroundMap, width, height),
    Math.max(2, Math.round(height * 0.006)),
  );

  const columns = smooth(
    columnProjection(nonBackgroundMap, width, height),
    Math.max(2, Math.round(width * 0.006)),
  );

  /*
   * Find broad occupied intervals.
   */

  let rowIntervals = findIntervals(rows, CONFIG.rowVideoRatio);

  let columnIntervals = findIntervals(columns, CONFIG.columnVideoRatio);

  /*
   * Merge tiny gaps caused by objects/text.
   */

  rowIntervals = mergeIntervals(rowIntervals, Math.round(height * 0.02));

  columnIntervals = mergeIntervals(columnIntervals, Math.round(width * 0.02));

  console.log("\nRow intervals:", rowIntervals);

  console.log("Column intervals:", columnIntervals);

  /*
   * We need a reasonably large rectangle.
   *
   * Test combinations instead of choosing the first
   * projection interval.
   */

  const candidates = [];

  for (const row of rowIntervals) {
    for (const column of columnIntervals) {
      const x1 = column.start;

      const y1 = row.start;

      const x2 = column.end;

      const y2 = row.end;

      const score = rectangleScore(
        nonBackgroundMap,
        width,
        height,
        x1,
        y1,
        x2,
        y2,
      );

      candidates.push({
        x: x1,
        y: y1,

        width: x2 - x1 + 1,

        height: y2 - y1 + 1,

        score,
      });
    }
  }

  /*
   * Also consider the entire frame.
   *
   * This is important when there is no padding.
   */

  candidates.push({
    x: 0,
    y: 0,

    width,
    height,

    score: rectangleScore(
      nonBackgroundMap,
      width,
      height,
      0,
      0,
      width - 1,
      height - 1,
    ),
  });

  /*
   * Give candidates containing persistent motion
   * a bonus.
   */

  for (const candidate of candidates) {
    let motionPixels = 0;
    let total = 0;

    const x2 = candidate.x + candidate.width - 1;

    const y2 = candidate.y + candidate.height - 1;

    for (let y = candidate.y; y <= y2; y += 3) {
      for (let x = candidate.x; x <= x2; x += 3) {
        total++;

        if (motionMap[y * width + x]) {
          motionPixels++;
        }
      }
    }

    const motionRatio = motionPixels / Math.max(1, total);

    candidate.score += motionRatio * 20;
  }

  candidates.sort((a, b) => b.score - a.score);

  console.log("\nTop rectangle candidates:");

  console.table(
    candidates.slice(0, 10).map((candidate) => ({
      x: candidate.x,
      y: candidate.y,
      width: candidate.width,
      height: candidate.height,
      score: candidate.score.toFixed(2),
    })),
  );

  return candidates[0] ?? null;
}

/* ========================================================================== */
/* REFINE BOUNDARIES                                                          */
/* ========================================================================== */

/*
 * The projection gives us a rough rectangle.
 *
 * Now refine each side independently.
 *
 * IMPORTANT:
 *
 * We only REMOVE pixels here.
 *
 * We never expand the detected rectangle.
 *
 * This specifically prevents the left/bottom border problem
 * you were seeing.
 *
 * FIX:
 *
 * A row/column is only accepted as "real video content" if it's
 * BOTH non-background AND shows motion. Static overlay text is
 * non-background but has ~0 motion across the sampled frames, so
 * this keeps caption/border rows from being mistaken for the top
 * (or any other edge) of the actual video region.
 *
 * We also require several CONSECUTIVE rows/columns to pass before
 * accepting a boundary, so a single noisy row can't halt the trim
 * early.
 */

function refineRectangle(
  rectangle,
  nonBackgroundMap,
  motionMap,
  width,
  height,
) {
  let { x, y, width: w, height: h } = rectangle;

  const originalRight = x + w - 1;

  const originalBottom = y + h - 1;

  /*
   * Minimum amount of content required on a row/column.
   */

  const rowThreshold = Math.max(0.08, CONFIG.rowVideoRatio * 0.45);

  const columnThreshold = Math.max(0.08, CONFIG.columnVideoRatio * 0.45);

  /*
   * A column counts as "real content" only if it's non-background
   * AND shows motion.
   */
  function columnIsContent(col, top, bottom, threshold) {
    let contentCount = 0;
    let motionCount = 0;
    let total = 0;

    for (let yy = top; yy <= bottom; yy += 2) {
      total++;

      if (nonBackgroundMap[yy * width + col]) {
        contentCount++;
      }

      if (motionMap[yy * width + col]) {
        motionCount++;
      }
    }

    const contentRatio = contentCount / Math.max(1, total);
    const motionRatio = motionCount / Math.max(1, total);

    return (
      contentRatio >= threshold && motionRatio >= CONFIG.refineMotionMinRatio
    );
  }

  /*
   * A row counts as "real content" only if it's non-background
   * AND shows motion.
   */
  function rowIsContent(row, left, right, threshold) {
    let contentCount = 0;
    let motionCount = 0;
    let total = 0;

    for (let xx = left; xx <= right; xx += 2) {
      total++;

      if (nonBackgroundMap[row * width + xx]) {
        contentCount++;
      }

      if (motionMap[row * width + xx]) {
        motionCount++;
      }
    }

    const contentRatio = contentCount / Math.max(1, total);
    const motionRatio = motionCount / Math.max(1, total);

    return (
      contentRatio >= threshold && motionRatio >= CONFIG.refineMotionMinRatio
    );
  }

  /*
   * Walk inward from `from` toward `to` (inclusive), one step at a
   * time. Only accept a boundary once `refineConsecutive` positions
   * in a row satisfy `isContentFn`. Returns the position of the
   * FIRST line of that consecutive run (the true edge).
   *
   * Falls back to the original edge (`from`) if no stable run of
   * content is ever found, so we never expand past the initially
   * detected rectangle.
   */
  function scan(from, to, step, isContentFn) {
    let pos = from;

    let runStart = -1;

    let run = 0;

    while (pos !== to + step) {
      if (isContentFn(pos)) {
        if (run === 0) {
          runStart = pos;
        }

        run++;

        if (run >= CONFIG.refineConsecutive) {
          return runStart;
        }
      } else {
        run = 0;

        runStart = -1;
      }

      pos += step;
    }

    return from;
  }

  /*
   * LEFT / RIGHT first, using the original top/bottom as the
   * scanning bounds.
   */

  x = scan(x, originalRight, 1, (col) =>
    columnIsContent(col, y, originalBottom, columnThreshold),
  );

  let right = scan(originalRight, x, -1, (col) =>
    columnIsContent(col, y, originalBottom, columnThreshold),
  );

  /*
   * TOP / BOTTOM next, now using the refined left/right so the
   * row check isn't polluted by side padding.
   */

  y = scan(y, originalBottom, 1, (row) =>
    rowIsContent(row, x, right, rowThreshold),
  );

  let bottom = scan(originalBottom, y, -1, (row) =>
    rowIsContent(row, x, right, rowThreshold),
  );

  /*
   * Final rectangle.
   */

  return {
    x,
    y,

    width: right - x + 1,

    height: bottom - y + 1,
  };
}

/* ========================================================================== */
/* SCALE CROP                                                                */
/* ========================================================================== */

function scaleCrop(
  crop,
  analysisWidth,
  analysisHeight,
  originalWidth,
  originalHeight,
) {
  const scaleX = originalWidth / analysisWidth;

  const scaleY = originalHeight / analysisHeight;

  let x = Math.round(crop.x * scaleX);

  let y = Math.round(crop.y * scaleY);

  let width = Math.round(crop.width * scaleX);

  let height = Math.round(crop.height * scaleY);

  /*
   * FFmpeg crop dimensions should preferably be even
   * for H.264/YUV formats.
   */

  x -= x % 2;
  y -= y % 2;

  width -= width % 2;
  height -= height % 2;

  /*
   * Clamp.
   */

  x = Math.max(0, Math.min(x, originalWidth - 2));

  y = Math.max(0, Math.min(y, originalHeight - 2));

  width = Math.min(width, originalWidth - x);

  height = Math.min(height, originalHeight - y);

  width -= width % 2;
  height -= height % 2;

  return {
    x,
    y,
    width,
    height,
  };
}

/* ========================================================================== */
/* OCR                                                                       */
/* ========================================================================== */

async function extractText(image) {
  console.log("\nRunning Tesseract OCR...");

  const worker = await Tesseract.createWorker(CONFIG.ocrLanguage);

  try {
    const result = await worker.recognize(image);

    return result.data.text
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } finally {
    await worker.terminate();
  }
}

/* ========================================================================== */
/* CROP VIDEO                                                                 */
/* ========================================================================== */

function cropVideo(input, output, crop) {
  return new Promise((resolve, reject) => {
    const filter = `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`;

    console.log("\nCrop filter:", filter);

    ffmpeg(input)
      .videoFilters(filter)

      .outputOptions([
        "-c:v",
        "libx264",

        "-preset",
        "medium",

        "-crf",
        "18",

        "-c:a",
        "aac",

        "-movflags",
        "+faststart",
      ])

      .on("start", (command) => {
        console.log("\nFFmpeg crop command:");

        console.log(command);
      })

      .on("progress", (progress) => {
        if (typeof progress.percent === "number") {
          process.stdout.write(`\rEncoding: ${progress.percent.toFixed(1)}%`);
        }
      })

      .on("error", reject)

      .on("end", () => {
        console.log("\n\nEncoding complete.");

        resolve();
      })

      .save(output);
  });
}

/* ========================================================================== */
/* MAIN                                                                       */
/* ========================================================================== */

async function processVideo(input, output) {
  console.log("==========================================");

  console.log("TEXT + VIDEO EXTRACTOR");

  console.log("==========================================");

  /* ---------------------------------------------------------------------- */
  /* VIDEO INFO                                                             */
  /* ---------------------------------------------------------------------- */

  const info = await getVideoInfo(input);

  console.log(`Resolution: ${info.width}x${info.height}`);

  console.log(`Duration: ${info.duration.toFixed(2)}s`);

  console.log(`FPS: ${info.fps.toFixed(2)}`);

  /* ---------------------------------------------------------------------- */
  /* TEMP DIRECTORY                                                         */
  /* ---------------------------------------------------------------------- */

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "video-extractor-"));

  try {
    /* -------------------------------------------------------------------- */
    /* SAMPLE                                                               */
    /* -------------------------------------------------------------------- */

    const framePaths = await extractFrames(
      input,
      temp,
      info.duration,
      CONFIG.samples,
    );

    console.log(`Extracted ${framePaths.length} frames.`);

    /* -------------------------------------------------------------------- */
    /* OCR                                                                  */
    /* -------------------------------------------------------------------- */

    /*
     * Use a frame near the middle for OCR.
     */

    const ocrFrame = framePaths[Math.floor(framePaths.length / 2)];

    const text = await extractText(ocrFrame);

    /* -------------------------------------------------------------------- */
    /* ANALYSIS SIZE                                                        */
    /* -------------------------------------------------------------------- */

    const analysisWidth = Math.min(CONFIG.analysisWidth, info.width);

    const analysisHeight = Math.round(
      info.height * (analysisWidth / info.width),
    );

    console.log(`\nAnalysis resolution: ${analysisWidth}x${analysisHeight}`);

    /* -------------------------------------------------------------------- */
    /* LOAD FRAMES                                                          */
    /* -------------------------------------------------------------------- */

    const frames = [];

    for (const framePath of framePaths) {
      frames.push(await loadFrame(framePath, analysisWidth, analysisHeight));
    }

    /* -------------------------------------------------------------------- */
    /* BACKGROUND                                                            */
    /* -------------------------------------------------------------------- */

    const background = getBackgroundColor(frames);

    console.log("\nDetected background:", background);

    /* -------------------------------------------------------------------- */
    /* NON-BACKGROUND                                                        */
    /* -------------------------------------------------------------------- */

    console.log("\nDetecting persistent video region...");

    const nonBackgroundMap = buildTemporalNonBackgroundMap(frames, background);

    /* -------------------------------------------------------------------- */
    /* MOTION                                                               */
    /* -------------------------------------------------------------------- */

    console.log("Detecting motion...");

    const motionMap = createMotionMap(frames);

    /* -------------------------------------------------------------------- */
    /* RECTANGLE                                                             */
    /* -------------------------------------------------------------------- */

    console.log("Finding video rectangle...");

    let crop = detectVideoRectangle(
      nonBackgroundMap,
      motionMap,
      analysisWidth,
      analysisHeight,
    );

    if (!crop) {
      console.warn("\nVideo rectangle could not be detected.");

      crop = {
        x: 0,
        y: 0,

        width: analysisWidth,

        height: analysisHeight,
      };
    }

    console.log("\nInitial rectangle:");

    console.log(crop);

    /* -------------------------------------------------------------------- */
    /* REFINE                                                               */
    /* -------------------------------------------------------------------- */

    crop = refineRectangle(
      crop,
      nonBackgroundMap,
      motionMap,
      analysisWidth,
      analysisHeight,
    );

    console.log("\nRefined rectangle:");

    console.log(crop);

    /* -------------------------------------------------------------------- */
    /* SCALE                                                                */
    /* -------------------------------------------------------------------- */

    const finalCrop = scaleCrop(
      crop,
      analysisWidth,
      analysisHeight,
      info.width,
      info.height,
    );

    console.log("\n==========================================");

    console.log("FINAL CROP");

    console.log("==========================================");

    console.log(finalCrop);

    /* -------------------------------------------------------------------- */
    /* CROP VIDEO                                                           */
    /* -------------------------------------------------------------------- */

    await cropVideo(input, output, finalCrop);

    /* -------------------------------------------------------------------- */
    /* RESULT                                                               */
    /* -------------------------------------------------------------------- */

    console.log("\n==========================================");

    console.log("RESULT");

    console.log("==========================================");

    console.log("\nTEXT:");

    console.log(text || "(No text detected)");

    console.log("\nCROPPED VIDEO:");

    console.log(output);

    console.log("\nCROP:");

    console.log(finalCrop);

    return {
      text,
      video: output,
      crop: finalCrop,
    };
  } finally {
    /* -------------------------------------------------------------------- */
    /* CLEANUP                                                              */
    /* -------------------------------------------------------------------- */

    await fs.rm(temp, {
      recursive: true,
      force: true,
    });
  }
}

/* ========================================================================== */
/* CLI                                                                        */
/* ========================================================================== */

const input = process.argv[2];

const output = process.argv[3] || "cropped.mp4";

if (!input) {
  console.error("\nUsage:");

  console.error("node process-video.js input.mp4 output.mp4");

  process.exit(1);
}

processVideo(input, output).catch((error) => {
  console.error("\n==========================================");

  console.error("PROCESSING FAILED");

  console.error("==========================================");

  console.error(error);

  process.exit(1);
});
