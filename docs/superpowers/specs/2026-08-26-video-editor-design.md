# Video Editor — Design Spec

**Date:** 2026-08-26  
**Status:** Approved

---

## Overview

A web-based video editor that automatically detects and crops embedded video content from a screen recording or padded video, extracts any visible text via OCR, then lets the user add/edit text overlays, trim the video, and export the final result.

Stack: Express (Node.js) + plain HTML/CSS/JS + Tailwind CSS (CDN). Deployed on Railway.

---

## Architecture

```
/
├── server/
│   ├── index.js          — Express app, serves static client, mounts API routes
│   ├── routes/
│   │   ├── process.js    — POST /api/process (upload → crop → OCR)
│   │   └── export.js     — POST /api/export (crop + trim + text → encoded video)
│   ├── lib/
│   │   ├── detector.js   — v.js crop detection logic (background, motion, projection)
│   │   ├── ocr.js        — Tesseract.js wrapper
│   │   └── ffmpeg.js     — fluent-ffmpeg helpers (extract frames, crop, drawtext, trim)
│   └── uploads/          — temp storage (auto-cleaned after each request)
├── client/
│   ├── index.html        — single page app shell
│   ├── css/
│   │   └── app.css       — custom styles on top of Tailwind CDN
│   └── js/
│       ├── app.js        — main entry, upload flow, state
│       ├── editor.js     — canvas preview, drag/resize text blocks
│       ├── timeline.js   — trim scrubber (in/out handles)
│       ├── textPanel.js  — right panel: add/remove/edit text blocks
│       └── exporter.js   — calls POST /api/export, triggers download
├── package.json
├── .gitignore
└── railway.toml          — Railway deployment config
```

---

## API

### `POST /api/process`

**Request:** `multipart/form-data` with field `video` (file upload).

**Steps (server):**
1. Save uploaded file to `uploads/<uuid>/input.<ext>`
2. Call `getVideoInfo` (ffprobe) — get width, height, duration, fps
3. Extract `CONFIG.samples` frames via FFmpeg fps filter
4. Run crop detection (`detector.js`) — returns `{ x, y, width, height }`
5. Run OCR (`ocr.js`) on middle frame — returns text string
6. Clean up extracted frames (keep input file for export)

**Response:**
```json
{
  "jobId": "uuid",
  "video": { "width": 1920, "height": 1080, "duration": 42.5, "fps": 30 },
  "crop": { "x": 120, "y": 60, "width": 1680, "height": 960 },
  "text": "Detected OCR text here..."
}
```

---

### `POST /api/export`

**Request:** `application/json`
```json
{
  "jobId": "uuid",
  "crop": { "x": 120, "y": 60, "width": 1680, "height": 960 },
  "trim": { "start": 2.5, "end": 38.0 },
  "textBlocks": [
    {
      "id": "t1",
      "text": "Hello World",
      "x": 100,
      "y": 50,
      "fontSize": 32,
      "color": "#ffffff",
      "opacity": 1.0,
      "startTime": 0,
      "endTime": 10
    }
  ],
  "burnIn": true
}
```

**Steps (server):**
1. Look up input file by `jobId`
2. Build FFmpeg filter chain:
   - `crop=w:h:x:y`
   - `trim=start:end, setpts=PTS-STARTPTS` (if trim set)
   - `drawtext=...` per text block (if `burnIn: true`)
3. Encode with `libx264`, `crf 18`, `aac` audio, `+faststart`
4. Stream output file back as `video/mp4` download
5. Clean up job directory

**If `burnIn: false`:** Export clean video + respond with video URL and the `textBlocks` JSON as a sidecar (client downloads both).

---

## Frontend

### Layout (shadcn-inspired, Tailwind)

```
┌─────────────────────────────────────────────────────┐
│  HEADER — title, upload button                       │
├──────────────────────────┬──────────────────────────┤
│                          │  TEXT BLOCKS PANEL        │
│  VIDEO PREVIEW           │  [+ Add Text]             │
│  (canvas)                │  ┌─────────────────────┐  │
│                          │  │ Block 1             │  │
│  drag text blocks        │  │ text / color / size │  │
│  directly on canvas      │  │ position / timing   │  │
│                          │  └─────────────────────┘  │
├──────────────────────────┴──────────────────────────┤
│  TIMELINE — scrubber, trim handles (in/out)          │
├─────────────────────────────────────────────────────┤
│  OCR TEXT (collapsible)  │  [Burn-in ○ Overlay]      │
│                          │  [Export & Download]       │
└─────────────────────────────────────────────────────┘
```

### editor.js — Canvas Editor

- Draws current video frame on `<canvas>`
- Renders each text block at its `(x, y)` with correct font/color/opacity
- Mouse events: click to select block, drag to move, corner handles to resize
- Scrubber position determines which frame is shown

### timeline.js — Trim Scrubber

- `<input type="range">` for current position
- Two draggable handles for trim in/out points
- Displays timecodes (MM:SS.ms)

### textPanel.js — Text Block Controls

Per block:
- Text content (`<textarea>`)
- Font size (`<input type="number">`)
- Color (`<input type="color">`)
- Opacity (`<input type="range" 0–1>`)
- Start/end time for timed captions (`<input type="number">`)
- Delete button

### exporter.js

- Reads current state (crop, trim, textBlocks, burnIn toggle)
- `POST /api/export` with JSON body
- Shows progress (SSE or polling `/api/export/:jobId/progress`)
- Triggers browser download on completion

---

## State Model (client)

```js
{
  jobId: string,
  videoInfo: { width, height, duration, fps },
  crop: { x, y, width, height },       // editable
  trim: { start, end },                 // editable
  textBlocks: [                         // editable array
    { id, text, x, y, fontSize, color, opacity, startTime, endTime }
  ],
  burnIn: boolean,
  ocrText: string,
  currentTime: number                   // scrubber position
}
```

State lives in `app.js`, passed to editor/timeline/textPanel via function calls (no framework needed).

---

## Crop Detection (detector.js)

Direct port of `v.js` logic — same CONFIG, same algorithms. Differences:
- No `sharp` import — frames are loaded as raw pixel buffers via `ffmpeg` piped output
- No `fs/promises` — paths handled by the route layer, detector receives buffer arrays
- Exports: `detectCrop(framePaths, videoInfo) → { x, y, width, height }`

---

## Export Progress

Use Server-Sent Events (SSE):
- `GET /api/export/:jobId/progress` — streams FFmpeg progress events
- Client `EventSource` listens, updates a progress bar
- On `end` event, client fetches the download

---

## Error Handling

- Upload: file type check (video/* only), max size 500MB
- Process: if crop detection fails, return full frame as crop (graceful fallback)
- Export: FFmpeg errors streamed back as JSON `{ error: "..." }`
- Job cleanup: cron-like `setInterval` in `index.js` deletes upload dirs older than 1 hour

---

## Deployment (Railway)

`railway.toml`:
```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "node server/index.js"
```

Environment variables:
- `PORT` — Railway sets this automatically
- `UPLOAD_DIR` — defaults to `./uploads` (Railway ephemeral disk is fine for temp files)

---

## Out of Scope

- User accounts / saved projects
- Cloud storage of processed videos
- Audio editing
- Multiple video tracks
- Mobile-optimized layout (desktop first)
