'use strict';

const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const dotenv  = require('dotenv');
const os      = require('os');
const fs      = require('fs');
const cheerio = require('cheerio');

dotenv.config();

const PORT                = process.env.PORT                || 3000;
const GROQ_API_KEY        = process.env.GROQ_API_KEY        || '';
const CHAT_MODEL          = process.env.GROQ_CHAT_MODEL     || 'llama-3.3-70b-versatile';
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
  const noNum = base.replace(/^\d+[\.\s-]+/, '').trim();

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
 * Sanitize a raw search query before sending it to Genius.
 *
 * Removes YouTube/file-name clutter so messy filenames like
 *   "Adele - Hello (Official Music Video) [HD Lyrics] ft. Someone"
 * are reduced to a clean "Adele Hello" that Genius can reliably match.
 *
 * Steps (applied in order):
 *  1. Strip everything inside parentheses () or brackets [] — catches
 *     "(Official Music Video)", "[Lyrics]", "(Audio)", "[HD]", etc.
 *  2. Remove common clutter keywords (case-insensitive, whole-word where
 *     sensible): Official, Music Video, HQ, HD, Audio, Lyrics, Lyric Video,
 *     feat., ft., prod., with., x (as a featured-artist separator).
 *  3. Replace underscores with spaces (common in downloaded filenames).
 *  4. Collapse runs of whitespace and trim.
 *  5. Strip any trailing/leading hyphens or dashes left after removal.
 */
function sanitizeQuery(query) {
  return query
    // Step 1: remove anything inside () or []
    .replace(/\(([^)]*)\)/g, '')
    .replace(/\[([^\]]*)\]/g, '')
    // Step 2: remove clutter keywords
    .replace(/\b(lyric\s*video|music\s*video|official\s*video|official\s*audio|official|lyrics?|audio|hq|hd|feat\.?|ft\.?|prod\.?|with\.?)\b/gi, '')
    // Step 3: underscores → spaces
    .replace(/_/g, ' ')
    // Step 4: collapse whitespace
    .replace(/\s{2,}/g, ' ')
    // Step 5: strip stray leading/trailing hyphens and dashes
    .replace(/^\s*[-–—]+\s*|\s*[-–—]+\s*$/g, '')
    .trim();
}

/**
 * Search the Genius API and return the best matching song object, or null.
 * Uses Bearer token from GENIUS_ACCESS_TOKEN env var.
 */
async function searchGenius(rawQuery) {
  const query = sanitizeQuery(rawQuery);
  if (query !== rawQuery) {
    console.log(`[genius] 🧹 Sanitized query: "${rawQuery}" → "${query}"`);
  }
  const url = `https://api.genius.com/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'Authorization'  : `Bearer ${GENIUS_ACCESS_TOKEN}`,
      'User-Agent'     : 'Singova/1.0 (https://singova.onrender.com)',
      'Accept-Encoding': 'identity',   // prevent gzip — Node fetch doesn't auto-decompress
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
      // Full Chrome 124 UA — Cloudflare validates the complete version string
      'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',        // prevent gzip — Node fetch doesn't auto-decompress
      'Cache-Control'  : 'no-cache',
      'Pragma'         : 'no-cache',
      'Sec-Fetch-Dest' : 'document',
      'Sec-Fetch-Mode' : 'navigate',
      'Sec-Fetch-Site' : 'none',
      'Sec-Fetch-User' : '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  if (!res.ok) {
    throw new Error(`Genius page fetch returned ${res.status} for ${pageUrl}`);
  }

  const html = await res.text();
  return parseLyricsFromHtml(html);
}

/**
 * Extract lyrics from raw Genius HTML using the "bulldozer" method.
 *
 * Strategy:
 *  1. Load HTML into Cheerio.
 *  2. Select EVERY div whose class starts with "Lyrics__Container"
 *     (CSS attribute prefix selector — catches all chunks Genius uses).
 *  3. For each container, grab the raw inner HTML.
 *  4. Replace all <br> / <br/> / <br /> variants with real newlines.
 *  5. Strip every remaining HTML tag completely (/<[^>]*>?/gm).
 *  6. Decode common HTML entities so characters like & ' " are correct.
 *  7. Trim and append to fullLyrics with newline separation.
 *  8. Split into non-empty lines and return.
 */
function parseLyricsFromHtml(html) {
  const $ = cheerio.load(html);

  const containers = $('div[class^="Lyrics__Container"]');

  if (containers.length === 0) {
    console.warn('[genius] ⚠ No Lyrics__Container divs found — page structure may have changed');
    return null;
  }

  console.log(`[genius] Found ${containers.length} lyrics container(s)`);

  let fullLyrics = '';

  containers.each((_i, el) => {
    let chunk = $(el).html();
    if (chunk === null) return;

    // Step 1: <br> variants → real newline
    chunk = chunk.replace(/<br\s*\/?>/gi, '\n');

    // Step 2: strip ALL remaining HTML tags
    chunk = chunk.replace(/<[^>]*>?/gm, '');

    // Step 3: decode common HTML entities
    chunk = chunk
      .replace(/&amp;/g,  '&')
      .replace(/&lt;/g,   '<')
      .replace(/&gt;/g,   '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g,  "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ');

    // Step 4: trim and append (containers separated by a newline)
    fullLyrics += chunk.trim() + '\n';
  });

  const lines = fullLyrics
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
    genius : !!GENIUS_ACCESS_TOKEN,
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
// Sole resolution path: Genius API only.
// If the filename cannot be matched on Genius, a 404 is returned.
// There is no AI audio transcription fallback.
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'No audio file. Send field "audio".' });
  }

  console.log(`\n[transcribe] ▶ ${file.originalname}  (${(file.size / 1024).toFixed(1)} KB)`);

  // Audio file is not needed for Genius lookup — delete it immediately.
  fs.unlink(file.path, () => {});

  if (!GENIUS_ACCESS_TOKEN) {
    return res.status(503).json({ error: 'Lyrics unavailable — GENIUS_ACCESS_TOKEN not set on server.' });
  }

  try {
    const parsed = parseFilename(file.originalname);
    const query  = buildSearchQuery(parsed);
    console.log(`[genius] 🔍 Searching: "${query}"`);

    const song = await searchGenius(query);
    if (!song) {
      console.log(`[genius] ✗ No match for "${query}"`);
      return res.status(404).json({ error: `No lyrics found for "${query}". Try renaming the file to "Artist - Title.mp3".` });
    }

    console.log(`[genius] ✓ Match: "${song.full_title}" — ${song.url}`);
    const lines = await scrapeLyricsPage(song.url);

    if (!lines || lines.length === 0) {
      console.log('[genius] ⚠ Page fetched but no lyrics extracted');
      return res.status(404).json({ error: `Song found on Genius but lyrics could not be extracted. Try again later.` });
    }

    const lyrics = linesToLyricsFormat(lines);
    console.log(`[genius] ✓ ${lyrics.length} lines returned`);

    return res.json({
      lyrics,
      detectedLang: song.language || 'en',
      source      : 'genius',
      songTitle   : song.full_title,
      artistName  : song.primary_artist?.name || '',
      geniusUrl   : song.url,
    });

  } catch (err) {
    console.error('[transcribe] ✗', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── ERROR HANDLER ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎤  Singova  →  http://localhost:${PORT}`);
  console.log(`    POST /transcribe   POST /translate   GET /health`);
  console.log(`    Genius key  : ${GENIUS_ACCESS_TOKEN ? `✓ set (${GENIUS_ACCESS_TOKEN.slice(0, 8)}…)` : '✗ MISSING — lyrics lookup disabled'}`);
  console.log(`    Chat model  : ${CHAT_MODEL}\n`);
});
