/* ─── State ──────────────────────────────────────────────────────────────── */
let currentJob = { type: 'video', format: 'bestvideo+bestaudio/best' };
let pollTimer = null;

/* ─── DOM Refs ───────────────────────────────────────────────────────────── */
const urlInput     = document.getElementById('urlInput');
const clearBtn     = document.getElementById('clearBtn');
const fetchBtn     = document.getElementById('fetchBtn');
const errorBanner  = document.getElementById('errorBanner');
const errorMsg     = document.getElementById('errorMsg');
const loadingCard  = document.getElementById('loadingCard');
const infoCard     = document.getElementById('infoCard');
const progressCard = document.getElementById('progressCard');

/* ─── Utility ────────────────────────────────────────────────────────────── */
function showError(msg) {
  errorMsg.textContent = msg;
  errorBanner.style.display = 'flex';
  loadingCard.style.display = 'none';
}
function hideError() { errorBanner.style.display = 'none'; }

function formatDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ─── URL Input handlers ─────────────────────────────────────────────────── */
urlInput.addEventListener('input', () => {
  clearBtn.style.display = urlInput.value ? 'block' : 'none';
  hideError();
});
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchInfo(); });
clearBtn.addEventListener('click', () => {
  urlInput.value = '';
  clearBtn.style.display = 'none';
  hideError();
  infoCard.style.display = 'none';
  progressCard.style.display = 'none';
  urlInput.focus();
});

fetchBtn.addEventListener('click', fetchInfo);

/* ─── Fetch Info ─────────────────────────────────────────────────────────── */
async function fetchInfo() {
  const url = urlInput.value.trim();
  if (!url) { showError('Please enter a URL.'); return; }

  hideError();
  infoCard.style.display = 'none';
  progressCard.style.display = 'none';
  loadingCard.style.display = 'flex';
  fetchBtn.disabled = true;

  try {
    const res = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch info');
    renderInfo(data);
  } catch (e) {
    showError(e.message);
  } finally {
    loadingCard.style.display = 'none';
    fetchBtn.disabled = false;
  }
}

/* ─── Render Media Info ──────────────────────────────────────────────────── */
function renderInfo(info) {
  document.getElementById('thumbnail').src = info.thumbnail || '';
  document.getElementById('thumbnail').onerror = function() { this.style.display='none'; };
  document.getElementById('duration').textContent = formatDuration(info.duration);
  document.getElementById('mediaTitle').textContent = info.title || 'Unknown Title';
  document.getElementById('mediaUploader').textContent = info.uploader ? `by ${info.uploader}` : '';
  document.getElementById('platform-badge').textContent = info.platform || 'Video';

  // Build formats table
  const tbody = document.getElementById('formatsBody');
  tbody.innerHTML = '';
  (info.formats || []).reverse().forEach(f => {
    const isAudioOnly = f.vcodec === 'none';
    const isVideoOnly = f.acodec === 'none';
    const typeLabel = isAudioOnly ? '🎵 Audio' : isVideoOnly ? '📹 Video-only' : '🎬 A+V';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code style="font-size:0.75rem;color:#94a3b8">${f.format_id}</code></td>
      <td><span style="color:#e2e8f0">${f.ext}</span></td>
      <td>${f.resolution || (f.tbr ? `${f.tbr}k` : '—')}</td>
      <td>${typeLabel}</td>
      <td>${formatBytes(f.filesize)}</td>
      <td><button class="fmt-select-btn" data-id="${f.format_id}" data-type="${isAudioOnly ? 'audio' : 'video'}">Select</button></td>
    `;
    tbody.appendChild(tr);
  });

  // Format select buttons
  tbody.querySelectorAll('.fmt-select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      tbody.querySelectorAll('.fmt-select-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      // De-select quick buttons
      document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));
      currentJob.format = btn.dataset.id;
      currentJob.type = btn.dataset.type;
    });
  });

  infoCard.style.display = 'block';

  // Reset quick-action selection
  document.getElementById('quickBest').classList.add('active');
  currentJob = { type: 'video', format: 'bestvideo+bestaudio/best' };
}

/* ─── Quick Action Buttons ───────────────────────────────────────────────── */
document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.fmt-select-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('active');
    currentJob.type = btn.dataset.type;
    currentJob.format = btn.dataset.format || null;
  });
});

/* ─── Advanced Toggle ────────────────────────────────────────────────────── */
const advToggle = document.getElementById('advancedToggle');
const formatsPanel = document.getElementById('formatsPanel');
const advChevron = document.getElementById('advChevron');

advToggle.addEventListener('click', () => {
  const open = formatsPanel.style.display !== 'none';
  formatsPanel.style.display = open ? 'none' : 'block';
  advToggle.firstChild.textContent = open ? ' Show all formats' : ' Hide formats';
  advChevron.classList.toggle('rotated', !open);
});

/* ─── Start Download ─────────────────────────────────────────────────────── */
document.getElementById('downloadBtn').addEventListener('click', startDownload);

async function startDownload() {
  const url = urlInput.value.trim();
  if (!url) return;

  progressCard.style.display = 'block';
  progressCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setProgress(0, 'Starting download…', 'Connecting to server…');

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, type: currentJob.type, format: currentJob.format })
    });
    const { jobId, error } = await res.json();
    if (!res.ok || !jobId) throw new Error(error || 'Failed to start download');
    pollStatus(jobId);
  } catch (e) {
    setProgress(0, 'Download failed', e.message);
    document.querySelector('.progress-bar-fill').style.background = '#ef4444';
  }
}

/* ─── Poll Job Status ────────────────────────────────────────────────────── */
function pollStatus(jobId) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/status/${jobId}`);
      const data = await res.json();

      if (data.status === 'downloading') {
        setProgress(data.progress, 'Downloading…', `${data.progress.toFixed(1)}% complete`);
      } else if (data.status === 'merging') {
        setProgress(99, 'Merging formats…', 'Almost done!');
      } else if (data.status === 'done') {
        clearInterval(pollTimer);
        setProgress(100, 'Download complete!', 'Your file is ready.');
        document.querySelector('.progress-bar-fill').style.background = 'linear-gradient(90deg, #10b981, #059669)';
        // Auto-trigger download
        triggerFileDownload(jobId, data.filename);
      } else if (data.status === 'error') {
        clearInterval(pollTimer);
        setProgress(data.progress, '⚠️ Download failed', data.error || 'Unknown error');
        document.querySelector('.progress-bar-fill').style.background = '#ef4444';
      } else if (data.status === 'starting') {
        setProgress(0, 'Starting…', 'Initializing download');
      }
    } catch (e) {
      clearInterval(pollTimer);
      setProgress(0, 'Connection error', e.message);
    }
  }, 1000);
}

function setProgress(pct, title, sub) {
  document.getElementById('progressBar').style.width = `${pct}%`;
  document.getElementById('progressPct').textContent = `${pct.toFixed ? pct.toFixed(0) : pct}%`;
  document.getElementById('progressTitle').textContent = title;
  document.getElementById('progressSub').textContent = sub;
}

function triggerFileDownload(jobId, filename) {
  const a = document.createElement('a');
  a.href = `/api/file/${jobId}`;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
