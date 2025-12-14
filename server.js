import express from "express";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "50mb" }));

/**
 * ✅ HEALTH CHECK
 * This MUST return "OK" in the browser
 */
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

/**
 * 🎬 STITCH VIDEOS
 * POST /stitch
 * Body:
 * {
 *   "clips": ["https://...", "https://..."]
 * }
 */
app.post("/stitch", async (req, res) => {
  try {
    const { clips } = req.body;

    if (!Array.isArray(clips) || clips.length < 2) {
      return res.status(400).json({
        error: "You must provide at least 2 video URLs",
      });
    }

    const jobId = uuidv4();
    const workDir = path.join("/tmp", jobId);
    fs.mkdirSync(workDir, { recursive: true });

    const localClips = [];

    // ⬇️ Download each clip
    for (let i = 0; i < clips.length; i++) {
      const clipUrl = clips[i];
      const clipPath = path.join(workDir, `clip_${i}.mp4`);

      const response = await fetch(clipUrl);
      if (!response.ok) {
        throw new Error(`Failed to download clip ${i}`);
      }

      const buffer = await response.arrayBuffer();
      fs.writeFileSync(clipPath, Buffer.from(buffer));
      localClips.push(clipPath);
    }

    // 📝 Create concat file
    const concatFile = path.join(workDir, "concat.txt");
    const concatContent = localClips
      .map((p) => `file '${p}'`)
      .join("\n");

    fs.writeFileSync(concatFile, concatContent);

    // 🎥 Output file
    const outputPath = path.join(workDir, "final.mp4");

    // 🔗 Run ffmpeg
    ffmpeg()
      .input(concatFile)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy"])
      .save(outputPath)
      .on("end", () => {
        res.download(outputPath, "stitched.mp4", () => {
          // 🧹 Cleanup
          fs.rmSync(workDir, { recursive: true, force: true });
        });
      })
      .on("error", (err) => {
        console.error("FFmpeg error:", err);
        res.status(500).json({ error: "FFmpeg failed" });
      });

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🚀 START SERVER
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Video stitch API running on port ${PORT}`);
});
