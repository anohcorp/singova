'use strict';

const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const dotenv  = require('dotenv');
const os      = require('os');
const fs      = require('fs');

dotenv.config();

const PORT         = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-large-v3';

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.static(__dirname));

// Store upload in /tmp — only needed long enough to read and forward to Groq
const upload = multer({
  dest  : os.tmpdir(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status   : 'ok',
    live     : !!GROQ_API_KEY,
    whisper  : WHISPER_MODEL,
  });
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
  console.log(`    POST /transcribe   GET /health`);
  console.log(`    Whisper: ${GROQ_API_KEY ? `✓ LIVE (${WHISPER_MODEL})` : '⚠ MOCK (add GROQ_API_KEY to .env)'}\n`);
});
