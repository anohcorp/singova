'use strict';

const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const dotenv  = require('dotenv');
const os      = require('os');
const fs      = require('fs');
const cheerio = require('cheerio');

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
 * Genius splits lyrics across multiple divs whose class names start with
 * "Lyrics__Container". We select ALL of them with Cheerio's attribute
 * prefix selector [class^="Lyrics__Container"], replace <br> tags with
 * real newlines, and concatenate the full song text.
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
 * Extract lyrics from raw Genius HTML using Cheerio.
 *
 * Strategy:
 *  1. Load HTML into Cheerio.
 *  2. Select every element whose class starts with "Lyrics__Container"
 *     — this catches all div chunks Genius uses to split the song.
 *  3. Inside each container, replace <br> elements with a newline sentinel
 *     so line breaks survive the text extraction step.
 *  4. Grab the combined .text() of all containers.
 *  5. Split on the newline sentinel, trim, and filter empty lines.
 */
function parseLyricsFromHtml(html) {
  const $ = cheerio.load(html);

  // Collect all lyrics container divs (class name starts with "Lyrics__Container")
  // We use the CSS attribute prefix selector. Genius also marks some with
  // data-lyrics-container="true", so we accept either as a fallback.
  const containers = $('[class^="Lyrics__Container"], [data-lyrics-container="true"]');

  if (containers.length === 0) {
    console.warn('[genius] ⚠ No Lyrics__Container divs found — page structure may have changed');
    return null;
  }

  console.log(`[genius] Found ${containers.length} lyrics container(s)`);

  // Replace every <br> inside the containers with a newline sentinel
  // BEFORE extracting text, so we preserve line structure.
  containers.find('br').replaceWith('\n');

  // Build the full lyrics string from all containers
  const fullText = containers
    .map((_i, el) => $(el).text())
    .get()
    .join('\n');

  const lines = fullText
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
// Accepts : multipart/form-data { audio: <File> }
// Returns : { lyrics: [{t, l}], detectedLang, source }
//
// Strict resolution order — guaranteed by structure, not by flags:
//   1. Genius API   → scrape lyrics page → res.json() + RETURN   (Groq never called)
//   2. Groq Whisper → transcribe audio   → res.json() + RETURN   (only if Genius failed)
//   3. Mock data    → dev-only fallback  → res.json() + RETURN   (only if no API key)
//
// Each phase is an isolated async helper with its own try/catch.
// The route handler is a plain if/else — if geniusResult is truthy, we stop.

async function tryGenius(filename) {
  // Returns a response-ready object on success, or null on any failure/miss.
  if (!GENIUS_ACCESS_TOKEN) {
    console.log('[genius] ⚠ GENIUS_ACCESS_TOKEN not set — skipping');
    return null;
  }

  try {
    const parsed = parseFilename(filename);
    const query  = buildSearchQuery(parsed);
    console.log(`[genius] 🔍 Searching: "${query}"`);

    const song = await searchGenius(query);
    if (!song) {
      console.log(`[genius] ✗ No match for "${query}"`);
      return null;   // ← explicit null: caller will use Whisper
    }

    console.log(`[genius] ✓ Match: "${song.full_title}" — ${song.url}`);
    const lines = await scrapeLyricsPage(song.url);

    if (!lines || lines.length === 0) {
      console.log('[genius] ⚠ Page fetched but no lyrics extracted');
      return null;   // ← explicit null: caller will use Whisper
    }

    const lyrics = linesToLyricsFormat(lines);
    console.log(`[genius] ✓ ${lyrics.length} lines — Genius path complete, Groq will NOT be called`);

    // ✅ Genius succeeded — return payload; route handler will send & exit
    return {
      lyrics,
      detectedLang: song.language || 'en',
      source      : 'genius',
      songTitle   : song.full_title,
      artistName  : song.primary_artist?.name || '',
      geniusUrl   : song.url,
    };

  } catch (err) {
    // Any network / parse error is non-fatal — log and signal fallback
    console.warn(`[genius] ⚠ Error: ${err.message} — Groq Whisper will be used instead`);
    return null;
  }
}

async function tryWhisper(file) {
  // Returns a response-ready object on success, throws on unrecoverable error.
  const audioBuffer = await fs.promises.readFile(file.path);
  fs.unlink(file.path, () => {});   // discard temp file immediately after read

  if (!GROQ_API_KEY) {
    console.warn('[whisper] No GROQ_API_KEY — returning mock data');
    return mockResponse();
  }

  const extMime = {
    mp3 : 'audio/mpeg', m4a: 'audio/mp4',  mp4: 'audio/mp4',
    wav : 'audio/wav',  ogg: 'audio/ogg',  flac: 'audio/flac',
    webm: 'audio/webm',
  };
  const ext  = (file.originalname.split('.').pop() || 'mp3').toLowerCase();
  const mime = extMime[ext] || 'audio/mpeg';

  const form = new FormData();
  form.append('file',  new Blob([audioBuffer], { type: mime }), file.originalname);
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'verbose_json');
  // temperature 0.2: disables Whisper's silence-abort heuristic that causes early cutoff
  form.append('temperature', '0.2');
  // Short vocab hint — no prose Whisper can echo as prompt leakage
  form.append('prompt', 'Song lyrics.');

  console.log(`[whisper] → Groq ${WHISPER_MODEL} (ext=${ext})`);

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
  console.log(`[whisper] ✓ ${lyrics.length} lines | lang=${transcription.language}`);

  return {
    lyrics,
    detectedLang: transcription.language || 'en',
    source      : 'whisper',
  };
}

app.post('/transcribe', upload.single('audio'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'No audio file. Send field "audio".' });
  }

  console.log(`\n[transcribe] ▶ ${file.originalname}  (${(file.size / 1024).toFixed(1)} KB)`);

  // ── STEP 1: Genius ────────────────────────────────────────────────────────
  const geniusResult = await tryGenius(file.originalname);

  if (geniusResult) {
    // ✅ Genius succeeded — send response and EXIT immediately.
    //    Groq/Whisper is never called.
    fs.unlink(file.path, () => {});   // audio file is no longer needed
    return res.json(geniusResult);
  }

  // ── STEP 2: Groq Whisper (only reached if Genius returned null) ───────────
  console.log('[transcribe] Genius returned no result — calling Groq Whisper now');
  try {
    const whisperResult = await tryWhisper(file);
    return res.json(whisperResult);
  } catch (err) {
    fs.unlink(file?.path, () => {});
    console.error('[transcribe] ✗', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── HALLUCINATION + LEAKAGE FILTER ───────────────────────────────────────────

/**
 * Exact hallucination phrases Whisper produces on silence / instrumental gaps.
 * Covers thank-you phrases in 15+ languages, subtitle artefacts, applause
 * markers, and common AI filler. Matched case-insensitively, stripped entirely.
 */
const HALLUCINATION_EXACT = new Set([
  // English
  'thank you', 'thank you.', 'thank you!', 'thanks', 'thanks.',
  'thanks for watching', 'thanks for watching!', 'thanks for watching.',
  'thank you for watching', 'thank you for watching.',
  'thank you for listening', 'thank you for listening.',
  'please subscribe', 'subscribe', 'like and subscribe',
  'you', 'you.', '...', '. . .', '….', '…',
  // French
  'merci', 'merci.', 'merci!', 'merci beaucoup', 'merci beaucoup.',
  'sous-titres réalisés para la communauté d\'amara.org',
  'sous-titres réalisés par la communauté d\'amara.org',
  'sous-titres', 'sous-titres.',
  // Spanish
  'gracias', 'gracias.', 'gracias!', 'muchas gracias', 'muchas gracias.',
  // Portuguese
  'obrigado', 'obrigado.', 'obrigada', 'obrigada.',
  // German
  'danke', 'danke.', 'danke schön', 'vielen dank',
  // Italian
  'grazie', 'grazie.', 'grazie mille',
  // Japanese
  'ありがとう', 'ありがとうございます',
  // Korean
  '감사합니다', '감사합니다.',
  // Chinese
  '谢谢', '谢谢.',
  // Arabic
  'شكرا', 'شكراً',
  // Dutch
  'dank je', 'dank u', 'bedankt',
  // Russian
  'спасибо', 'спасибо.',
  // Subtitle / caption artefacts
  '[music]', '[música]', '[musique]', '[applause]', '[applaudissements]',
  '[laughter]', '[silence]', '[inaudible]', '[noise]', '[no audio]',
  '[ music ]', '[ applause ]', '( music )', '(music)', '(applause)',
  '♪', '♫', '♪♪', '♫♫', '♪ ♪', '♫ ♫',
  // Common YouTube-style artefacts
  'subtitles by', 'subtitled by', 'transcribed by',
  'captions by', 'closed captions',
  'amara.org', 'dotsub.com',
]);

/**
 * Regex patterns that match hallucination sentence structures.
 * Used after exact-match removal as a second defence.
 */
const HALLUCINATION_PATTERNS = [
  // Prompt leakage — instruction-style sentences
  /\bTranscri(?:be|ption)\b[^.!?]*[.!?]/gi,
  /\bPreserve\b[^.!?]*[.!?]/gi,
  /\b(?:Return|Output)\s+(?:only|just)\b[^.!?]*[.!?]/gi,
  /\bThe original lyrics\b[^.!?]*[.!?]/gi,
  /[^.!?]*\b(?:accents|special characters)\b[^.!?]*[.!?]/gi,
  // "[Music]" / "[Applause]" / "(Laughter)" bracketed stage directions
  /\[\s*[\w\s]+\s*\]/gi,
  /\(\s*(?:music|applause|laughter|silence|inaudible|noise|clapping)\s*\)/gi,
  // Isolated ellipsis or dots
  /^\.{1,3}$|^…+$/,
  // Standalone music notes
  /^[♪♫\s]+$/,
  // "Thank you" variants not caught by exact list
  /^(?:thank(?:s| you)|gracias|merci|danke|grazie|obrigad[oa]|спасибо|shukran)[.!,]?$/i,
  // "Subtitles/Captions by ..."
  /\b(?:subtitles?|captions?|transcri(?:bed|ption))\s+by\b[^.]*[.]/gi,
];

/**
 * Strip hallucinations and prompt-leakage from a single Whisper segment text.
 * Called per-segment inside segmentsToLines.
 */
function cleanSegmentText(text) {
  // Exact-phrase check first (fast path — covers most cases)
  if (HALLUCINATION_EXACT.has(text.toLowerCase().trim())) return '';

  let s = text;

  // Exact known-leak phrases (prompt echo)
  const KNOWN_LEAKS = [
    'Transcribe the lyrics exactly as sung, in their original language. Preserve punctuation, accents, and special characters accurately.',
    'Transcribe the lyrics exactly as sung, in their original language.',
    'Preserve punctuation, accents, and special characters accurately.',
    'The original lyrics are the same as the original song.',
    'Song lyrics.',
  ];
  for (const phrase of KNOWN_LEAKS) {
    s = s.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  }

  // Pattern-based hallucination sweep
  for (const re of HALLUCINATION_PATTERNS) {
    s = s.replace(re, '');
  }

  // Strip trailing isolated punctuation left after removal (e.g. lone "." or ",")
  s = s.replace(/^[\s.,!?;:…\-]+$/, '');

  // Collapse runs of whitespace and trim
  return s.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Convert Groq verbose_json segments → [{t, l}].
 *
 * Segments with no_speech_prob > NO_SPEECH_THRESHOLD are discarded before
 * any text processing — this removes hallucinations at their root by rejecting
 * output that Whisper itself flagged as likely non-speech (silence/music).
 */
const NO_SPEECH_THRESHOLD = 0.6;  // tune between 0.5–0.8 if needed

function segmentsToLines(segments) {
  return segments
    .filter(s => (s.no_speech_prob ?? 0) <= NO_SPEECH_THRESHOLD)
    .map(s => ({
      t: Math.round((s.start ?? 0) * 10) / 10,
      l: cleanSegmentText((s.text || '').trim()),
    }))
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
