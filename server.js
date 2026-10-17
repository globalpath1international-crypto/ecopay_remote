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
   Uses a JSON file on disk so links survive Render restarts
   and idle spin-downs (within the container's lifetime).

   For truly durable storage across full redeploys, replace
   this with Render PostgreSQL, Redis, or Cloudflare D1.
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
    const obj = JSON.parse(raw);
    // Convert plain object back to Map
    return new Map(Object.entries(obj));
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

// Auto-cleanup: remove expired or old links, then persist
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
   Create short link
   POST /api/links
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
   Resolve short link
   GET /api/links/:code
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
   Accept payment — placeholder, replace with real EcoCash API
============================================================ */
app.post('/api/accept', async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) {
    return res.status(400).json({ error: 'Missing transactionId' });
  }

  try {
    // Replace this block with your real EcoCash API call:
    // const ecoRes = await fetch('https://api.ecocash.co.zw/...', {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': 'Bearer ' + process.env.ECOCASH_API_KEY,
    //     'Content-Type': 'application/json'
    //   },
    //   body: JSON.stringify({ sourceReference: transactionId })
    // });
    // const result = await ecoRes.json();
    // return res.json(result);

    return res.json({
      status: 'pending',
      message: 'Acceptance recorded. Awaiting provider confirmation.',
      transactionId
    });
  } catch (err) {
    console.error('accept error:', err);
    res.status(500).json({ error: 'Payment acceptance failed' });
  }
});

/* Health check */
app.get('/health', (req, res) => res.json({ ok: true }));

/* Explicitly serve admin and client pages by name
   (avoids the catch-all hiding missing files) */
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/client.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

/* Root redirects to admin */
app.get('/', (req, res) => {
  res.redirect('/admin.html');
});

/* Fallback — only for non-API routes */
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).send('Page not found');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('EcoPay running on port ' + PORT);
  console.log('Data file:', DATA_FILE);
  console.log('Loaded links:', linkStore.size);
});
