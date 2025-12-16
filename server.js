import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

// --- App setup ---
const app = express();
app.use(cors());

// IMPORTANT: Render / proxies may send JSON; allow big bodies for clip arrays
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Log every request so you can instantly see the path being hit
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// Tell fluent-ffmpeg to use bundled ffmpeg binary
ffmpeg.setFfmpegPath(ffmpegPath);

const PORT = process.env.PORT || 10000;

// --- Basic routes ---
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "video-stitch-api",
    endpoints: {
      health: "GET /health",
      stitch: "POST /stitch  (also /api/stitch)",
      extractAudio: "POST /extract-audio  (also /api/extract-audio)",
    },
  });
});

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// --- Multer for file upload (extract-audio) ---
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB
});

// --- Helpers ---
function tmpFile(ext) {
  const name = `tmp_${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`;
  return path.join(os.tmpdir(), name);
}

async function fetchWithRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        // Some hosts block default UA; setting one helps
        headers: { "User-Agent": "video-stitch-api/1.0" },
      });
      if (!res.ok) {
        throw new Error(`Fetch failed (${res.status}) for ${url}`);
      }
      return res;
    } catch (e) {
      lastErr = e;
      // small backoff
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function downloadUrlToFile(url, outPath) {
  const res = await fetchWithRetry(url, 3);
  const fileStream = fs.createWriteStream(outPath);
  await pipeline(res.body, fileStream);
  return outPath;
}

function safeUnlink(p) {
  try {
    fs.unlinkSync(p);
  } catch {}
}

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// --- Stitch endpoint implementation ---
async function handleStitch(req, res) {
  try {
    const { clips } = req.body ?? {};

    if (!Array.isArray(clips) || clips.length < 1) {
      return res.status(400).json({
        error: "Missing or invalid 'clips'. Expected JSON body: { clips: [url1, url2, ...] }",
      });
    }

    // Download all clips to temp
    const downloaded = [];
    for (let i = 0; i < clips.length; i++) {
      const url = clips[i];
      if (typeof url !== "string" || !url.startsWith("http")) {
        return res.status(400).json({ error: `clips[${i}] is not a valid URL` });
      }

      const outPath = tmpFile("mp4");
      console.log(`[STITCH] Downloading clip ${i + 1}/${clips.length}: ${url}`);
      await downloadUrlToFile(url, outPath);
      downloaded.push(outPath);
    }

    // Output path
    const outPath = tmpFile("mp4");

    // Use concat demuxer (safe, consistent). We re-encode to avoid codec mismatch issues.
    const listPath = tmpFile("txt");
    const listFile = downloaded
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    fs.writeFileSync(listPath, listFile, "utf-8");

    console.log("[STITCH] Running ffmpeg concat...");

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(["-f concat", "-safe 0"])
        .outputOptions([
          "-movflags +faststart",
          "-c:v libx264",
          "-pix_fmt yuv420p",
          "-preset veryfast",
          "-crf 20",
          "-c:a aac",
          "-b:a 128k",
        ])
        .on("start", (cmd) => console.log("[FFMPEG]", cmd))
        .on("error", (err) => reject(err))
        .on("end", () => resolve())
        .save(outPath);
    });

    // Cleanup temp inputs + list
    safeUnlink(listPath);
    for (const p of downloaded) safeUnlink(p);

    // Stream the stitched mp4 back
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="stitched.mp4"');

    const stream = fs.createReadStream(outPath);
    stream.on("close", () => safeUnlink(outPath));
    stream.pipe(res);
  } catch (err) {
    console.error("stitch error:", err);
    res.status(500).json({
      error: "Failed to stitch clips",
      details: String(err?.message || err),
    });
  }
}

// ✅ BOTH routes supported so n8n works even if you call /api/stitch
app.post("/stitch", handleStitch);
app.post("/api/stitch", handleStitch);

// --- Extract audio (mp3) ---
async function handleExtractAudio(req, res) {
  try {
    if (!req.file?.path) {
      return res.status(400).json({
        error: "Missing file. Send multipart/form-data with field name 'file'.",
      });
    }

    const inputPath = req.file.path;
    const outPath = path.join(os.tmpdir(), `${path.parse(inputPath).name}.mp3`);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .noVideo()
        .audioCodec("libmp3lame")
        .audioBitrate("128k")
        .output(outPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", 'attachment; filename="audio.mp3"');

    const stream = fs.createReadStream(outPath);
    stream.on("close", () => {
      safeUnlink(inputPath);
      safeUnlink(outPath);
    });
    stream.pipe(res);
  } catch (err) {
    console.error("extract-audio error:", err);
    res.status(500).json({ error: "Failed to extract audio", details: String(err?.message || err) });
  }
}

app.post("/extract-audio", upload.single("file"), handleExtractAudio);
app.post("/api/extract-audio", upload.single("file"), handleExtractAudio);

// Helpful 404 logger
app.use((req, res) => {
  console.log(`[404] No route for ${req.method} ${req.url}`);
  res.status(404).send(`No route for ${req.method} ${req.url}`);
});

app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
});
