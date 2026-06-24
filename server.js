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

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';
const TWILIO_SID = process.env.TWILIO_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || '';
const TWILIO_FROM = process.env.TWILIO_FROM || '';
const NOTIFY_TO = process.env.NOTIFY_TO || '';

let lastFetchTime = null;
let lastFetchSource = null;
let errorCount = 0;

// Track sent notifications to avoid duplicates within the same run
const notifiedKeys = new Set();
let lastWeeklySummaryDate = null;

function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
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

async function sendDiscord(message) {
  if (!DISCORD_WEBHOOK) return;
  try {
    const body = JSON.stringify({ content: message });
    const { status } = await httpsPost(DISCORD_WEBHOOK, { 'Content-Type': 'application/json' }, body);
    if (status < 200 || status >= 300) log('WARN', `Discord notification returned HTTP ${status}`);
    else log('INFO', 'Discord notification sent');
  } catch (e) {
    log('WARN', `Discord notification failed: ${e.message}`);
  }
}

async function sendSMS(message) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !NOTIFY_TO) return;
  try {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const body = new URLSearchParams({ From: TWILIO_FROM, To: NOTIFY_TO, Body: message }).toString();
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
    const { status } = await httpsPost(url, {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`
    }, body);
    if (status < 200 || status >= 300) log('WARN', `SMS notification returned HTTP ${status}`);
    else log('INFO', 'SMS notification sent');
  } catch (e) {
    log('WARN', `SMS notification failed: ${e.message}`);
  }
}

async function notify(key, smsMsg, discordMsg) {
  if (notifiedKeys.has(key)) return;
  notifiedKeys.add(key);
  await Promise.all([sendSMS(smsMsg), sendDiscord(discordMsg)]);
}

// Basic server-side METAR validation — catches obvious field-level errors
function basicValidate(raw) {
  const errors = [];
  const tokens = raw.trim().split(/\s+/);
  let i = 0;

  if (!/^(METAR|SPECI)$/.test(tokens[i])) { errors.push('Missing/invalid report type'); return errors; }
  i++;
  if (!tokens[i] || !/^[A-Z]{4}$/.test(tokens[i])) { errors.push('Invalid station ID'); return errors; }
  i++;
  if (!tokens[i] || !/^\d{6}Z$/.test(tokens[i])) { errors.push(`Invalid obs time: ${tokens[i]}`); return errors; }
  i++;
  if (tokens[i] === 'AUTO' || tokens[i] === 'COR') i++;
  if (!tokens[i] || !/^(\d{3}|VRB)\d{2,3}(G\d{2,3})?KT$/.test(tokens[i])) {
    errors.push(`Invalid wind: ${tokens[i]}`);
  }

  // Check for sky layers with wrong digit count (e.g. FEW0006)
  tokens.forEach(t => {
    if (/^(FEW|SCT|BKN|OVC|VV)\d{4,}/.test(t)) errors.push(`Malformed sky layer: ${t}`);
  });

  return errors;
}

function currentHourKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`;
}

function isCurrentHourCovered(records) {
  const now = new Date();
  const hh = now.getUTCHours();
  return records.some(r => {
    const m = r.raw.match(/\d{2}(\d{2})(\d{2})Z/);
    if (!m) return false;
    const rHH = parseInt(m[1]), mm = parseInt(m[2]);
    if (mm < 45 || mm > 59) return false;
    const dt = new Date(r.fetchedAt);
    return dt.getUTCHours() === hh
      && dt.getUTCDate() === now.getUTCDate()
      && dt.getUTCMonth() === now.getUTCMonth()
      && dt.getUTCFullYear() === now.getUTCFullYear();
  });
}

async function checkAndNotify(newRaws, allRecords) {
  const now = new Date();
  const mm = now.getUTCMinutes();

  // Only check for missing hourly after :59 (the window has closed)
  if (mm >= 59) {
    const hourKey = `missing-${currentHourKey()}`;
    if (!isCurrentHourCovered(allRecords)) {
      const label = `${String(now.getUTCDate()).padStart(2,'0')}/${String(now.getUTCHours()).padStart(2,'0')}Z`;
      await notify(hourKey,
        `KFMH ALERT: Missing hourly METAR for ${label}`,
        `🔴 **KFMH** — Missing hourly METAR for **${label}**`
      );
    }
  }

  // Validate new METARs
  for (const raw of newRaws) {
    const errors = basicValidate(raw);
    if (errors.length > 0) {
      const errKey = `error-${raw}`;
      const errList = errors.join('; ');
      await notify(errKey,
        `KFMH METAR ERROR: ${errList}\n${raw}`,
        `🔴 **KFMH METAR ERROR**\n\`${raw}\`\n${errList}`
      );
    }
  }
}

async function sendWeeklySummary() {
  const records = loadStore();
  const now = new Date();
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const weekRecords = records.filter(r => r.fetchedAt >= cutoff);

  // Count missing hours in the past 7 days
  const covered = new Set();
  weekRecords.forEach(r => {
    const m = r.raw.match(/\d{2}(\d{2})(\d{2})Z/);
    if (!m) return;
    const mm = parseInt(m[2]);
    if (mm >= 45 && mm <= 59) {
      const dt = new Date(r.fetchedAt);
      covered.add(`${dt.getUTCFullYear()}-${dt.getUTCMonth()}-${dt.getUTCDate()}-${parseInt(m[1])}`);
    }
  });

  let expectedHours = 0;
  for (let t = cutoff; t < now.getTime(); t += 3600000) expectedHours++;
  const missingHours = Math.max(0, expectedHours - covered.size);

  let errorCount7d = 0;
  weekRecords.forEach(r => { if (basicValidate(r.raw).length > 0) errorCount7d++; });

  const msg = [
    `📊 **KFMH Weekly Summary** (past 7 days)`,
    `• METARs collected: ${weekRecords.length}`,
    `• Missing hourly slots: ${missingHours} / ${expectedHours}`,
    `• METARs with errors: ${errorCount7d}`,
  ].join('\n');

  await sendDiscord(msg);
  log('INFO', 'Weekly summary sent to Discord');
}

function checkWeeklySchedule() {
  const now = new Date();
  // Friday = 5, 13:00 UTC = 8am EST
  if (now.getUTCDay() !== 5 || now.getUTCHours() !== 13 || now.getUTCMinutes() !== 0) return;
  const dateKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
  if (lastWeeklySummaryDate === dateKey) return;
  lastWeeklySummaryDate = dateKey;
  sendWeeklySummary().catch(e => log('ERROR', `Weekly summary failed: ${e.message}`));
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
  const existingRaws = new Set(existing.map(r => r.raw));
  const newRaws = lines.filter(l => !existingRaws.has(l));
  const newRecords = lines.map(raw => ({ raw, fetchedAt: now, source }));
  const merged = saveStore([...newRecords, ...existing]);
  lastFetchTime = now;
  lastFetchSource = source;
  log('INFO', `Store now has ${merged.length} record(s)`);

  await checkAndNotify(newRaws, merged);
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
  setInterval(checkWeeklySchedule, 60 * 1000);
});
