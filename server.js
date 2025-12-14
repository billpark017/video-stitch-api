import express from "express";
import fetch from "node-fetch";
import { nanoid } from "nanoid";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);
const app = express();

app.use(express.json({ limit: "10mb" }));

// Log every request (so we can see traffic in Render logs)
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

// ✅ Root + health checks
app.get("/", (_req, res) => res.status(200).send("OK-root"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true, message: "OK-health" }));

const TMP_DIR = "/tmp";
const OUT_DIR = path.join(TMP_DIR, "out");
fs.mkdirSync(OUT_DIR, { recursive: true });

async function downloadToFile(url, filepath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);

  const fileStream = fs.createWriteStream(filepath);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });
}

app.post("/stitch", async (req, res) => {
  let jobDir = null;

  try {
    const { clips } = req.body;

    if (!Array.isArray(clips) || clips.length < 2) {
      return res.status(400).json({ error: "clips must be an array of 2+ URLs" });
    }
    for (const u of clips) {
      if (typeof u !== "string" || !u.startsWith("http")) {
        return res.status(400).json({ error: "All clip URLs must start with http/https" });
      }
    }

    const jobId = nanoid();
    jobDir = path.join(TMP_DIR, `job-${jobId}`);
    fs.mkdirSync(jobDir, { recursive: true });

    // Download clips
    const filePaths = [];
    for (let i = 0; i < clips.length; i++) {
      const fp = path.join(jobDir, `part-${i + 1}.mp4`);
      await downloadToFile(clips[i], fp);
      filePaths.push(fp);
    }

    // Concat list file
    const listPath = path.join(jobDir, "files.txt");
    fs.writeFileSync(listPath, filePaths.map((fp) => `file '${fp}'`).join("\n"));

    // Output file
    const outName = `final-${jobId}.mp4`;
    const outPath = path.join(OUT_DIR, outName);

    // Concat + re-encode
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      outPath
    ]);

    // Cleanup downloads
    fs.rmSync(jobDir, { recursive: true, force: true });

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    return res.json({
      jobId,
      finalUrl: `${baseUrl}/files/${outName}`
    });
  } catch (err) {
    if (jobDir) {
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}
    }
    console.error("[ERROR]", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// Serve stitched files
app.get("/files/:name", (req, res) => {
  const fp = path.join(OUT_DIR, req.params.name);
  if (!fs.existsSync(fp)) return res.status(404).send("Not found");

  res.setHeader("Content-Type", "video/mp4");
  fs.createReadStream(fp).pipe(res);
});

// IMPORTANT: Render injects PORT. Use it.
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Stitch API listening on ${PORT}`);
});

