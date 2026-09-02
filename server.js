// Loads ANTHROPIC_API_KEY / ANTHROPIC_MODEL / PORT from a .env file next to
// this file, if one exists — see .env.example. Silently does nothing if
// there's no .env (e.g. when the real env vars are set another way, such as
// a host's dashboard or an inline `FOO=bar npm start`), so this is safe to
// leave in for every environment.
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

const store = require('./lib/store');
const { parseWorkbook, findMasterDataSheet } = require('./lib/parseFile');
const { buildColumnMap } = require('./lib/columns');
const { computeRevenue, groupRevenue, groupAuUsage, groupDfUsage, dfYieldBreakdown, buildActualsByMonth, fyFullMonths, monthLabel, toNumber, SCENARIO_DEFINITIONS } = require('./lib/compute');
const { askChat } = require('./lib/chat');
const { fetchLatestCountsEmail, describeImapError } = require('./lib/mailIngest');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const app = express();
// Render (and most hosts) put the app behind a reverse proxy that terminates
// TLS and forwards the real client info in X-Forwarded-* headers. Without
// this, req.secure is always false behind that proxy (so the login cookie
// would never get its `secure` flag) and req.ip would be the proxy's
// address instead of the visitor's (breaking login rate limiting below).
app.set('trust proxy', 1);
app.use(cors());
// Raised well above Express's 100kb default — the chat endpoint receives the
// full /api/compute response back from the browser (the whole FY dataset,
// which can be well over 1MB for ~500 FIUs x 12 months) as its `data` field.
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

// ================= Login gate =================
// A single shared password (APP_PASSWORD) protects the whole app — there's
// no per-user accounts, just one password for the team, matching how the
// rest of this app's config already works. Leaving APP_PASSWORD unset
// disables the gate entirely (same "unset = feature off" convention as
// ANTHROPIC_API_KEY / GMAIL_USER elsewhere) — that's what keeps `npm start`
// on localhost working exactly as before with no login screen. Set it
// before deploying anywhere public.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const AUTH_ENABLED = !!APP_PASSWORD;

// Signs/verifies session cookies without a server-side session store, so a
// login survives a server restart or redeploy (which would otherwise wipe
// an in-memory session table) as long as SESSION_SECRET stays the same.
// Falls back to a random secret generated at boot if SESSION_SECRET isn't
// set — logins still work, they just all get invalidated on every restart,
// which is fine for local use but worth calling out for a real deployment.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (AUTH_ENABLED && !process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set — using a random secret generated at startup. Everyone will be logged out on every server restart/redeploy. Set SESSION_SECRET in .env (e.g. `openssl rand -hex 32`) to keep logins stable across restarts.');
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;       // 12h — plain login, browser-session cookie
const REMEMBER_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90d — "stay logged in on this computer"

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signSessionToken(payload) {
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

// Returns the decoded payload for a valid, unexpired, correctly-signed
// token, or null for anything else (missing, malformed, tampered, expired).
function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}

// Constant-time password check — deliberately not a plain `===`, since
// string equality short-circuits on the first mismatched character and
// that timing difference is (in principle) usable to guess the password
// character by character.
function checkPassword(candidate) {
  if (!AUTH_ENABLED || typeof candidate !== 'string' || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(APP_PASSWORD);
  if (a.length !== b.length) {
    // Still run a same-shaped compare so a length mismatch doesn't return
    // measurably faster than a same-length wrong guess.
    crypto.timingSafeEqual(Buffer.alloc(b.length), Buffer.alloc(b.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function isAuthed(req) {
  if (!AUTH_ENABLED) return true;
  return !!verifySessionToken(req.cookies && req.cookies.session);
}

// Simple in-memory per-IP throttle on login attempts — this is a single
// shared password with nothing else standing between it and the internet
// once deployed, so it's worth making brute-forcing it slow. Resets are
// lost on restart, which is fine (a restart is already a rare event and
// not something an attacker controls).
const loginAttempts = new Map(); // ip -> { count, resetAt }
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
function isRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

// Always public, always 200, regardless of whether the login gate is even
// configured — a stable target for a host's health check (see render.yaml)
// so deploys don't depend on the auth gate's redirect behavior.
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

app.get('/login', (req, res) => {
  if (isAuthed(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Logo/favicon files only — served unauthenticated (unlike the rest of
// public/, gated below) since the login page itself needs to load them
// before anyone has logged in.
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

app.post('/api/login', (req, res) => {
  if (!AUTH_ENABLED) return res.status(400).json({ error: 'Login is not configured on this server (APP_PASSWORD is not set).' });
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts — wait a few minutes and try again.' });
  }
  const { password, remember } = req.body || {};
  if (!checkPassword(password)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const remembered = !!remember;
  const ttl = remembered ? REMEMBER_TTL_MS : SESSION_TTL_MS;
  const token = signSessionToken({ exp: Date.now() + ttl });
  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' };
  // Persistent cookie ("stay logged in") gets an explicit maxAge; otherwise
  // it's a plain session cookie the browser clears on its own when closed —
  // the token's own 12h expiry is a backstop in case it doesn't.
  if (remembered) cookieOpts.maxAge = ttl;
  res.cookie('session', token, cookieOpts);
  res.json({ ok: true });
});

// Everything registered from here on requires a valid session (or the gate
// being disabled entirely via an unset APP_PASSWORD) — API routes get a
// plain 401 (the frontend redirects to /login itself on that), page/static
// requests get redirected straight to /login.
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
  return res.redirect('/login');
}
app.use(requireAuth);

app.post('/api/logout', (req, res) => {
  res.clearCookie('session', { path: '/' });
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

const META_TABLE = 'fiu-metadata';
const YC_TABLE = 'yield-cmgr';
const HIST_TABLE = 'historical-actuals';
const PROJECTION_SNAPSHOT_TABLE = 'projection-snapshot';

// Historical key = normId(fiuId) + '::' + 'YYYY-MM' — one row per FIU per
// month, so a compound key (not a plain fiuId upsert) is required.
function histKey(row) {
  if (!row || !row.fiuId || !row.month) return null;
  return store.normId(row.fiuId) + '::' + row.month;
}

// Shared by /api/compute and /api/projection-snapshot — both take the same
// "just FIU ID + AU + DF counts" upload and only differ in what they do with
// the parsed counts afterward. Throws an Error with a `.status` so callers
// can respond with the same messages/status codes either endpoint used to
// produce inline.
function parseCountsUpload(fileBuffer) {
  let sheetNames, sheets;
  try {
    ({ sheetNames, sheets } = parseWorkbook(fileBuffer));
  } catch (err) {
    const e = new Error('Could not read file: ' + err.message);
    e.status = 400;
    throw e;
  }
  // Counts files are typically a single sheet; if multiple, prefer one
  // literally named "Master Data" for consistency with earlier files, else
  // just use the first sheet.
  const masterName = findMasterDataSheet(sheetNames) || sheetNames[0];
  const rows = sheets[masterName];
  if (!rows || !rows.length) {
    const e = new Error('No data rows found in the uploaded file');
    e.status = 400;
    throw e;
  }

  const colMap = buildColumnMap(rows[0], ['fiuId', 'activeUsers', 'dataFetches']);
  if (!colMap.fiuId) {
    const e = new Error('Could not find an FIU ID column');
    e.status = 400;
    throw e;
  }

  const counts = rows.map(r => ({
    fiuId: r[colMap.fiuId],
    activeUsers: colMap.activeUsers ? r[colMap.activeUsers] : '',
    dataFetches: colMap.dataFetches ? r[colMap.dataFetches] : ''
  })).filter(c => String(c.fiuId || '').trim());

  return { sheetNames, masterName, counts };
}

function toMetaRow(r) {
  const out = {
    fiuId: r.fiuId,
    legalName: r.legalName || '',
    tspName: r.tspName || '',
    licenseType: r.licenseType || '',
    useCase: r.useCase || '',
    billingModel: r.billingModel || ''
  };
  // Only set topTen when the caller actually sent it — so a Master Data
  // re-import (which never sends this field) doesn't clobber an existing
  // Top 10 flag back to No via the upsert merge.
  if (r.topTen !== undefined) out.topTen = !!r.topTen;
  return out;
}
// Only includes keys actually present on the input — this matters for
// partial updates (e.g. a bulk seed that only sets sucYield/sucCliffCmgr) so
// they don't blank out yield/cmgr that a merge-by-spread would otherwise
// wipe by setting them to `undefined`.
function toYcRow(r) {
  const out = { fiuId: r.fiuId };
  if (r.yield !== undefined) out.yield = r.yield;
  if (r.cmgr !== undefined) out.cmgr = r.cmgr;
  if (r.sucYield !== undefined) out.sucYield = r.sucYield;
  if (r.sucCliffCmgr !== undefined) out.sucCliffCmgr = r.sucCliffCmgr;
  if (r.sucRecoveryCmgr !== undefined) out.sucRecoveryCmgr = r.sucRecoveryCmgr;
  return out;
}

// ---------- FIU Metadata config ----------
app.get('/api/fiu-metadata', (req, res) => {
  res.json(store.readAll(META_TABLE));
});
app.post('/api/fiu-metadata', (req, res) => {
  try {
    res.json(store.upsert(META_TABLE, toMetaRow(req.body)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/fiu-metadata/:fiuId', (req, res) => {
  try {
    res.json(store.upsert(META_TABLE, toMetaRow({ ...req.body, fiuId: req.params.fiuId })));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/fiu-metadata/:fiuId', (req, res) => {
  const removed = store.remove(META_TABLE, req.params.fiuId);
  if (!removed) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ---------- Yield / CMGR config ----------
app.get('/api/yield-cmgr', (req, res) => {
  res.json(store.readAll(YC_TABLE));
});
app.post('/api/yield-cmgr', (req, res) => {
  try {
    res.json(store.upsert(YC_TABLE, toYcRow(req.body)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/yield-cmgr/:fiuId', (req, res) => {
  try {
    res.json(store.upsert(YC_TABLE, toYcRow({ ...req.body, fiuId: req.params.fiuId })));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/yield-cmgr/:fiuId', (req, res) => {
  const removed = store.remove(YC_TABLE, req.params.fiuId);
  if (!removed) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
// Bulk partial-update — body: { rows: [{ fiuId, yield?, cmgr?, sucYield?, sucCliffCmgr?, sucRecoveryCmgr? }, ...] }.
// Only the fields present on each row are touched; omitted fields (e.g.
// yield/cmgr when only seeding sucYield/sucCliffCmgr) are left as-is.
app.post('/api/yield-cmgr/bulk', (req, res) => {
  const incoming = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
  if (!incoming) return res.status(400).json({ error: 'Expected { rows: [...] }' });
  try {
    const result = store.upsertMany(YC_TABLE, incoming.map(toYcRow));
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---------- Historical Actuals ----------
// Once a month ends, its real revenue/AU/DF figures get recorded here (one
// row per FIU per month, keyed by histKey — see comment above) instead of
// being computed/projected. Every place that already reads this table —
// buildComputeResponse (both /api/compute and /api/compute-from-email),
// /api/projection-snapshot, and /api/revenue-actuals for the Projected vs
// Actual chart — reads it live via store.readAll on each request, so a row
// added here shows up everywhere immediately with no other wiring needed.
// billingModel/billingYield are stored for reference only (matching what
// each FIU's config said at the time) — the actual usage/revenue figures
// below always come from the row itself, never recomputed.
const MONTH_RE = /^\d{4}-\d{2}$/;
function toHistRow(r) {
  const out = { fiuId: r.fiuId, month: String(r.month || '').trim() };
  if (r.revenue !== undefined) out.revenue = r.revenue;
  if (r.auCount !== undefined) out.auCount = r.auCount;
  if (r.dfCount !== undefined) out.dfCount = r.dfCount;
  if (r.billingModel !== undefined) out.billingModel = r.billingModel;
  if (r.billingYield !== undefined) out.billingYield = r.billingYield;
  return out;
}

app.get('/api/historical-actuals', (req, res) => {
  res.json(store.readAll(HIST_TABLE));
});

// Single add/edit — body: { fiuId, month (YYYY-MM), revenue?, auCount?, dfCount?, billingModel?, billingYield? }.
app.post('/api/historical-actuals', (req, res) => {
  const fiuId = String(req.body && req.body.fiuId || '').trim();
  const month = String(req.body && req.body.month || '').trim();
  if (!fiuId) return res.status(400).json({ error: 'fiuId is required' });
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be in YYYY-MM format' });
  try {
    const row = toHistRow({ ...req.body, fiuId, month });
    store.upsertManyBy(HIST_TABLE, [row], histKey);
    res.json(row);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/historical-actuals/:fiuId/:month', (req, res) => {
  const key = store.normId(req.params.fiuId) + '::' + req.params.month;
  const rows = store.readAll(HIST_TABLE);
  const next = rows.filter(r => histKey(r) !== key);
  if (next.length === rows.length) return res.status(404).json({ error: 'Not found' });
  store.writeAll(HIST_TABLE, next);
  res.json({ ok: true });
});

// Bulk upload for one month at a time — multipart `file` + form field
// `month` (YYYY-MM). Same loose column matching as the monthly counts
// upload (FIU ID + Revenue and/or AU/DF counts — see lib/columns.js), so
// the same kind of export used for the monthly counts upload works here
// too, just with a Revenue column added. Upserts by FIU ID + month only —
// FIUs/months not present in this file are left completely untouched, so
// uploading July's actuals can never affect June's, and re-uploading a
// month to fix a mistake just overwrites that month's rows.
app.post('/api/historical-actuals/bulk', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const month = String(req.body.month || '').trim();
  if (!MONTH_RE.test(month)) {
    return res.status(400).json({ error: 'Pick a valid month (YYYY-MM) before choosing a file.' });
  }
  let sheetNames, sheets;
  try {
    ({ sheetNames, sheets } = parseWorkbook(req.file.buffer));
  } catch (err) {
    return res.status(400).json({ error: 'Could not read file: ' + err.message });
  }
  const masterName = findMasterDataSheet(sheetNames) || sheetNames[0];
  const rows = sheets[masterName];
  if (!rows || !rows.length) return res.status(400).json({ error: 'No data rows found in the uploaded file' });

  const colMap = buildColumnMap(rows[0], ['fiuId', 'revenue', 'activeUsers', 'dataFetches']);
  if (!colMap.fiuId) return res.status(400).json({ error: 'Could not find an FIU ID column' });
  if (!colMap.revenue && !colMap.activeUsers && !colMap.dataFetches) {
    return res.status(400).json({ error: 'Could not find a Revenue, Active Users, or Data Fetch column — need at least one of these to record an actual.' });
  }

  const metadataById = new Map(store.readAll(META_TABLE).map(r => [store.normId(r.fiuId), r]));
  const yieldCmgrById = new Map(store.readAll(YC_TABLE).map(r => [store.normId(r.fiuId), r]));

  const incoming = [];
  let skipped = 0;
  rows.forEach(r => {
    const fiuId = String(r[colMap.fiuId] || '').trim();
    if (!fiuId) return;
    const revenue = colMap.revenue ? toNumber(r[colMap.revenue]) : NaN;
    const auCount = colMap.activeUsers ? toNumber(r[colMap.activeUsers]) : NaN;
    const dfCount = colMap.dataFetches ? toNumber(r[colMap.dataFetches]) : NaN;
    if (isNaN(revenue) && isNaN(auCount) && isNaN(dfCount)) { skipped++; return; }
    const meta = metadataById.get(store.normId(fiuId));
    const yc = yieldCmgrById.get(store.normId(fiuId));
    incoming.push(toHistRow({
      fiuId, month,
      revenue: isNaN(revenue) ? undefined : revenue,
      auCount: isNaN(auCount) ? undefined : auCount,
      dfCount: isNaN(dfCount) ? undefined : dfCount,
      billingModel: meta ? meta.billingModel : undefined,
      billingYield: yc ? yc.yield : undefined
    }));
  });
  if (!incoming.length) {
    return res.status(400).json({ error: 'No usable rows found — every row was missing an FIU ID or all of Revenue/AU/DF.' });
  }

  const result = store.upsertManyBy(HIST_TABLE, incoming, histKey);
  res.json({
    sheetUsed: masterName,
    ignoredSheets: sheetNames.filter(n => n !== masterName),
    columnsFound: colMap,
    month,
    skipped,
    ...result
  });
});

// ---------- Convenience: seed both configs from a Master-Data-style file ----------
// Accepts the same file shape used previously (a sheet named "Master Data"
// with fiu_id, fiu_name, TSP, License, Use-case, Billing Model, a yield
// column, and optionally a CMGR/"Q2 CMGR Forecast" column). Upserts into
// both the FIU Metadata and Yield/CMGR configs so a team that already has
// this data doesn't have to retype ~500 rows by hand.
app.post('/api/seed-from-master-data', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let sheetNames, sheets;
  try {
    ({ sheetNames, sheets } = parseWorkbook(req.file.buffer));
  } catch (err) {
    return res.status(400).json({ error: 'Could not read file: ' + err.message });
  }
  const masterName = findMasterDataSheet(sheetNames);
  if (!masterName) {
    return res.status(400).json({ error: 'Could not find a sheet named "Master Data". Sheets found: ' + sheetNames.join(', ') });
  }
  const rows = sheets[masterName];
  if (!rows.length) return res.status(400).json({ error: '"Master Data" sheet is empty' });

  const colMap = buildColumnMap(rows[0], ['fiuId', 'legalName', 'tspName', 'licenseType', 'useCase', 'billingModel', 'yieldValue', 'cmgr']);
  if (!colMap.fiuId) return res.status(400).json({ error: 'Could not find an FIU ID column in "Master Data"' });

  const metaRows = [];
  const ycRows = [];
  rows.forEach(r => {
    const fiuId = String(r[colMap.fiuId] || '').trim();
    if (!fiuId) return;
    metaRows.push(toMetaRow({
      fiuId,
      legalName: colMap.legalName ? r[colMap.legalName] : '',
      tspName: colMap.tspName ? r[colMap.tspName] : '',
      licenseType: colMap.licenseType ? r[colMap.licenseType] : '',
      useCase: colMap.useCase ? r[colMap.useCase] : '',
      billingModel: colMap.billingModel ? r[colMap.billingModel] : ''
    }));
    const y = colMap.yieldValue ? toNumber(r[colMap.yieldValue]) : NaN;
    const g = colMap.cmgr ? toNumber(r[colMap.cmgr]) : NaN;
    ycRows.push(toYcRow({
      fiuId,
      yield: isNaN(y) ? '' : y,
      cmgr: isNaN(g) ? '' : g
    }));
  });

  const metaResult = store.upsertMany(META_TABLE, metaRows);
  const ycResult = store.upsertMany(YC_TABLE, ycRows);
  res.json({
    sheetUsed: masterName,
    ignoredSheets: sheetNames.filter(n => n !== masterName),
    columnsFound: colMap,
    metadata: metaResult,
    yieldCmgr: ycResult
  });
});

// ---------- Monthly upload + revenue computation ----------
// Shared by /api/compute and /api/compute-from-email — both end up with the
// same { fiuId, activeUsers, dataFetches } counts array (one from a direct
// upload, the other from a CSV attachment pulled out of an email) and from
// there run the exact same pipeline: join against the FIU Metadata / Yield &
// CMGR / Historical Actuals configs, compute the FY revenue curve, and build
// the TSP/Use-case/License rollups plus the DF Yield Analysis block. Kept as
// one function so the two endpoints can never quietly drift apart.
// Default As-of Date, when the caller doesn't provide one — "yesterday"
// (UTC), not today. Confirmed 2026-09-02, against a real Metabase MTD counts
// export dated/generated today but whose successful_data_fetches figures
// actually only reflect activity through end of the *previous* day (a
// one-day reporting/ETL lag, standard for a daily batch export like this):
// treating that file's As-of Date as today made projectMonthToDate divide
// each FIU's MTD total by the full day-of-month (2 completed calendar
// days), when the export itself only contains 1 day of real activity —
// understating projected monthly volume by roughly half, which then
// compounded through the whole SUC period. Re-running with As-of Date set
// to yesterday (dividing by 1 day instead of 2) moved projected FY revenue
// from ~₹13.6cr to ~₹22.6cr — matching an independent reference model's
// ~₹22.2cr almost exactly, across ~150 unrelated FIUs (median ratio
// exactly 1.00 once the lag is accounted for, vs. 0.51 without it). This
// only changes the *default* shown in the As-of Date field — it's always
// overridable (via the field itself, or the asOfDate form/JSON param) for
// a file that doesn't have this lag.
//
// "Yesterday" is measured on the India Standard Time (UTC+5:30) calendar —
// the timezone the Metabase export and the business day it reports on both
// run on — not the server's own clock. Render runs the server on UTC, and
// IST is 5:30 ahead of it, so during the tail end of each IST day (IST
// 00:00-05:29, which is UTC 18:30-23:59 the day before) the UTC calendar
// date is still one day behind the IST one. Computing "yesterday" from the
// server's raw UTC clock during that window silently produced a default
// one full day older than intended (fixed 2026-09-03 — confirmed against a
// real case where it was already Sep 3 in IST, Metabase had a Sep 2 pull,
// but the field still defaulted to Sep 1). Shifting `now` by the IST offset
// before reading its calendar date fields corrects this while still
// returning a UTC-midnight-anchored Date, matching how every other
// asOfDate consumer (computeRevenue, fyFullMonths, etc.) reads it via
// getUTCFullYear/getUTCMonth/getUTCDate.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function defaultAsOfDate() {
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const today = new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()));
  today.setUTCDate(today.getUTCDate() - 1);
  return today;
}

function buildComputeResponse(counts, { asOfDateStr, fyStartMonthStr, sucStartDateStr, scenariosStr, sheetUsed, ignoredSheets }) {
  const asOfDate = asOfDateStr ? new Date(asOfDateStr + 'T00:00:00Z') : defaultAsOfDate();
  const fyStartMonth = fyStartMonthStr ? parseInt(fyStartMonthStr, 10) : 4;

  // SUC Start Date — optional "YYYY-MM" string from the dropdown. From that
  // month onward, FIUs with both SUC Cliff CMGR and SUC Yield configured
  // switch to SUC Yield x Data Fetch volume, growing at SUC Cliff CMGR for
  // the first 3 months and SUC Recovery CMGR after that (falling back to the
  // regular CMGR if SUC Recovery CMGR isn't set).
  let sucStartDate = null;
  if (sucStartDateStr) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(sucStartDateStr).trim());
    if (m) sucStartDate = { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
  }

  const metaRows = store.readAll(META_TABLE);
  const ycRows = store.readAll(YC_TABLE);
  const histRows = store.readAll(HIST_TABLE);
  const metadataById = new Map(metaRows.map(r => [store.normId(r.fiuId), r]));
  const yieldCmgrById = new Map(ycRows.map(r => [store.normId(r.fiuId), r]));
  const historicalByKey = new Map(histRows.map(r => [histKey(r), r]));

  // What-if scenarios — a comma-separated list of SCENARIO_DEFINITIONS keys
  // from the frontend's checkboxes (e.g. "lendingCmgrWorse,nonBankPfmZero"),
  // any combination, in any order. An unrecognized key is silently ignored
  // rather than rejected, so old/new frontend and backend builds never hard-
  // fail on each other.
  const scenarios = {};
  if (scenariosStr) {
    const known = new Set(SCENARIO_DEFINITIONS.map(s => s.key));
    String(scenariosStr).split(',').map(s => s.trim()).filter(Boolean).forEach(key => {
      if (known.has(key)) scenarios[key] = true;
    });
  }

  const result = computeRevenue(counts, metadataById, yieldCmgrById, asOfDate, fyStartMonth, sucStartDate, historicalByKey, scenarios);
  // Each grouping (TSP / Use-case / License Type) rolls up three separate
  // per-month metrics — Revenue, AU count, and DF count — each with its own
  // row-inclusion rule (see groupRevenue/groupAuUsage/groupDfUsage).
  const groupBy = groupFn => ({
    revenue: groupRevenue(result.rows, groupFn, result.currentIndex),
    au: groupAuUsage(result.rows, groupFn, result.currentIndex),
    df: groupDfUsage(result.rows, groupFn, result.currentIndex)
  });
  const groupedByTsp = groupBy(r => r.tspName);
  const groupedByUseCase = groupBy(r => r.useCase);
  const groupedByLicense = groupBy(r => r.licenseType);

  // ---------- DF Yield Analysis ----------
  // DF Yield = Total Revenue / Total DF Count (see dfYieldBreakdown), shown
  // for three fixed points in the FY — the current (as-of) month, Oct 2026,
  // and Mar 2027 — each as an overall figure plus a By Use-case and By TSP
  // breakdown, and finally a By TSP view comparing all three months side by
  // side. Oct 2026 / Mar 2027 are looked up by calendar month rather than a
  // hardcoded index, so this degrades gracefully (index -1, empty views) if
  // a non-default FY start month ever puts them outside the current FY.
  function findMonthIndex(months, year, month) {
    return months.findIndex(m => m.year === year && m.month === month);
  }
  function buildDfYieldPeriod(rows, monthIndex, label) {
    if (monthIndex < 0) return { label, index: -1, overall: null, byUseCase: [], byTsp: [] };
    return {
      label,
      index: monthIndex,
      overall: dfYieldBreakdown(rows, () => 'Overall', monthIndex)[0] || { label: 'Overall', revenue: 0, dfCount: 0, yield: null },
      byUseCase: dfYieldBreakdown(rows, r => r.useCase, monthIndex),
      byTsp: dfYieldBreakdown(rows, r => r.tspName, monthIndex)
    };
  }
  const octIndex = findMonthIndex(result.months, 2026, 10);
  const marIndex = findMonthIndex(result.months, 2027, 3);
  const currentPeriod = buildDfYieldPeriod(result.rows, result.currentIndex, result.months[result.currentIndex] ? result.months[result.currentIndex].label : 'Current Month');
  const octPeriod = buildDfYieldPeriod(result.rows, octIndex, 'Oct 2026');
  const marPeriod = buildDfYieldPeriod(result.rows, marIndex, 'Mar 2027');

  const tspPeriods = [
    { key: 'current', label: currentPeriod.label, rows: currentPeriod.byTsp },
    { key: 'oct2026', label: octPeriod.label, rows: octPeriod.byTsp },
    { key: 'mar2027', label: marPeriod.label, rows: marPeriod.byTsp }
  ];
  const tspLabelSet = new Set();
  tspPeriods.forEach(p => p.rows.forEach(g => tspLabelSet.add(g.label)));
  const tspByPeriod = Array.from(tspLabelSet).sort().map(label => {
    const entry = { label };
    tspPeriods.forEach(p => {
      const g = p.rows.find(x => x.label === label);
      entry[p.key] = g ? g.yield : null;
    });
    return entry;
  });

  const dfYieldAnalysis = {
    periods: tspPeriods.map(p => ({ key: p.key, label: p.label })),
    current: currentPeriod,
    oct2026: octPeriod,
    mar2027: marPeriod,
    tspByPeriod
  };

  return {
    sheetUsed,
    ignoredSheets,
    asOfDate: asOfDate.toISOString().slice(0, 10),
    scenariosApplied: Object.keys(scenarios),
    ...result,
    groupedByTsp,
    groupedByUseCase,
    groupedByLicense,
    dfYieldAnalysis
  };
}

// Expects a file with FIU ID, AU count (active_users), DF count
// (successful_data_fetches) only — no yield, no billing model. Those come
// from the two configs above, joined server-side by FIU ID.
app.post('/api/compute', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let sheetNames, masterName, counts;
  try {
    ({ sheetNames, masterName, counts } = parseCountsUpload(req.file.buffer));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  try {
    const response = buildComputeResponse(counts, {
      asOfDateStr: req.body.asOfDate,
      fyStartMonthStr: req.body.fyStartMonth,
      sucStartDateStr: req.body.sucStartDate,
      scenariosStr: req.body.scenarios,
      sheetUsed: masterName,
      ignoredSheets: sheetNames.filter(n => n !== masterName)
    });
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scenario definitions (key/label/description) for the frontend to render
// its checkboxes from, so the two never drift apart — see
// SCENARIO_DEFINITIONS in lib/compute.js.
app.get('/api/scenarios', (req, res) => {
  res.json(SCENARIO_DEFINITIONS);
});

// ---------- Auto-pull today's counts from a Metabase email ----------
// In-memory cache of the last successful IMAP fetch — avoids hitting Gmail
// on every page refresh (an internal tool refreshed a few times a minute
// shouldn't trigger a fresh IMAP round trip every time). "Check email now"
// on the frontend passes force=true to bypass this. Not persisted to disk:
// a server restart just means the next request re-checks live, which is
// cheap and always correct.
let emailCountsCache = null; // { subject, date, filename, buffer, fetchedAt }
const EMAIL_CACHE_MS = (parseInt(process.env.EMAIL_CHECK_CACHE_MINUTES, 10) || 5) * 60 * 1000;

app.post('/api/compute-from-email', async (req, res) => {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  const subjectContains = process.env.METABASE_EMAIL_SUBJECT;
  if (!user || !pass || !subjectContains) {
    return res.status(400).json({
      error: 'Email auto-pull is not configured — set GMAIL_USER, GMAIL_APP_PASSWORD, and METABASE_EMAIL_SUBJECT in .env (see README\'s "Auto-pull counts from email" section).'
    });
  }

  const force = req.body.force === true || req.body.force === 'true';
  const fresh = emailCountsCache && (Date.now() - emailCountsCache.fetchedAt) < EMAIL_CACHE_MS;

  try {
    let hit;
    let usedCache = false;
    if (!force && fresh) {
      hit = emailCountsCache;
      usedCache = true;
    } else {
      // Belt-and-suspenders on top of mailIngest.js's own IMAP-level
      // timeouts — guarantees this request never hangs the page load
      // waiting on a black-holed connection (blocked port, dead host)
      // that somehow slips past those.
      const HARD_TIMEOUT_MS = 25 * 1000;
      const found = await Promise.race([
        fetchLatestCountsEmail({ user, pass, subjectContains }),
        new Promise((_resolve, reject) => setTimeout(() => {
          const e = new Error('Timed out waiting for the email server to respond — check network access to imap.gmail.com:993 and that GMAIL_USER/GMAIL_APP_PASSWORD are correct.');
          e.status = 502;
          reject(e);
        }, HARD_TIMEOUT_MS))
      ]);
      if (!found) {
        return res.status(404).json({
          error: 'No email found with subject containing "' + subjectContains + '" (checked the last 14 days) that has a CSV attached.'
        });
      }
      hit = { ...found, fetchedAt: Date.now() };
      emailCountsCache = hit;
    }

    let sheetNames, masterName, counts;
    try {
      ({ sheetNames, masterName, counts } = parseCountsUpload(hit.buffer));
    } catch (err) {
      return res.status(err.status || 400).json({ error: 'Could not read the CSV attached to that email: ' + err.message });
    }

    const response = buildComputeResponse(counts, {
      asOfDateStr: req.body.asOfDate,
      fyStartMonthStr: req.body.fyStartMonth,
      sucStartDateStr: req.body.sucStartDate,
      scenariosStr: req.body.scenarios,
      sheetUsed: masterName,
      ignoredSheets: sheetNames.filter(n => n !== masterName)
    });
    response.emailSource = {
      subject: hit.subject,
      date: hit.date,
      filename: hit.filename,
      fetchedAt: hit.fetchedAt,
      fromCache: usedCache
    };
    res.json(response);
  } catch (err) {
    // ImapFlow's own errors (bad password, IMAP disabled on the account, a
    // rejected search, etc.) carry their real detail on err.responseText —
    // see describeImapError's comment in lib/mailIngest.js — so this is
    // surfaced instead of the bare "Command failed" err.message would give.
    console.error('Email auto-pull check failed:', describeImapError(err));
    res.status(err.status || 502).json({ error: 'Could not check email: ' + describeImapError(err) });
  }
});

// ---------- Projected vs Actual revenue (FY) ----------
// A "projection snapshot" is a one-time, frozen baseline: the FY revenue
// curve as computed today, with SUC deliberately switched OFF (regular
// Yield/CMGR only) regardless of whatever SUC Start Date is selected in the
// live Monthly Revenue view — so it stays a stable reference point even as
// SUC billing rolls out and the live projection changes underneath it.
// Saving again overwrites the previous snapshot (there's one active
// baseline at a time, stamped with the date it was taken).
app.post('/api/projection-snapshot', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let counts;
  try {
    ({ counts } = parseCountsUpload(req.file.buffer));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  const asOfDate = req.body.asOfDate ? new Date(req.body.asOfDate + 'T00:00:00Z') : defaultAsOfDate();
  const fyStartMonth = req.body.fyStartMonth ? parseInt(req.body.fyStartMonth, 10) : 4;

  const metaRows = store.readAll(META_TABLE);
  const ycRows = store.readAll(YC_TABLE);
  const histRows = store.readAll(HIST_TABLE);
  const metadataById = new Map(metaRows.map(r => [store.normId(r.fiuId), r]));
  const yieldCmgrById = new Map(ycRows.map(r => [store.normId(r.fiuId), r]));
  const historicalByKey = new Map(histRows.map(r => [histKey(r), r]));

  // sucStartDate forced to null — see comment above.
  const result = computeRevenue(counts, metadataById, yieldCmgrById, asOfDate, fyStartMonth, null, historicalByKey);

  const snapshot = {
    snapshotDate: new Date().toISOString().slice(0, 10),
    asOfDate: asOfDate.toISOString().slice(0, 10),
    fyStartMonth,
    months: result.months.map(m => ({ year: m.year, month: m.month, label: m.label })),
    totalsByMonth: result.totalsByMonth
  };
  store.writeObject(PROJECTION_SNAPSHOT_TABLE, snapshot);
  res.json(snapshot);
});

app.get('/api/projection-snapshot', (req, res) => {
  res.json({ snapshot: store.readObject(PROJECTION_SNAPSHOT_TABLE, null) });
});

// Actual revenue recorded so far, summed per calendar month straight from
// the Historical Actuals store — independent of any counts upload, so the
// Projected-vs-Actual chart can render as soon as the page loads. A month
// with no historical rows at all comes back null (no data yet); query
// params mirror /api/compute's asOfDate/fyStartMonth so the FY month list
// (and therefore which months even show up) stays consistent between the
// projection snapshot and this series.
app.get('/api/revenue-actuals', (req, res) => {
  const asOfDate = req.query.asOfDate ? new Date(req.query.asOfDate + 'T00:00:00Z') : defaultAsOfDate();
  const fyStartMonth = req.query.fyStartMonth ? parseInt(req.query.fyStartMonth, 10) : 4;
  const monthCols = fyFullMonths(asOfDate, fyStartMonth).map(m => ({ ...m, label: monthLabel(m.year, m.month) }));
  const histRows = store.readAll(HIST_TABLE);
  const metaRows = store.readAll(META_TABLE);
  const historicalByKey = new Map(histRows.map(r => [histKey(r), r]));
  const metadataById = new Map(metaRows.map(r => [store.normId(r.fiuId), r]));
  res.json({ months: monthCols, actualsByMonth: buildActualsByMonth(monthCols, historicalByKey, metadataById) });
});

// ---------- Chat with your data ----------
// Body: { messages: [{role:'user'|'assistant', content: string}, ...], data: <the /api/compute JSON response the browser already has> }
// Stateless on the server — the browser resends the full message history
// each turn, and re-sends the currently computed dataset (`data`) each
// turn too, since the server itself doesn't retain a "current computation."
// Requires ANTHROPIC_API_KEY to be set as an environment variable; see
// README.md for setup. Never accepts an API key from the client.
app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not configured on the server. Set it as an environment variable and restart the server to enable chat — see README.md.' });
  }
  const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : null;
  if (!messages || !messages.length) {
    return res.status(400).json({ error: 'Expected { messages: [...] }' });
  }
  const data = req.body && req.body.data;
  if (!data || !Array.isArray(data.rows) || !data.rows.length) {
    return res.status(400).json({ error: 'No computed data available yet — upload a counts file and compute revenue first, then ask a question.' });
  }
  try {
    const result = await askChat({ apiKey, model: process.env.ANTHROPIC_MODEL, messages, computeResult: data });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Chat request failed: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('FIU Revenue Estimator backend listening on port ' + PORT);
});
