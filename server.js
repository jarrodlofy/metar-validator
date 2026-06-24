'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const STATION = process.env.STATION || 'KFMH';
const CHECKWX_KEY = process.env.CHECKWX_KEY || 'bb936d6e4494474f93e71e03000158a2';
const PORT = process.env.PORT || 3000;
const STORE_PATH = process.env.STORE_PATH || path.join(__dirname, 'metar_store.json');
const FETCH_INTERVAL_MS = 60 * 60 * 1000;
const WINDOW_MS = 48 * 60 * 60 * 1000;

let lastFetchTime = null;
let lastFetchSource = null;
let errorCount = 0;

function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
  const opts = { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: headers || {} };
    const req = https.get(opts, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
  });
}

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    }
  } catch (e) {
    log('WARN', `Could not load store: ${e.message}`);
  }
  return [];
}

function saveStore(records) {
  const now = Date.now();
  const pruned = records.filter(r => now - r.fetchedAt < WINDOW_MS);
  const seen = new Set();
  const deduped = pruned.filter(r => {
    if (seen.has(r.raw)) return false;
    seen.add(r.raw);
    return true;
  });
  deduped.sort((a, b) => b.fetchedAt - a.fetchedAt);
  fs.writeFileSync(STORE_PATH, JSON.stringify(deduped, null, 2), 'utf8');
  return deduped;
}

function parseAWCResponse(body) {
  return body.split('\n')
    .map(l => l.trim())
    .filter(l => /^(METAR|SPECI)\s+[A-Z]{4}/.test(l));
}

async function fetchAWC() {
  const url = `https://aviationweather.gov/api/data/metar?ids=${STATION}&hours=2&format=raw`;
  log('INFO', `Fetching from aviationweather.gov: ${url}`);
  const { status, body } = await httpsGet(url);
  if (status !== 200) throw new Error(`AWC returned HTTP ${status}`);
  const lines = parseAWCResponse(body);
  if (lines.length === 0) throw new Error('AWC returned no METAR lines');
  return lines;
}

async function fetchCheckWX() {
  const url = `https://api.checkwx.com/metar/${STATION}`;
  log('INFO', `Fetching from CheckWX: ${url}`);
  const { status, body } = await httpsGet(url, { 'X-API-Key': CHECKWX_KEY });
  if (status !== 200) throw new Error(`CheckWX returned HTTP ${status}`);
  const json = JSON.parse(body);
  if (!json.data || json.data.length === 0) throw new Error('CheckWX returned no data');
  return json.data.map(s => s.trim()).filter(s => /^(METAR|SPECI)\s+[A-Z]{4}/.test(s));
}

async function fetchAndStore() {
  let lines = [];
  let source = null;

  try {
    lines = await fetchAWC();
    source = 'aviationweather.gov';
    log('INFO', `AWC: got ${lines.length} METAR(s)`);
  } catch (awcErr) {
    log('WARN', `AWC failed: ${awcErr.message} — trying CheckWX`);
    errorCount++;
    try {
      lines = await fetchCheckWX();
      source = 'checkwx';
      log('INFO', `CheckWX: got ${lines.length} METAR(s)`);
    } catch (cxErr) {
      log('ERROR', `CheckWX also failed: ${cxErr.message}`);
      errorCount++;
      return;
    }
  }

  const now = Date.now();
  const existing = loadStore();
  const newRecords = lines.map(raw => ({ raw, fetchedAt: now, source }));
  const merged = saveStore([...newRecords, ...existing]);
  lastFetchTime = now;
  lastFetchSource = source;
  log('INFO', `Store now has ${merged.length} record(s)`);
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' });
    res.end();
    return;
  }

  if (url.pathname === '/') {
    return sendJSON(res, 200, {
      endpoints: [
        'GET /api/metars',
        'GET /api/metars?hours=N',
        'GET /api/status',
        'GET /api/fetch'
      ]
    });
  }

  if (url.pathname === '/api/metars') {
    const hours = parseFloat(url.searchParams.get('hours') || '0');
    let records = loadStore();
    if (hours > 0) {
      const cutoff = Date.now() - hours * 60 * 60 * 1000;
      records = records.filter(r => r.fetchedAt >= cutoff);
    }
    return sendJSON(res, 200, records);
  }

  if (url.pathname === '/api/status') {
    return sendJSON(res, 200, {
      station: STATION,
      storedCount: loadStore().length,
      lastFetchTime,
      lastFetchSource,
      errorCount,
      uptime: process.uptime()
    });
  }

  if (url.pathname === '/api/fetch') {
    fetchAndStore().catch(e => log('ERROR', e.message));
    return sendJSON(res, 202, { message: 'Fetch triggered' });
  }

  sendJSON(res, 404, { error: 'Not found' });
});

process.on('SIGINT', () => { log('INFO', 'Shutting down (SIGINT)'); server.close(); process.exit(0); });
process.on('SIGTERM', () => { log('INFO', 'Shutting down (SIGTERM)'); server.close(); process.exit(0); });
process.on('uncaughtException', e => log('ERROR', `Uncaught exception: ${e.message}\n${e.stack}`));
process.on('unhandledRejection', e => log('ERROR', `Unhandled rejection: ${e && e.message || e}`));

server.listen(PORT, () => {
  log('INFO', `Server listening on port ${PORT}`);
  fetchAndStore().catch(e => log('ERROR', `Startup fetch failed: ${e.message}`));
  setInterval(() => fetchAndStore().catch(e => log('ERROR', `Interval fetch failed: ${e.message}`)), FETCH_INTERVAL_MS);
});
