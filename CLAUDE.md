# METAR Validator — Project Brief for Claude Code

## What we're building

A full-stack aviation weather METAR validation tool for station KFMH (Otis ANGB, Cape Cod).

It has two parts:
1. **`server.js`** — a Node.js HTTP server that collects METARs every hour and serves them via a REST API
2. **`index.html`** — a browser-based validator that fetches from the server and validates each METAR against FAA FMH-1 and WMO 4678 rules

---

## Server (`server.js`)

### Runtime
- Node.js, no npm packages — use only built-ins: `http`, `https`, `fs`, `path`
- Zero dependencies so it runs anywhere with just `node server.js`

### Data collection
- Fetch METARs every hour using `setInterval`
- **Primary source**: `https://aviationweather.gov/api/data/metar?ids=KFMH&hours=2&format=raw`
  - Server-to-server request, no CORS issue
  - Parse response as plain text, split on newlines, keep lines matching `/^(METAR|SPECI)\s+[A-Z]{4}/`
- **Fallback source** (if AWC fails): CheckWX API
  - `GET https://api.checkwx.com/metar/KFMH`
  - Header: `X-API-Key: <CHECKWX_KEY>`
  - Response is JSON: `{ data: ["METAR KFMH ..."] }`
  - Use this automatically if AWC returns non-200 or no METAR lines

### Storage
- Flat JSON file: `metar_store.json` in the same directory
- Each record: `{ raw: string, fetchedAt: number, source: "aviationweather.gov"|"checkwx" }`
- Rolling 48-hour window — prune anything older than 48 hours on every write
- Deduplicate by raw string — never store the same METAR twice
- Sort newest first

### Configuration (read from environment variables with fallbacks)
```
STATION=KFMH
CHECKWX_KEY=bb936d6e4494474f93e71e03000158a2
PORT=3000
```

### REST API endpoints
All responses are JSON with `Access-Control-Allow-Origin: *` header.

- `GET /api/metars` — return all stored records
- `GET /api/metars?hours=24` — return records from last N hours only
- `GET /api/status` — server health: stored count, last fetch time, last fetch source, error count
- `GET /api/fetch` — trigger an immediate manual fetch (async, returns 202)
- `GET /` — list available endpoints

### Logging
Log to stdout with timestamp and level: `[2024-01-15T14:30:00.000Z] [INFO] message`

### Process management
- Handle SIGINT and SIGTERM gracefully
- On startup: fetch immediately, then start the hourly interval

---

## Frontend (`index.html`)

A single self-contained HTML file — no build step, no frameworks, no external CSS.

### Data source
Fetch from `http://localhost:3000/api/metars?hours=24` (the server above).
If the server is unreachable, show a clear error with a paste fallback textarea
so the user can paste raw METAR text directly.

### Controls
- Station ID input (default KFMH)
- Hours selector (1 / 2 / 3 / 6 / 12 / 24 / 48)
- "Check METARs" button
- Server URL input (so it can point at Railway or any host)

### Summary stats (shown after validation)
- Total reports
- Hourly METARs found (:45–:59)
- Missing hours (red if > 0)
- Field errors
- Rule violations
- UP reports

### Hourly gap detection
- A METAR issued between :45 and :59 of each hour counts as the scheduled hourly observation
- Build a grid of every UTC hour in the look-back window
- Green cell = hourly METAR found, red cell = missing, grey = current hour in progress
- Show a red banner listing each missing hour by day/hour UTC if any are missing

### Per-report validation
For each METAR, parse and validate every field in order:

**Field checks (each field shown as a labeled card — green/red/yellow):**
1. Report type — must be `METAR` or `SPECI`
2. Station ID — 4-letter ICAO
3. Obs time — `DDHHmmZ`; note if it's a scheduled hourly (:45–:59), top of hour, or SPECI
4. Modifier — `AUTO` or `COR` (optional)
5. Wind — `dddffKT`, `VRBffKT`, `00000KT`; extract gust if present
6. Wind variability — `dddVddd` (optional)
7. Visibility — SM fractions, CAVOK, 9999, 4-digit meters, P6SM, M1/4SM
8. RVR — optional runway visual range
9. Present weather — all WMO 4678 codes including blowing and drifting phenomena
10. Sky conditions — each layer as its own card; height decoded to feet
11. Temp/dewpoint — M prefix for below zero; flag spread ≤ 3°C
12. Altimeter — A or Q format; decode to inHg
13. Remarks — decode AO1/AO2, SLP, T-group, $ maintenance flag

**Cross-field rules (shown as coloured banners below the field grid):**

1. **Vis < 7SM → obscuration required**
   - Only true obscurations count: `BR FG FU VA DU SA HZ PY BLDU BLSA BLSN BLPY`
   - Precipitation codes (`RA SN DZ` etc.) are NOT obscurations — hard error if only precip present
   - Drifting (`DRSN DRDU DRSA`) are NOT obscurations — hard error if only drifting present
   - UP alone → warning (type unknown)

2. **Vis < 5/8SM → FG required**
   - Exception: blowing obscurations (`BLDU BLSA BLSN BLPY`) are valid without FG
   - `BR` at < 5/8SM → hard error (BR only valid ≥ 5/8SM)
   - Wrong obscuration coded → hard error naming the wrong code
   - UP present → warning

3. **Vis 5/8SM–7SM → obscuration must be BR, HZ, or other non-fog obscuration**
   - Valid in this range: BR HZ FU VA DU SA PY FG (patchy) BLDU BLSA BLSN BLPY
   - Unexpected obscuration in this range → error

4. **UP (unknown precipitation) → always flag as warning**
   - Detect: `UP`, `-UP`, `+UP`, `SHUP`, `FZUP`, `TSUP`, `BLUP`, `DRUP`, combos
   - Message: ASOS detected precip but couldn't identify type; COR needed

5. **Sky layer ordering → hard errors for all violations**
   - Heights must be strictly ascending
   - No duplicate heights
   - Nothing above OVC or VV
   - No lesser-coverage layer (FEW/SCT) above BKN/OVC/VV — automated ceilometer is blocked

### WMO 4678 weather code taxonomy
```
Plain obscurations:    BR FG FU VA DU SA HZ PY
Blowing obscurations:  BLDU BLSA BLSN BLPY  (BL + particle — count as true obscurations)
Drifting phenomena:    DRSN DRDU DRSA        (DR + particle — NOT obscurations)
Precipitation:         DZ RA SN SG IC PL GR GS  (NOT obscurations)
Unknown precip:        UP
Other:                 PO SQ FC SS DS
```

### Visual design
- Clean, minimal, no clutter
- Status: green dot = valid, red = errors, yellow = warnings
- Hourly grid: green/red/grey cells
- Report cards: collapsible `<details>` elements, first one open by default
- Red border on cards with errors, yellow on warnings
- Each field as a small labelled tile (label, value, optional note below)
- Cross-check results as coloured banners between the error list and field grid

---

## Files to create

```
metar-validator/
├── server.js          ← Node.js collection server
├── index.html         ← Standalone validator frontend
├── package.json       ← { "main": "server.js", "scripts": { "start": "node server.js" } }
├── .gitignore         ← node_modules, metar_store.json, .env
├── .env.example       ← STATION=KFMH\nCHECKWX_KEY=your_key_here\nPORT=3000
└── CLAUDE.md          ← this file
```

---

## Deployment target: Railway

The server will be deployed to Railway (railway.app).
- Railway sets `PORT` automatically via environment variable — always use `process.env.PORT`
- Set `CHECKWX_KEY` as a Railway environment variable (not hardcoded)
- The `package.json` start script must be `node server.js`
- The frontend `index.html` should have the server URL configurable so it can point at the Railway domain

---

## How to run locally

```bash
node server.js
# Server starts on port 3000
# Fetches METARs immediately, then every hour
# Open index.html in a browser — it talks to localhost:3000
```

---

## First prompt to give Claude Code after it reads this file

> "Read CLAUDE.md and build the full project exactly as described. Create all files listed. Make sure the server fetches from aviationweather.gov with CheckWX as fallback, stores in metar_store.json, and the frontend validates all the rules. Test that the server starts without errors."
