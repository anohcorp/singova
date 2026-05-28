/**
 * SINGOVA – App Logic
 * Drop one MP3 → POST to /transcribe → get timestamps → play + highlight lyrics
 */
'use strict';

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  apiEndpoint        : 'https://singova.onrender.com/transcribe',
  // Derived automatically — no need to edit manually
  get lyricsCheckEndpoint() {
    return this.apiEndpoint.replace(/\/transcribe$/, '') + '/lyrics-check';
  },
  mockMode    : false,   // set true to use built-in demo data without a server
  mockStepMs  : 800,
  maxHistory  : 50,
};

// ── MOCK DATA ─────────────────────────────────────────────────────────────────
const MOCK_LYRICS = [
  { t: 0, l: '♪ Intro — silence before the storm' },
  { t: 5, l: 'Hello darkness, my old friend' },
  { t: 10, l: "I've come to talk with you again" },
  { t: 16, l: 'Because a vision softly creeping' },
  { t: 22, l: 'Left its seeds while I was sleeping' },
  { t: 28, l: 'And the vision that was planted in my brain' },
  { t: 35, l: 'Still remains — within the sound of silence' },
];

// ── UTILITIES ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const $ = id => document.getElementById(id);

// ── API LAYER ─────────────────────────────────────────────────────────────────
const API = {
  async analyzeTrack(file, onProgress) {
    return CONFIG.mockMode
      ? _mockAnalyze(file, onProgress)
      : _realAnalyze(file, onProgress);
  },
};

async function _realAnalyze(file, onProgress) {
  // ── Phase 1: DB pre-check (cheap GET, no upload needed) ──────────────────
  onProgress(5, '🔍 Checking lyrics database…');
  try {
    const checkUrl = `${CONFIG.lyricsCheckEndpoint}?name=${encodeURIComponent(file.name)}`;
    const checkRes = await fetch(checkUrl, { headers: { 'Accept': 'application/json' } });
    if (checkRes.ok) {
      const checkData = await checkRes.json();
      if (checkData.found && Array.isArray(checkData.lyrics)) {
        onProgress(100, '✓ Found in lyrics database!');
        return { lyrics: checkData.lyrics, detectedLang: checkData.detectedLang || 'xx', source: 'db' };
      }
    }
  } catch (_) {
    // Network error on pre-check — silently fall through to Groq
  }

  // ── Phase 2: Groq Whisper fallback (full audio upload) ─────────────────
  const fd = new FormData();
  fd.append('audio', file, file.name);  // field name matches multer in server.js

  onProgress(10, 'Uploading audio…');
  const timer = _startProgressAnimation(onProgress);

  let data;
  try {
    const res = await fetch(CONFIG.apiEndpoint, {
      method: 'POST',
      headers: { 'Accept': 'application/json' },
      body: fd,
    });
    clearInterval(timer);

    if (!res.ok) {
      let detail;
      try { detail = (await res.json()).error; } catch { detail = res.statusText; }
      throw new Error(detail || `Server error ${res.status}`);
    }
    data = await res.json();
  } catch (err) {
    clearInterval(timer);
    throw err;
  }

  onProgress(100, '✓ Analysis complete');

  // Accept both shapes the server might return
  if (Array.isArray(data.lyrics)) return { lyrics: data.lyrics, detectedLang: data.detectedLang || 'en', source: data.source || 'whisper' };
  if (Array.isArray(data.segments)) return { lyrics: segmentsToLines(data.segments), detectedLang: data.language || 'en', source: 'whisper' };
  throw new Error('Unexpected response from server.');
}

function _startProgressAnimation(onProgress) {
  const steps = [
    [25, '🎙 Sending to Groq Whisper…'],
    [50, '🤖 Transcribing audio…'],
    [75, '⏱ Aligning timestamps…'],
    [90, 'Almost done…'],
  ];
  let i = 0;
  return setInterval(() => {
    if (i < steps.length) onProgress(...steps[i++]);
  }, 2000);
}

// Client-side fallback: Groq verbose_json segments → [{t, l}]
function segmentsToLines(segments) {
  return segments
    .map(s => ({ t: Math.round((s.start ?? 0) * 10) / 10, l: (s.text || '').trim() }))
    .filter(s => s.l.length > 0);
}

async function _mockAnalyze(file, onProgress) {
  const steps = [
    [30, '🎙 Sending to Groq Whisper…'],
    [60, '🤖 Transcribing audio…'],
    [85, '⏱ Aligning timestamps…'],
    [100, '✓ Done'],
  ];
  for (const [pct, msg] of steps) {
    await sleep(CONFIG.mockStepMs);
    onProgress(pct, msg);
  }
  return { lyrics: MOCK_LYRICS, detectedLang: 'en' };
}

// ── PLAYER ────────────────────────────────────────────────────────────────────
const Player = {
  el: null,

  init() {
    this.el = $('player');
    const el = this.el, sb = $('seek-bar');

    el.addEventListener('loadedmetadata', () => {
      $('time-dur').textContent = fmt(el.duration);
      sb.max = Math.floor(el.duration);
    });
    el.addEventListener('timeupdate', () => {
      if (!sb._dragging) {
        sb.value = Math.floor(el.currentTime);
        $('time-cur').textContent = fmt(el.currentTime);
      }
      Lyrics.highlight(el.currentTime);
    });
    el.addEventListener('play',  () => { $('btn-play').textContent = '⏸'; $('waveform').style.display = 'flex';  $('drop-zone').classList.add('dz-hidden'); });
    el.addEventListener('pause', () => { $('btn-play').textContent = '▶'; $('waveform').style.display = 'none'; $('drop-zone').classList.remove('dz-hidden'); });
    el.addEventListener('ended', () => { $('btn-play').textContent = '▶'; $('waveform').style.display = 'none'; $('drop-zone').classList.remove('dz-hidden'); });

    sb.addEventListener('mousedown', () => sb._dragging = true);
    sb.addEventListener('mouseup', () => { el.currentTime = +sb.value; sb._dragging = false; });
    $('btn-play').addEventListener('click', () => el.paused ? el.play() : el.pause());
  },

  load(file) {
    this.el.src = URL.createObjectURL(file);
    this.el.play().catch(() => { });
    $('np-title').textContent = file.name.replace(/\.[^.]+$/, '');
    $('np-sub').textContent = 'Playing';
    $('np-strip').style.display = 'flex';
    $('player-bar').style.display = 'flex';
  },
};

// ── LYRICS ────────────────────────────────────────────────────────────────────
const Lyrics = {
  render(lines) {
    $('lyrics-display').innerHTML = lines.map(l =>
      `<p class="lyric-line text-slate-400 text-sm" data-t="${l.t}">${esc(l.l)}</p>`
    ).join('');
  },

  async stream(lines) {
    $('lyrics-display').innerHTML = '';
    for (const l of lines) {
      await sleep(180);
      const p = document.createElement('p');
      p.className = 'lyric-line text-slate-400 text-sm';
      p.dataset.t = l.t;
      p.textContent = l.l;
      $('lyrics-display').appendChild(p);
    }
  },

  highlight(currentTime) {
    const rows = $('lyrics-display').querySelectorAll('.lyric-line');
    let active = null;
    rows.forEach(p => { if (parseFloat(p.dataset.t) <= currentTime) active = p; });
    rows.forEach(p => {
      if (p === active) { p.classList.add('active'); p.classList.remove('text-slate-400'); }
      else { p.classList.remove('active'); p.classList.add('text-slate-400'); }
    });
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },
};

// ── LIBRARY ───────────────────────────────────────────────────────────────────
const Library = {
  STORE: 'singova_v2',
  load() { return JSON.parse(localStorage.getItem(this.STORE) || '[]'); },
  save(name, lyrics) {
    const lib = this.load().filter(t => t.name !== name);
    lib.unshift({ name, date: new Date().toLocaleDateString(), lyrics: lyrics || null });
    localStorage.setItem(this.STORE, JSON.stringify(lib.slice(0, CONFIG.maxHistory)));
  },

  delete(name) {
    const lib = this.load().filter(t => t.name !== name);
    localStorage.setItem(this.STORE, JSON.stringify(lib));
    this.render();
  },

  render() {
    const lib = this.load(), ul = $('library-list');
    if (!lib.length) { ul.innerHTML = '<li class="text-xs text-slate-600 italic">No tracks yet.</li>'; return; }
    ul.innerHTML = lib.map(t =>
      `<li class="group flex items-center gap-1 py-1.5 px-2 rounded-lg cursor-pointer hover:bg-white/5 transition-colors" data-name="${esc(t.name)}">
         <div class="flex flex-col flex-1 min-w-0">
           <span class="text-xs text-slate-300 truncate group-hover:text-white">♪ ${esc(t.name)}</span>
           <span class="text-xs text-slate-600">${t.date}${t.lyrics ? ' · ✓' : ''}</span>
         </div>
         <button class="btn-delete shrink-0 opacity-0 group-hover:opacity-100 text-slate-600
                        hover:text-red-400 transition-all text-xs px-1 py-0.5 rounded"
                 title="Remove from library" data-name="${esc(t.name)}">✕</button>
       </li>`
    ).join('');

    ul.querySelectorAll('li[data-name]').forEach(li => {
      // Load track on row click
      li.addEventListener('click', () => {
        const entry = this.load().find(t => t.name === li.dataset.name);
        if (entry?.lyrics) {
          Lyrics.render(entry.lyrics);
          $('np-title').textContent = li.dataset.name.replace(/\.[^.]+$/, '');
          $('np-strip').style.display = 'flex';
        }
      });
    });

    // Delete buttons — stop propagation so row-click doesn't fire
    ul.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.delete(btn.dataset.name);
      });
    });
  },
};

// ── ANALYSIS UI ───────────────────────────────────────────────────────────────
function setProgress(pct, msg) {
  $('analysis-step').textContent = msg;
  $('analysis-pct').textContent = pct + '%';
  $('analysis-bar').style.width = pct + '%';
  $('ring-fill').style.strokeDashoffset = 163.4 - (163.4 * pct / 100);
}

// ── TRANSLATION BAR ───────────────────────────────────────────────────────────
function showTranslateBar() {
  const bar = $('translate-bar');
  if (!bar) return;
  bar.classList.add('visible');
  bar.setAttribute('aria-hidden', 'false');
  // Reset dropdown to placeholder each time a new track is loaded
  $('translate-lang').value = '';
}

function hideTranslateBar() {
  const bar = $('translate-bar');
  if (!bar) return;
  bar.classList.remove('visible');
  bar.setAttribute('aria-hidden', 'true');
}

// ── APP ───────────────────────────────────────────────────────────────────────
const App = {
  state: 'idle',

  setState(s) {
    this.state = s;
    $('analysis-panel').style.display = s === 'analyzing' ? 'flex' : 'none';
    $('drop-icon').textContent = { idle: '🎵', analyzing: '⏳', playing: '✓' }[s] || '🎵';
    $('drop-title').textContent = { idle: 'Drop your MP3 here', analyzing: 'Analyzing…', playing: 'Drop another MP3' }[s] || 'Drop your MP3 here';
  },

  async handleFile(file) {
    if (!file || !file.type.includes('audio')) return;

    // Hide translate bar immediately when a new file is dropped
    hideTranslateBar();

    this.setState('analyzing');
    setProgress(0, 'Starting…');
    $('lyrics-display').innerHTML = '<p class="text-slate-600 italic text-sm animate-pulse">Checking lyrics database…</p>';
    Library.save(file.name, null);
    Library.render();

    try {
      const { lyrics, detectedLang } = await API.analyzeTrack(file, setProgress);

      this.setState('playing');
      Player.load(file);
      await Lyrics.stream(lyrics);

      // Reveal translate bar smoothly after lyrics finish streaming
      showTranslateBar();

      Library.save(file.name, lyrics);
      Library.render();
    } catch (err) {
      this.setState('idle');
      $('lyrics-display').innerHTML = `<p class="text-red-400 text-sm">⚠ ${esc(err.message)}</p>`;
    }
  },

  init() {
    Player.init();
    Library.render();

    const dz = $('drop-zone');
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('active'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('active'));
    dz.addEventListener('drop', e => {
      e.preventDefault();
      dz.classList.remove('active');
      this.handleFile(e.dataTransfer.files[0]);
    });
    dz.addEventListener('click', () => {
      const inp = Object.assign(document.createElement('input'), { type: 'file', accept: 'audio/*' });
      inp.onchange = () => this.handleFile(inp.files[0]);
      inp.click();
    });

    // PWA install prompt
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      deferredPrompt = e;
      const btn = $('btn-install');
      btn.style.display = 'block';
      btn.onclick = () => { deferredPrompt.prompt(); deferredPrompt = null; btn.style.display = 'none'; };
    });

    // Translate button
    $('btn-translate').addEventListener('click', () => {
      const lang = $('translate-lang').value;
      if (!lang) return;
      // TODO: call translation API — hooked up in the next step
      console.log('[translate] selected language:', lang);
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch(() => { });
    }
  },
};

App.init();
