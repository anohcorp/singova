'use strict';

const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const dotenv  = require('dotenv');
const os      = require('os');
const fs      = require('fs');

dotenv.config();

const PORT               = process.env.PORT               || 3000;
const GROQ_API_KEY       = process.env.GROQ_API_KEY       || '';
const WHISPER_MODEL      = process.env.WHISPER_MODEL      || 'whisper-large-v3';
const CHAT_MODEL         = process.env.GROQ_CHAT_MODEL    || 'llama-3.3-70b-versatile';
const GENIUS_ACCESS_TOKEN = process.env.GENIUS_ACCESS_TOKEN || '';

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.static(__dirname));
app.use(express.json({ limit: '1mb' }));   // for /translate JSON body

// ── UPLOAD DIRECTORY ──────────────────────────────────────────────────────────
// Render (and most cloud hosts) provides /tmp as the only writable directory.
// We verify it is writable at startup so failures appear in logs immediately.
const UPLOAD_DIR = os.tmpdir();

(function checkUploadDir() {
  const testFile = `${UPLOAD_DIR}/.singova_write_test`;
  try {
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    console.log(`[startup] ✓ Upload dir writable: ${UPLOAD_DIR}`);
  } catch (e) {
    console.error(`[startup] ✗ Upload dir NOT writable (${UPLOAD_DIR}): ${e.message}`);
  }
})();

const upload = multer({
  dest  : UPLOAD_DIR,
  limits: { fileSize: 100 * 1024 * 1024 },
});

// ── GENIUS HELPERS ────────────────────────────────────────────────────────────

/**
 * Parse a filename into { artist, title } candidates for Genius search.
 * Handles common naming patterns:
 *   "Artist - Title.mp3"          → { artist: "Artist", title: "Title" }
 *   "01 - Artist - Title.mp3"     → { artist: "Artist", title: "Title" }
 *   "01. Title.mp3"               → { artist: "",        title: "Title" }
 *   "Title.mp3"                   → { artist: "",        title: "Title" }
 */
function parseFilename(filename) {
  // Strip extension
  const base = (filename || '').replace(/\.[^.]+$/, '').trim();

  // Remove leading track numbers like "01 -", "1.", "01. "
  const noNum = base.replace(/^\d+[.\s-]+/, '').trim();

  // Try "Artist - Title" or "Artist – Title" (en-dash)
  const sepMatch = noNum.match(/^(.+?)\s*[-–]\s*(.+)$/);
  if (sepMatch) {
    return { artist: sepMatch[1].trim(), title: sepMatch[2].trim() };
  }

  // Only a title (no separator found)
  return { artist: '', title: noNum };
}

/**
 * Build the best search query string for Genius.
 * If both artist and title are present, use "Artist Title" for better recall.
 */
function buildSearchQuery({ artist, title }) {
  return artist ? `${artist} ${title}` : title;
}

/**
 * Search the Genius API and return the best matching song object, or null.
 * Uses Bearer token from GENIUS_ACCESS_TOKEN env var.
 */
async function searchGenius(query) {
  const url = `https://api.genius.com/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${GENIUS_ACCESS_TOKEN}`,
      'User-Agent'   : 'Singova/1.0 (https://singova.onrender.com)',
    },
  });

  if (!res.ok) {
    throw new Error(`Genius search API returned ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();
  const hits = data?.response?.hits ?? [];

  // Return the first song-type hit
  const songHit = hits.find(h => h.type === 'song');
  return songHit?.result ?? null;
}

/**
 * Fetch a Genius song page and scrape its lyrics.
 *
 * Genius lyrics live in one or more:
 *   <div data-lyrics-container="true" ...> … </div>
 *
 * We use a depth-tracking walker (no external HTML parser) so nested
 * elements inside the container are handled correctly.
 *
 * Returns an array of lyric lines (strings), or null if none found.
 */
async function scrapeLyricsPage(pageUrl) {
  const res = await fetch(pageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                    'Chrome/124.0 Safari/537.36',
      'Accept'    : 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!res.ok) {
    throw new Error(`Genius page fetch returned ${res.status} for ${pageUrl}`);
  }

  const html = await res.text();
  return parseLyricsFromHtml(html);
}

/**
 * Extract lyrics from raw Genius HTML.
 *
 * Strategy:
 *  1. Locate each `data-lyrics-container="true"` div.
 *  2. Walk character-by-character tracking <div> nesting depth to find its
 *     matching closing </div> — avoids regex edge-cases with nested elements.
 *  3. Convert <br> → newline, strip all remaining HTML tags.
 *  4. Decode common HTML entities.
 *  5. Split into non-empty lines.
 */
function parseLyricsFromHtml(html) {
  const MARKER = 'data-lyrics-container="true"';
  const sections = [];

  let searchFrom = 0;
  while (true) {
    const markerPos = html.indexOf(MARKER, searchFrom);
    if (markerPos === -1) break;

    // Advance past the opening tag's closing ">"
    const openTagEnd = html.indexOf('>', markerPos);
    if (openTagEnd === -1) break;
    const contentStart = openTagEnd + 1;

    // Depth-track to find the matching </div>
    let depth = 1;
    let pos   = contentStart;

    while (depth > 0 && pos < html.length) {
      const nextOpen  = html.indexOf('<div',  pos);
      const nextClose = html.indexOf('</div', pos);

      if (nextClose === -1) { pos = html.length; break; }

      if (nextOpen !== -1 && nextOpen < nextClose) {
        // Found a nested <div> before the next </div>
        depth++;
        pos = nextOpen + 4;
      } else {
        // Found a </div>
        depth--;
        if (depth === 0) {
          // This is the matching close of our lyrics container
          sections.push(html.slice(contentStart, nextClose));
        } else {
          pos = nextClose + 5;
        }
      }
    }

    searchFrom = markerPos + MARKER.length;
  }

  if (sections.length === 0) return null;

  const rawText = sections
    .join('\n')
    // Line breaks
    .replace(/<br\s*\/?>/gi, '\n')
    // Strip all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/&#x27;/g,  "'")
    .replace(/&#39;/g,   "'")
    .replace(/&nbsp;/g,  ' ')
    .replace(/\u2019/g,  '\u2019')  // right single quotation mark — keep as-is
    .replace(/\u2018/g,  '\u2018'); // left single quotation mark  — keep as-is

  const lines = rawText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  return lines.length > 0 ? lines : null;
}

/**
 * Convert a plain array of lyric strings (from Genius, no timestamps) into the
 * [{t, l}] shape the frontend expects.
 *
 * Since Genius does not provide per-line timestamps, we set t:0 for all lines
 * and include source:'genius' so the frontend can treat them as static lyrics.
 * The karaoke highlight will remain on the last line during playback — a known
 * limitation when timestamps are unavailable.
 */
function linesToLyricsFormat(lines) {
  return lines.map(l => ({ t: 0, l }));
}

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status : 'ok',
    groq   : !!GROQ_API_KEY,
    genius : !!GENIUS_ACCESS_TOKEN,
    whisper: WHISPER_MODEL,
    chat   : CHAT_MODEL,
  });
});

// ── POST /translate ───────────────────────────────────────────────────────────
// Accepts: { lines: [{t, l}], targetLang: 'fr', targetLangName: 'French' }
// Returns: { translated: [{t, l}] }  — same shape, timestamps preserved
app.post('/translate', async (req, res) => {
  const { lines, targetLang, targetLangName } = req.body || {};

  if (!Array.isArray(lines) || lines.length === 0)
    return res.status(400).json({ error: 'Body must contain a non-empty "lines" array.' });
  if (!targetLang || !targetLangName)
    return res.status(400).json({ error: '"targetLang" and "targetLangName" are required.' });
  if (!GROQ_API_KEY)
    return res.status(503).json({ error: 'Translation unavailable — GROQ_API_KEY not set on server.' });

  const inputBlock = lines.map((l, i) => `${i}\t${l.t}\t${l.l}`).join('\n');

  const systemPrompt =
    `You are a professional lyrics translator. ` +
    `Translate song lyrics into ${targetLangName} (language code: ${targetLang}). ` +
    `Rules: ` +
    `1. Preserve the poetic feel and natural rhythm. ` +
    `2. Keep exactly the same number of lines as the input. ` +
    `3. Return ONLY a valid JSON array — no markdown, no extra text. ` +
    `4. Each element: {"i": <index>, "t": <original_timestamp_number>, "l": "<translated line>"}. ` +
    `5. Never omit lines or alter timestamps.`;

  const userPrompt =
    `Translate the following lyrics into ${targetLangName}.\n` +
    `Input format per line: index TAB timestamp TAB lyric\n\n` +
    inputBlock;

  console.log(`[translate] → ${targetLangName} (${targetLang}) | ${lines.length} lines | model=${CHAT_MODEL}`);

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method : 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type' : 'application/json',
      },
      body: JSON.stringify({
        model      : CHAT_MODEL,
        temperature: 0.3,
        messages   : [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      }),
    });

    if (!groqRes.ok) {
      const detail = await groqRes.text().catch(() => groqRes.statusText);
      throw new Error(`Groq ${groqRes.status}: ${detail}`);
    }

    const completion = await groqRes.json();
    const raw = completion.choices?.[0]?.message?.content || '';

    const jsonStr = raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    let parsed;
    try   { parsed = JSON.parse(jsonStr); }
    catch { throw new Error('Model returned non-JSON. Raw: ' + raw.slice(0, 160)); }

    const translated = parsed.map(item => ({
      t: lines[item.i]?.t ?? item.t,
      l: String(item.l),
    }));

    console.log(`[translate] ✓ ${translated.length} lines → ${targetLangName}`);
    return res.json({ translated, targetLang, targetLangName });

  } catch (err) {
    console.error('[translate] ✗', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /transcribe ──────────────────────────────────────────────────────────
// Accepts: multipart/form-data { audio: <File> }
// Returns: { lyrics: [{t, l}], detectedLang, source }
//
// Resolution order:
//   1. Genius API  →  scrape lyrics page  →  return (no timestamps)
//   2. Groq Whisper                        →  return (with timestamps)
//   3. Mock data   (when GROQ_API_KEY missing, dev-only)
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'No audio file. Send field "audio".' });
  }

  console.log(`\n[transcribe] ▶ ${file.originalname}  (${(file.size / 1024).toFixed(1)} KB)`);

  // ── Step 1: Genius lookup ──────────────────────────────────────────────────
  if (GENIUS_ACCESS_TOKEN) {
    try {
      const parsed = parseFilename(file.originalname);
      const query  = buildSearchQuery(parsed);
      console.log(`[genius] 🔍 Searching: "${query}"`);

      const song = await searchGenius(query);

      if (song) {
        console.log(`[genius] ✓ Match: "${song.full_title}" — ${song.url}`);
        const lines = await scrapeLyricsPage(song.url);

        if (lines && lines.length > 0) {
          fs.unlink(file.path, () => {});   // audio not needed — discard immediately
          const lyrics = linesToLyricsFormat(lines);
          console.log(`[genius] ✓ ${lyrics.length} lines scraped — returning lyrics`);
          return res.json({
            lyrics,
            detectedLang: song.language || 'en',
            source      : 'genius',
            songTitle   : song.full_title,
            artistName  : song.primary_artist?.name || '',
            geniusUrl   : song.url,
          });
        }
        console.log('[genius] ⚠ Page scraped but no lyrics found — falling back to Whisper');
      } else {
        console.log(`[genius] ✗ No match for "${query}" — falling back to Whisper`);
      }
    } catch (geniusErr) {
      // Genius is optional — log and continue to Whisper
      console.warn(`[genius] ⚠ Error (${geniusErr.message}) — falling back to Whisper`);
    }
  } else {
    console.log('[genius] ⚠ GENIUS_ACCESS_TOKEN not set — skipping Genius lookup');
  }

  // ── Step 2: Groq Whisper fallback ─────────────────────────────────────────
  try {
    const audioBuffer = await fs.promises.readFile(file.path);
    fs.unlink(file.path, () => {});   // clean up temp file

    if (!GROQ_API_KEY) {
      console.warn('[transcribe] No GROQ_API_KEY — returning mock data');
      return res.json(mockResponse());
    }

    const form = new FormData();
    form.append('file',            new Blob([audioBuffer], { type: 'audio/mpeg' }), file.originalname);
    form.append('model',           WHISPER_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('prompt',          'Transcribe the lyrics exactly as sung, in their original language. Preserve punctuation, accents, and special characters accurately.');
    form.append('temperature',     '0');

    console.log(`[transcribe] → Groq ${WHISPER_MODEL}`);

    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method : 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body   : form,
    });

    if (!groqRes.ok) {
      const detail = await groqRes.text().catch(() => groqRes.statusText);
      throw new Error(`Groq ${groqRes.status}: ${detail}`);
    }

    const transcription = await groqRes.json();
    const lyrics = segmentsToLines(transcription.segments || []);
    console.log(`[transcribe] ✓ ${lyrics.length} lines | lang=${transcription.language}`);

    return res.json({
      lyrics,
      detectedLang: transcription.language || 'en',
      source      : 'whisper',
    });

  } catch (err) {
    fs.unlink(file?.path, () => {});
    console.error('[transcribe] ✗', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── HELPERS ───────────────────────────────────────────────────────────────────

// Groq verbose_json segments → [{t, l}]
function segmentsToLines(segments) {
  return segments
    .map(s => ({ t: Math.round((s.start ?? 0) * 10) / 10, l: (s.text || '').trim() }))
    .filter(s => s.l.length > 0);
}

function mockResponse() {
  return {
    detectedLang: 'en',
    source      : 'mock',
    lyrics: [
      { t: 0.0,  l: 'Hello darkness, my old friend,' },
      { t: 5.0,  l: "I've come to talk with you again," },
      { t: 10.0, l: 'Because a vision softly creeping,' },
      { t: 16.0, l: 'Left its seeds while I was sleeping,' },
      { t: 22.0, l: 'And the vision that was planted in my brain' },
      { t: 29.0, l: 'Still remains within the sound of silence.' },
    ],
  };
}

// ── ERROR HANDLER ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎤  Singova  →  http://localhost:${PORT}`);
  console.log(`    POST /transcribe   POST /translate   GET /health`);
  console.log(`    Upload dir  : ${UPLOAD_DIR}`);
  console.log(`    Groq key    : ${GROQ_API_KEY    ? `✓ set (${GROQ_API_KEY.slice(0, 8)}…)`    : '✗ MISSING'}`);
  console.log(`    Genius key  : ${GENIUS_ACCESS_TOKEN ? `✓ set (${GENIUS_ACCESS_TOKEN.slice(0, 8)}…)` : '✗ not set — Genius lookup disabled'}`);
  console.log(`    Whisper     : ${WHISPER_MODEL}`);
  console.log(`    Chat model  : ${CHAT_MODEL}\n`);
});
