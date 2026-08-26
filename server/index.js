import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import processRoute from "./routes/process.js";
import exportRoute from "./routes/export.js";
import { cleanUploads } from "./lib/ffmpeg.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "../client")));

app.use("/api/process", processRoute);
app.use("/api/export", exportRoute);

// Periodic cleanup of stale uploads
setInterval(cleanUploads, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Video editor running on http://localhost:${PORT}`);
});
