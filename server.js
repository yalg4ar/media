const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Directories
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use('/downloads', express.static(DOWNLOADS_DIR));

// Rate limiter — 20 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, please slow down.' }
});
app.use('/api/', limiter);

// In-memory job store  { id: { status, progress, filename, url, error, created } }
const jobs = {};

// Clean up jobs older than 1 hour and their files
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of Object.entries(jobs)) {
    if (job.created < cutoff) {
      if (job.filepath && fs.existsSync(job.filepath)) fs.unlinkSync(job.filepath);
      delete jobs[id];
    }
  }
}, 15 * 60 * 1000);

// ─── Helper: detect yt-dlp binary ────────────────────────────────────────────
function getYtDlpBin() {
  const candidates = [
    '/opt/venv/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    path.join(process.env.LOCALAPPDATA || '', 'Python', 'pythoncore-3.15-64', 'Scripts', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'Scripts', 'yt-dlp.exe'),
    path.join(process.env.APPDATA || '', 'Python', 'Python312', 'Scripts', 'yt-dlp.exe'),
    'yt-dlp.exe',
    'yt-dlp',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
    try {
      const { execSync } = require('child_process');
      execSync(`"${c}" --version`, { stdio: 'ignore' });
      return c;
    } catch { /* skip */ }
  }
  return 'yt-dlp'; // fallback
}

function getFfmpegDir() {
  const candidates = [
    path.join(__dirname, 'ffmpeg.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Python', 'pythoncore-3.15-64', 'Scripts', 'ffmpeg.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return path.dirname(c);
    }
  }
  return null;
}

const YT_DLP = getYtDlpBin();
const FFMPEG_DIR = getFfmpegDir();

// ─── POST /api/info — fetch video metadata ────────────────────────────────────
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL is required' });

  const args = [
    '--dump-json',
    '--no-playlist',
    '--flat-playlist',
    url
  ];

  let stdout = '';
  let stderr = '';
  const proc = spawn(YT_DLP, args);
  proc.stdout.on('data', d => stdout += d.toString());
  proc.stderr.on('data', d => stderr += d.toString());

  proc.on('close', code => {
    if (code !== 0) {
      return res.status(400).json({ error: stderr.split('\n').find(l => l.includes('ERROR')) || 'Failed to fetch info' });
    }
    try {
      // yt-dlp may output multiple JSON objects for playlists; take the first
      const info = JSON.parse(stdout.trim().split('\n')[0]);
      const formats = (info.formats || []).map(f => ({
        format_id: f.format_id,
        ext: f.ext,
        resolution: f.resolution || (f.height ? `${f.height}p` : null),
        fps: f.fps,
        filesize: f.filesize,
        vcodec: f.vcodec,
        acodec: f.acodec,
        format_note: f.format_note,
        tbr: f.tbr,
      }));

      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        uploader: info.uploader,
        platform: info.extractor_key,
        formats,
        webpage_url: info.webpage_url || url,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse metadata' });
    }
  });
});

// ─── POST /api/download — start a download job ───────────────────────────────
app.post('/api/download', (req, res) => {
  const { url, format, type } = req.body; // type: 'video' | 'audio'
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const jobId = uuidv4();
  const outputTemplate = path.join(DOWNLOADS_DIR, `${jobId}.%(ext)s`);

  let args = ['--no-playlist', '--output', outputTemplate, '--newline'];

  if (FFMPEG_DIR) {
    args.push('--ffmpeg-location', FFMPEG_DIR);
  }

  if (type === 'audio') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else if (format) {
    args.push('--format', format);
  } else {
    // Best video + audio merged
    args.push('--format', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4');
  }

  args.push(url);

  jobs[jobId] = { status: 'starting', progress: 0, filename: null, filepath: null, url, error: null, created: Date.now() };
  res.json({ jobId });

  // Start download in background
  const proc = spawn(YT_DLP, args);

  proc.stdout.on('data', data => {
    const line = data.toString();
    // Parse progress lines: [download]  45.3% of   12.34MiB at    1.23MiB/s ETA 00:08
    const pct = line.match(/\[download\]\s+([\d.]+)%/);
    if (pct) jobs[jobId].progress = parseFloat(pct[1]);
    if (line.includes('[download] Destination:')) jobs[jobId].status = 'downloading';
    if (line.includes('Merging formats')) jobs[jobId].status = 'merging';
  });

  proc.stderr.on('data', data => {
    const line = data.toString();
    if (line.toLowerCase().includes('error')) {
      jobs[jobId].error = line.trim();
    }
  });

  proc.on('close', code => {
    if (code !== 0) {
      jobs[jobId].status = 'error';
      jobs[jobId].error = jobs[jobId].error || 'Download failed';
      return;
    }
    // Find the produced file
    const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(jobId));
    if (files.length) {
      const file = files[0];
      jobs[jobId].filepath = path.join(DOWNLOADS_DIR, file);
      jobs[jobId].filename = file;
      jobs[jobId].status = 'done';
      jobs[jobId].progress = 100;
    } else {
      jobs[jobId].status = 'error';
      jobs[jobId].error = 'Output file not found';
    }
  });
});

// ─── GET /api/status/:id — poll job status ────────────────────────────────────
app.get('/api/status/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    status: job.status,
    progress: job.progress,
    filename: job.filename,
    error: job.error,
  });
});

// ─── GET /api/file/:id — serve completed file ─────────────────────────────────
app.get('/api/file/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'File not ready' });
  res.download(job.filepath, job.filename);
});

app.listen(PORT, () => {
  console.log(`\n🚀 Media Downloader running at http://localhost:${PORT}\n`);
  console.log(`   yt-dlp binary: ${YT_DLP}`);
  console.log(`   ffmpeg dir:    ${FFMPEG_DIR || 'Not found'}\n`);
});
