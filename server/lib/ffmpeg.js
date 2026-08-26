import ffmpeg from "fluent-ffmpeg";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { spawn } from "child_process";
import { UPLOADS_DIR } from "./paths.js";

/**
 * Get video metadata via ffprobe.
 * @param {string} filePath
 * @returns {Promise<{width:number, height:number, duration:number, fps:number}>}
 */
export function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const videoStream = metadata.streams.find(
        (s) => s.codec_type === "video"
      );
      if (!videoStream) return reject(new Error("No video stream found"));

      const [numStr, denStr] = (videoStream.r_frame_rate || "30/1").split("/");
      const fps = Number(numStr) / Number(denStr);

      resolve({
        width: videoStream.width,
        height: videoStream.height,
        duration: parseFloat(metadata.format.duration) || 0,
        fps,
      });
    });
  });
}

/**
 * Extract N evenly-spaced frames from a video as raw rgb24 buffers.
 * Returns an array of {data: Buffer, width: number, height: number}.
 *
 * Uses ffmpeg rawvideo pipe — no temp files.
 *
 * @param {string} filePath
 * @param {number} count  number of frames to sample
 * @param {number} analysisWidth  scale frames to this width before returning
 * @param {{width:number,height:number,duration:number,fps:number}} info
 * @returns {Promise<Array<{data:Buffer, width:number, height:number}>>}
 */
export async function extractFrames(filePath, count, analysisWidth, info) {
  const scaledHeight = Math.round(
    (analysisWidth / info.width) * info.height
  );
  const bytesPerFrame = analysisWidth * scaledHeight * 3;

  // Build evenly-spaced timestamp list (skip first/last 2%)
  const timestamps = [];
  for (let i = 0; i < count; i++) {
    const t = info.duration * (0.02 + (0.96 * i) / Math.max(1, count - 1));
    timestamps.push(t);
  }

  return Promise.all(
    timestamps.map((t) => extractSingleFrame(filePath, t, analysisWidth, scaledHeight, bytesPerFrame))
  );
}

function extractSingleFrame(filePath, timestamp, width, height, bytesPerFrame) {
  return new Promise((resolve, reject) => {
    const args = [
      "-ss", String(timestamp),
      "-i", filePath,
      "-vframes", "1",
      "-vf", `scale=${width}:${height}`,
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "-",
    ];

    const proc = spawn("ffmpeg", args);
    const chunks = [];
    let stderr = "";

    proc.stdout.on("data", (chunk) => chunks.push(chunk));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      const buf = Buffer.concat(chunks);
      if (buf.length < bytesPerFrame) {
        // Frame extraction failed (e.g. past end of file) — skip silently
        return resolve(null);
      }
      resolve({ data: buf.subarray(0, bytesPerFrame), width, height });
    });
    proc.on("error", reject);
  });
}

/**
 * Write a single frame at timestamp `t` (seconds) to a PNG file.
 * @param {string} filePath
 * @param {number} t  seconds
 * @param {string} outPath
 * @returns {Promise<void>}
 */
export function writeFrameAsPng(filePath, t, outPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-ss", String(t),
      "-i", filePath,
      "-vframes", "1",
      "-y",
      outPath,
    ]);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-200)}`));
    });
    proc.on("error", reject);
  });
}

/**
 * Crop + trim + add drawtext overlays + encode to output file.
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {{x:number,y:number,width:number,height:number}} crop
 * @param {{start:number, end:number}} trim  seconds
 * @param {Array<{text:string, x:number, y:number, fontSize:number, color:string}>} textBlocks
 */
export function encodeVideo(inputPath, outputPath, crop, trim, textBlocks) {
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(inputPath)
      .seekInput(trim.start)
      .duration(trim.end - trim.start);

    // Build vf filter chain
    const filters = [
      `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
    ];

    for (const block of textBlocks) {
      const safeText = block.text.replace(/'/g, "\\'").replace(/:/g, "\\:");
      const colorHex = block.color.replace("#", "");
      filters.push(
        `drawtext=text='${safeText}':x=${Math.round(block.x)}:y=${Math.round(
          block.y
        )}:fontsize=${Math.round(block.fontSize)}:fontcolor=0x${colorHex}:box=0`
      );
    }

    cmd
      .videoFilter(filters.join(","))
      .outputOptions([
        "-c:v", "libx264",
        "-crf", "18",
        "-preset", "fast",
        "-c:a", "aac",
        "-movflags", "+faststart",
      ])
      .on("error", reject)
      .on("end", resolve)
      .save(outputPath);
  });
}

/**
 * Delete upload directories older than 1 hour.
 */
export async function cleanUploads() {
  try {
    const entries = await fs.readdir(UPLOADS_DIR, { withFileTypes: true });
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(UPLOADS_DIR, entry.name);
      const stat = await fs.stat(dir);
      if (stat.mtimeMs < cutoff) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  } catch {
    // Non-fatal
  }
}
