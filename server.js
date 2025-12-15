import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import os from "os";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import https from "https";
import http from "http";

const app = express();
app.use(cors());

// 🔍 log every request
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

app.use(express.json({ limit: "5mb" }));

ffmpeg.setFfmpegPath(ffmpegPath);

const PORT = process.env.PORT || 10000;

/* -------------------- HEALTH -------------------- */
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

/* -------------------- MULTER -------------------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
});

/* -------------------- EXTRACT AUDIO -------------------- */
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

/* -------------------- STITCH VIDEOS -------------------- */
function downloadFile(url, dest) {
  const proto = url.startsWith("https") ? https : http;

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    proto.get(url, response => {
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: ${url}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", reject);
  });
}

app.post("/stitch", async (req, res) => {
  try {
    const { clips } = req.body;

    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "clips must be a non-empty array" });
    }

    console.log(`[STITCH] clips: ${clips.length}`);

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "stitch-"));
    const clipPaths = [];

    // Download clips
    for (let i = 0; i < clips.length; i++) {
      const clipPath = path.join(workDir, `clip_${i}.mp4`);
      await downloadFile(clips[i], clipPath);
      clipPaths.push(clipPath);
    }

    // Create concat list
    const listPath = path.join(workDir, "list.txt");
    fs.writeFileSync(
      listPath,
      clipPaths.map(p => `file '${p}'`).join("\n")
    );

    const outputPath = path.join(workDir, "stitched.mp4");

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(["-f concat", "-safe 0"])
        .outputOptions([
          "-c copy",
          "-movflags +faststart"
        ])
        .output(outputPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="stitched.mp4"');

    const stream = fs.createReadStream(outputPath);
    stream.on("close", () => {
      fs.rm(workDir, { recursive: true, force: true }, () => {});
    });

    stream.pipe(res);
  } catch (err) {
    console.error("stitch error:", err);
    res.status(500).json({ error: "Failed to stitch videos" });
  }
});

/* -------------------- 404 -------------------- */
app.use((req, res) => {
  console.log(`[404] No route for ${req.method} ${req.url}`);
  res.status(404).send(`No route for ${req.method} ${req.url}`);
});

app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
});
