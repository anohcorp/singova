'use strict';

const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const dotenv  = require('dotenv');
const os      = require('os');
const fs      = require('fs');
const path    = require('path');

dotenv.config();

// ── LYRICS DATABASE ───────────────────────────────────────────────────────────
// Loaded once at startup. Keys are lowercase filenames without extension.
let LYRICS_DB = {};
(function loadLyricsDB() {
  const dbPath = path.join(__dirname, 'lyrics.json');
  try {
    const raw = fs.readFileSync(dbPath, 'utf8');
    LYRICS_DB = JSON.parse(raw);
    // Remove the readme key so it never pollutes lookups
    delete LYRICS_DB['_readme'];
    console.log(`[startup] ✓ lyrics.json loaded — ${Object.keys(LYRICS_DB).length} song(s) in DB`);
  } catch (e) {
    console.warn(`[startup] ⚠ lyrics.json not found or invalid — DB lookups disabled (${e.message})`);
  }
})()

/**
 * Normalise a filename for DB lookup:
 *   - strip extension
 *   - trim and lowercase
 *   - collapse runs of whitespace / dashes / underscores to single space
 */
function normaliseKey(filename) {
  return (filename || '')
    .replace(/\.[^.]+$/, '')   // remove extension
    .toLowerCase()
    .replace(/[-_]+/g, ' ')   // dashes/underscores → space
    .replace(/\s+/g, ' ')     // collapse whitespace
    .trim();
}

/** Returns the lyrics array if found in the DB, otherwise null. */
function lookupLyrics(filename) {
  const key = normaliseKey(filename);
  return LYRICS_DB[key] ?? null;
}

const PORT         = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-large-v3';

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.static(__dirname));
app.use(express.json({ limit: '1mb' }));  // needed for /translate JSON body

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
    // Don't exit — let the first real upload surface the error with context.
  }
})();

const upload = multer({
  dest  : UPLOAD_DIR,
  limits: { fileSize: 100 * 1024 * 1024 },
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status   : 'ok',
    live     : !!GROQ_API_KEY,
    whisper  : WHISPER_MODEL,
    lyricsDB : Object.keys(LYRICS_DB).length,
  });
});

// ── GET /lyrics-check ─────────────────────────────────────────────────────────
// Query: ?name=<filename>   (e.g. ?name=The+Sound+of+Silence.mp3)
// Returns: { found: true, lyrics: [...], source: 'db' }
//       or: { found: false }
// This lets the client do a cheap GET before committing to a full audio upload.
app.get('/lyrics-check', (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Missing ?name= query parameter' });

  const lyrics = lookupLyrics(name);
  if (lyrics) {
    console.log(`[lyrics-check] ✓ DB hit — "${normaliseKey(name)}"`);
    return res.json({ found: true, lyrics, source: 'db', detectedLang: 'xx' });
  }

  console.log(`[lyrics-check] ✗ DB miss — "${normaliseKey(name)}"`);
  return res.json({ found: false });
});

// ── POST /translate ───────────────────────────────────────────────────────────
// Accepts: { lines: [{t, l}], targetLang: 'fr', targetLangName: 'French' }
// Returns: { translated: [{t, l}] }  — same shape, timestamps preserved
const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile';

app.post('/translate', async (req, res) => {
  const { lines, targetLang, targetLangName } = req.body || {};

  if (!Array.isArray(lines) || lines.length === 0)
    return res.status(400).json({ error: 'Body must contain a non-empty "lines" array.' });
  if (!targetLang || !targetLangName)
    return res.status(400).json({ error: '"targetLang" and "targetLangName" are required.' });
  if (!GROQ_API_KEY)
    return res.status(503).json({ error: 'Translation unavailable — GROQ_API_KEY not set on server.' });

  // Compact text block: one line per lyric, tab-separated index + timestamp
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

    // Strip optional markdown fences the model might still add
    const jsonStr = raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    let parsed;
    try   { parsed = JSON.parse(jsonStr); }
    catch { throw new Error('Model returned non-JSON. Raw: ' + raw.slice(0, 160)); }

    // Rebuild [{t, l}] in original order, using original timestamps for safety
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
// Returns: { lyrics: [{t, l}], detectedLang }
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'No audio file. Send field "audio".' });
  }

  console.log(`\n[transcribe] ▶ ${file.originalname}  (${(file.size / 1024).toFixed(1)} KB)`);

  // ── Step 1: check lyrics DB before touching Groq ──────────────────────────
  const dbLyrics = lookupLyrics(file.originalname);
  if (dbLyrics) {
    fs.unlink(file.path, () => {}); // no need to keep the upload
    console.log(`[transcribe] ✓ DB hit — returning cached lyrics for "${normaliseKey(file.originalname)}"`);
    return res.json({ lyrics: dbLyrics, detectedLang: 'xx', source: 'db' });
  }
  console.log(`[transcribe] ✗ DB miss — falling back to Groq Whisper`);

  try {
    // Read the uploaded bytes
    const audioBuffer = await fs.promises.readFile(file.path);
    fs.unlink(file.path, () => {}); // clean up temp file immediately

    // If no API key, return mock data so the frontend still works
    if (!GROQ_API_KEY) {
      console.warn('[transcribe] No GROQ_API_KEY — returning mock data');
      return res.json(mockResponse());
    }

    // Send raw audio directly to Groq Whisper
    const form = new FormData();
    form.append('file',            new Blob([audioBuffer], { type: 'audio/mpeg' }), file.originalname);
    form.append('model',           WHISPER_MODEL);
    form.append('response_format', 'verbose_json');
    // Do NOT append 'language' — omitting it tells Whisper to auto-detect.
    // The prompt steers output toward the original language with proper punctuation.
    form.append('prompt',          'Transcribe the lyrics exactly as sung, in their original language. Preserve punctuation, accents, and special characters accurately.');
    form.append('temperature',     '0');   // most deterministic output

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

    return res.json({ lyrics, detectedLang: transcription.language || 'en' });

  } catch (err) {
    fs.unlink(file?.path, () => {});
    console.error('[transcribe] ✗', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Groq verbose_json segments → [{t, l}]
function segmentsToLines(segments) {
  return segments
    .map(s => ({ t: Math.round((s.start ?? 0) * 10) / 10, l: (s.text || '').trim() }))
    .filter(s => s.l.length > 0);
}

function mockResponse() {
  return {
    detectedLang: 'en',
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

app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n🎤  Singova  →  http://localhost:${PORT}`);
  console.log(`    POST /transcribe   POST /translate   GET /health`);
  console.log(`    Upload dir : ${UPLOAD_DIR}`);
  console.log(`    Groq key   : ${GROQ_API_KEY ? `✓ set (${GROQ_API_KEY.slice(0, 8)}…)` : '✗ MISSING — set GROQ_API_KEY in Render environment'}`);
  console.log(`    Whisper    : ${WHISPER_MODEL}`);
  console.log(`    Chat model : ${CHAT_MODEL}\n`);
});
