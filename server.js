const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   In-memory store for short links.
   WARNING: On Render's free plan, the service restarts on
   inactivity and this data is lost. For production, replace
   with a database (Render PostgreSQL / Redis / Cloudflare D1).
============================================================ */
const linkStore = new Map();

// Auto-cleanup: remove links older than 7 days
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of linkStore.entries()) {
    if (entry.exp && now > entry.exp) linkStore.delete(code);
    else if (now - entry.createdAt > 7 * 24 * 3600 * 1000) linkStore.delete(code);
  }
}, 60 * 60 * 1000);

/* ============================================================
   Create short link
   POST /api/links
   Body: { c, mk, pm, sn, rn, tn, tx, an, am, cur, nt, exp? }
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
    return res.status(410).json({ error: 'Link expired' });
  }

  res.json(entry.payload);
});

/* ============================================================
   Accept payment
   POST /api/accept
   Body: { transactionId }
   ------------------------------------------------------------
   THIS IS A PLACEHOLDER.
   Replace the demo block with your real EcoCash API call.
   Never return "success" until the provider confirms.
============================================================ */
app.post('/api/accept', async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) {
    return res.status(400).json({ error: 'Missing transactionId' });
  }

  try {
    // ==========================================================
    // REPLACE THIS BLOCK WITH YOUR REAL ECOCASH API CALL:
    //
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
    // ==========================================================

    // DEMO response — do NOT claim success
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

/* Fallback for any unknown route */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('EcoPay running on port ' + PORT);
});
