import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import os from "os";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

const app = express();
app.use(cors());

// log every request (THIS is what you’re missing right now)
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// If you use JSON endpoints elsewhere
app.use(express.json({ limit: "2mb" }));

// Tell fluent-ffmpeg to use bundled ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

const PORT = process.env.PORT || 10000;

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

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

// ✅ This is the endpoint your n8n node must call
app.post("/extract-audio", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.path) {
      return res.status(400).json({
        error: "Missing file. Send form-data with field name 'file'.",
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
      fs.unlink(inputPath, () => {});
      fs.unlink(outPath, () => {});
    });

    stream.pipe(res);
  } catch (err) {
    console.error("extract-audio error:", err);
    res.status(500).json({ error: "Failed to extract audio" });
  }
});

// Helpful 404 logger (so you see wrong paths instantly)
app.use((req, res) => {
  console.log(`[404] No route for ${req.method} ${req.url}`);
  res.status(404).send(`No route for ${req.method} ${req.url}`);
});

app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
});
