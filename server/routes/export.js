import express from "express";
import path from "path";
import fs from "fs/promises";
import { createReadStream } from "fs";
import { encodeVideo } from "../lib/ffmpeg.js";
import { UPLOADS_DIR } from "../lib/paths.js";

const router = express.Router();

/**
 * POST /api/export
 * Body: { jobId, crop, trim, textBlocks }
 *   crop: { x, y, width, height }
 *   trim: { start, end }  — seconds
 *   textBlocks: [{ text, x, y, fontSize, color }]
 *
 * Streams the output MP4 directly to the client.
 */
router.post("/", express.json(), async (req, res) => {
  const { jobId, crop, trim, textBlocks = [] } = req.body;

  if (!jobId || !crop || !trim) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const jobDir = path.join(UPLOADS_DIR, jobId);

  // Find the input file (could be .mp4, .mov, etc.)
  let inputPath;
  try {
    const entries = await fs.readdir(jobDir);
    const input = entries.find((e) => e.startsWith("input"));
    if (!input) throw new Error("Input file not found");
    inputPath = path.join(jobDir, input);
  } catch (err) {
    return res.status(404).json({ error: "Job not found" });
  }

  const outputPath = path.join(jobDir, "output.mp4");

  try {
    await encodeVideo(inputPath, outputPath, crop, trim, textBlocks);

    const stat = await fs.stat(outputPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="export.mp4"');
    res.setHeader("Content-Length", stat.size);

    const stream = createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end", () => {
      // Clean up output after sending
      fs.unlink(outputPath).catch(() => {});
    });
  } catch (err) {
    console.error("Export error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
