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

// Log every request so Render logs show what's happening
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

// Health checks
app.get("/", (_req, res) => res.status(200).send("OK-root"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true, message: "OK-health" }));

// Temp/output directories
const TMP_DIR = "/tmp";
const OUT_DIR = path.join(TMP_DIR, "out");
fs.mkdirSync(OUT_DIR, { recursive: true });

function isHttpUrl(u) {
  return typeof u === "string" && (u.startsWith("http://") || u.startsWith("https://"));
}

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

async function runFfmpegConcatCopy(listPath, outPath) {
  // Fast path: stream copy (very fast if codecs match)
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outPath
  ]);
}

async function runFfmpegConcatReencode(listPath, outPath) {
  // Slow but reliable: re-encode
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outPath
  ]);
}

/**
 * POST /stitch
 * Body: { "clips": ["https://...", "https://...", ...] }
 * Returns: { jobId, finalUrl }
 */
app.post("/stitch", async (req, res) => {
  let jobDir = null;

  try {
    const { clips } = req.body;

    console.log("[STITCH] payload received");
    console.log("[STITCH] clips type:", Array.isArray(clips) ? "array" : typeof clips);

    if (!Array.isArray(clips) || clips.length < 2) {
      return res.status(400).json({ error: "clips must be an array of 2+ URLs" });
    }
    if (clips.some((u) => !isHttpUrl(u))) {
      return res.status(400).json({ error: "All clip URLs must start with http/https" });
    }

    console.log(`[STITCH] received ${clips.length} clips`);

    const jobId = nanoid();
    jobDir = path.join(TMP_DIR, `job-${jobId}`);
    fs.mkdirSync(jobDir, { recursive: true });

    // Download clips
    const filePaths = [];
    for (let i = 0; i < clips.length; i++) {
      const fp = path.join(jobDir, `part-${i + 1}.mp4`);
      console.log(`[STITCH] downloading clip ${i + 1}/${clips.length}`);
      await downloadToFile(clips[i], fp);
      console.log(`[STITCH] downloaded clip ${i + 1}/${clips.length} -> ${fp}`);
      filePaths.push(fp);
    }

    // Create concat list file
    const listPath = path.join(jobDir, "files.txt");
    const listContent = filePaths.map((fp) => `file '${fp}'`).join("\n");
    fs.writeFileSync(listPath, listContent);
    console.log(`[STITCH] wrote concat list -> ${listPath}`);

    // Output file
    const outName = `final-${jobId}.mp4`;
    const outPath = path.join(OUT_DIR, outName);

    // Try fast concat first
    console.log("[STITCH] starting ffmpeg (fast copy concat)...");
    try {
      await runFfmpegConcatCopy(listPath, outPath);
      console.log("[STITCH] ffmpeg fast concat complete ✅");
    } catch (e) {
      console.log("[STITCH] fast concat failed, falling back to re-encode...");
      console.log("[STITCH] fast concat error:", e?.message || e);

      console.log("[STITCH] starting ffmpeg (re-encode concat)...");
      await runFfmpegConcatReencode(listPath, outPath);
      console.log("[STITCH] ffmpeg re-encode concat complete ✅");
    }

    // Cleanup downloaded parts
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
      console.log("[STITCH] cleaned up temp job dir");
    } catch (cleanupErr) {
      console.log("[STITCH] cleanup warning:", cleanupErr?.message || cleanupErr);
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const finalUrl = `${baseUrl}/files/${outName}`;

    console.log("[STITCH] returning finalUrl:", finalUrl);
    return res.json({ jobId, finalUrl });
  } catch (err) {
    console.error("[STITCH] ERROR:", err?.message || err);

    if (jobDir) {
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}
    }

    return res.status(500).json({ error: err?.message || String(err) });
  }
});

// Serve stitched files
app.get("/files/:name", (req, res) => {
  const fp = path.join(OUT_DIR, req.params.name);
  if (!fs.existsSync(fp)) return res.status(404).send("Not found");

  res.setHeader("Content-Type", "video/mp4");
  fs.createReadStream(fp).pipe(res);
});

// Fallback 404 so you can tell if responses are from your app vs Render
app.use((req, res) => {
  res.status(404).send(`APP 404: No route for ${req.method} ${req.path}`);
});

// Bind to Render port + all interfaces
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Stitch API listening on ${PORT}`);
});
