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
  get translateEndpoint() {
    return this.apiEndpoint.replace(/\/transcribe$/, '') + '/translate';
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
  // Upload the audio file — the server handles Genius lookup + Whisper fallback
  const fd = new FormData();
  fd.append('audio', file, file.name);  // field name matches multer in server.js

  onProgress(5, '🔎 Searching Genius database…');
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

  // Report what actually happened
  if (data.source === 'genius') {
    onProgress(100, `✓ Found on Genius!`);
  } else {
    onProgress(100, '✓ Transcription complete');
  }

  // Accept both shapes the server might return
  if (Array.isArray(data.lyrics)) return {
    lyrics      : data.lyrics,
    detectedLang: data.detectedLang || 'en',
    source      : data.source || 'whisper',
    songTitle   : data.songTitle   || null,
    artistName  : data.artistName  || null,
    geniusUrl   : data.geniusUrl   || null,
  };
  if (Array.isArray(data.segments)) return {
    lyrics      : segmentsToLines(data.segments),
    detectedLang: data.language || 'en',
    source      : 'whisper',
    songTitle   : null,
    artistName  : null,
    geniusUrl   : null,
  };
  throw new Error('Unexpected response from server.');
}

function _startProgressAnimation(onProgress) {
  const steps = [
    [20, '🔎 Searching Genius database…'],
    [45, '🎵 Uploading audio to Whisper…'],
    [70, '🤖 Transcribing audio…'],
    [88, '⏱ Aligning timestamps…'],
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

// ── TRANSLATOR ────────────────────────────────────────────────────────────────
/**
 * Translator
 *  - Reads current lyrics from the DOM ({t, l} pairs via data-t attributes)
 *  - Sends them to POST /translate with the chosen language
 *  - Re-renders the lyrics display with translated lines (timestamps intact)
 *  - Keeps a backup of original lines so a new drop resets cleanly
 */
const Translator = {
  _busy        : false,
  _origLines   : null,   // [{t, l}] snapshot before any translation

  /** Call once in App.init() to wire the button. */
  init() {
    $('btn-translate').addEventListener('click', () => this._handleClick());
    // Reset when dropdown changes back to placeholder
    $('translate-lang').addEventListener('change', () => {
      if (!$('translate-lang').value) this._restoreOriginal();
    });
  },

  /** Store a fresh snapshot of the original lyrics (call after every stream). */
  snapshot(lines) {
    this._origLines = lines.map(l => ({ ...l }));
  },

  /** Extract current {t, l} pairs from the live DOM. */
  _linesFromDOM() {
    return Array.from($('lyrics-display').querySelectorAll('.lyric-line'))
      .map(p => ({ t: parseFloat(p.dataset.t) || 0, l: p.textContent }));
  },

  _restoreOriginal() {
    if (this._origLines) Lyrics.render(this._origLines);
  },

  async _handleClick() {
    if (this._busy) return;

    const langSelect = $('translate-lang');
    const targetLang = langSelect.value;
    if (!targetLang) return;

    // Derive a human-readable name from the selected <option>
    const targetLangName = langSelect.options[langSelect.selectedIndex].text
      .replace(/^[^\w]+/, '')  // strip leading flag emoji
      .trim();

    // Grab lines from the DOM (works on both original and already-translated text)
    const lines = this._linesFromDOM();
    if (!lines.length) return;

    // ── UI: loading state ──
    this._busy = true;
    const btn = $('btn-translate');
    const prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Translating…';

    try {
      const res = await fetch(CONFIG.translateEndpoint, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body   : JSON.stringify({ lines, targetLang, targetLangName }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
      if (!Array.isArray(data.translated)) throw new Error('Unexpected response from /translate');

      // Smooth re-render with translated lines (same timestamps → sync still works)
      await Lyrics.stream(data.translated);

      // Update lang badge
      const badge = $('lang-badge');
      if (badge) {
        badge.textContent = targetLangName;
        badge.style.display = 'inline';
      }

      btn.textContent = '✓ Translated';
      setTimeout(() => { btn.textContent = prevLabel; btn.disabled = false; this._busy = false; }, 2500);

    } catch (err) {
      // Show error inline below the translate bar, auto-clear after 5 s
      let errEl = $('translate-error');
      if (!errEl) {
        errEl = Object.assign(document.createElement('p'), {
          id        : 'translate-error',
          className : 'text-red-400 text-xs',
          style     : 'padding:0.25rem 1rem 0.5rem;margin:0;',
        });
        $('translate-bar').insertAdjacentElement('afterend', errEl);
      }
      errEl.textContent = `⚠ ${err.message}`;
      setTimeout(() => errEl.remove(), 5000);

      btn.textContent = prevLabel;
      btn.disabled = false;
      this._busy = false;
    }
  },
};

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
    $('lyrics-display').innerHTML = '<p class="text-slate-600 italic text-sm animate-pulse">Searching Genius…</p>';
    Library.save(file.name, null);
    Library.render();

    try {
      const { lyrics, detectedLang, source, songTitle, artistName } = await API.analyzeTrack(file, setProgress);

      this.setState('playing');
      Player.load(file);

      // Use Genius verified title/artist when available; fall back to filename
      const displayTitle = songTitle || file.name.replace(/\.[^.]+$/, '');
      $('np-title').textContent = displayTitle;
      $('np-sub').textContent   = artistName
        ? `${artistName} • ${source === 'genius' ? 'Genius' : 'Whisper'}`
        : (source === 'genius' ? 'via Genius' : 'Playing');

      await Lyrics.stream(lyrics);

      // Snapshot originals so Translator can restore them if needed
      Translator.snapshot(lyrics);

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
    Translator.init();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch(() => { });
    }
  },
};

App.init();
