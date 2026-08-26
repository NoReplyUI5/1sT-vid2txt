import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import { getVideoInfo, extractFrames, writeFrameAsPng } from "../lib/ffmpeg.js";
import { detectCrop } from "../lib/detector.js";
import { extractText } from "../lib/ocr.js";
import { UPLOADS_DIR } from "../lib/paths.js";

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const jobId = uuidv4();
    req.jobId = jobId;
    const dir = path.join(UPLOADS_DIR, jobId);
    await fs.mkdir(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) =>
    cb(null, "input" + path.extname(file.originalname)),
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
  fileFilter: (req, file, cb) => {
    const allowed = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error("Unsupported video format"));
  },
});

const router = express.Router();

/**
 * POST /api/process
 * Accepts multipart video upload, runs crop detection + OCR.
 * Returns { jobId, info, crop, ocrText }
 */
router.post("/", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No video file uploaded" });
  }

  const jobId = req.jobId;
  const filePath = req.file.path;

  try {
    const info = await getVideoInfo(filePath);
    const ocrFramePath = path.join(path.dirname(filePath), "ocr-frame.png");

    // Run frame extraction and OCR frame write in parallel
    const [frames] = await Promise.all([
      extractFrames(filePath, 20, 640, info),
      writeFrameAsPng(filePath, info.duration / 2, ocrFramePath).catch(() => {}),
    ]);

    const crop = detectCrop(frames, info) ?? {
      x: 0,
      y: 0,
      width: info.width,
      height: info.height,
    };

    let ocrText = "";
    try {
      ocrText = await extractText(ocrFramePath);
    } catch {
      // OCR is best-effort
    } finally {
      await fs.unlink(ocrFramePath).catch(() => {});
    }

    res.json({ jobId, info, crop, ocrText });
  } catch (err) {
    console.error("Process error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
