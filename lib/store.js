// Tiny JSON-file-backed store — no database server required. Good fit for a
// few hundred FIU rows maintained by a small team. Each "table" is a single
// JSON file under data/ containing an array of row objects, upserted by
// fiuId. Swap this module out for a real database later if concurrent
// multi-writer access ever becomes a problem.
const fs = require('fs');
const path = require('path');
const os = require('os');

// SEED_DIR is the data/ folder bundled with the repo/zip — the starting FIU
// Metadata / Yield & CMGR / Historical Actuals every fresh copy of the app
// ships with. DATA_DIR is where the app actually reads/writes at runtime.
//
// DATA_DIR deliberately does NOT default to SEED_DIR (fixed 2026-09-03 —
// ask: "data doesn't persist, even running locally"). It used to, which
// seemed harmless for a normal git-based workflow, but this app is mostly
// updated by replacing the whole app folder with a freshly delivered copy
// (a new rev.zip locally, or a fresh `git pull` deploy on Render) — and a
// fresh copy always carries its own bundled data/ folder. With DATA_DIR
// defaulting to that same in-app folder, every update silently overwrote
// live FIU Metadata / Yield & CMGR / Historical Actuals with whatever
// starter data happened to be bundled in that particular copy — so entries
// made through the app never actually survived an update, locally or on
// Render.
//
// The default now lives in the OS user home directory instead — a fixed
// location no zip extraction or git pull ever touches — so local data
// survives every future app update with zero configuration needed. This
// only changes the *default*; explicitly setting DATA_DIR (as render.yaml
// does, pointing at a mounted persistent disk) still always wins and
// behaves exactly as before.
const SEED_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.fiu-revenue-estimator-data');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : DEFAULT_DATA_DIR;

// DATA_DIR (whether the new home-directory default, or an explicit
// persistent disk on Render) starts out empty the very first time the app
// ever points at it, which would otherwise make that first run look like a
// blank slate — no FIU Metadata, no Yield & CMGR, no Historical Actuals.
// This copies the bundled seed files over once, but only ones that don't
// already exist at the target — so it seeds a brand new DATA_DIR on first
// boot and never touches (or overwrites) real data on every boot after
// that, no matter how many times the app folder itself gets replaced by a
// fresh zip/deploy afterward. (The DATA_DIR === SEED_DIR guard below only
// matters if DATA_DIR is explicitly pointed back at the bundled data/
// folder itself — read at all in that case since source and destination
// are literally the same files.)
function seedDataDirIfNeeded() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (DATA_DIR === SEED_DIR || !fs.existsSync(SEED_DIR)) return;
  for (const name of fs.readdirSync(SEED_DIR)) {
    if (!name.endsWith('.json')) continue;
    const dest = path.join(DATA_DIR, name);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(SEED_DIR, name), dest);
    }
  }
}
seedDataDirIfNeeded();

function filePath(name) {
  return path.join(DATA_DIR, name + '.json');
}

function ensureFile(name) {
  const p = filePath(name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]', 'utf8');
  return p;
}

function readAll(name) {
  const p = ensureFile(name);
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('Corrupt data file ' + p + ': ' + err.message);
  }
}

function writeAll(name, rows) {
  const p = ensureFile(name);
  // Write to a temp file then rename — avoids truncating the file if the
  // process is killed mid-write.
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// A couple of tables aren't a row-array keyed by fiuId — e.g. the
// projection snapshot is a single object. These two helpers give those
// tables the same safe read/tmp-then-rename-write treatment as readAll/
// writeAll, without forcing them into the row/upsert shape.
function readObject(name, fallback) {
  const p = filePath(name);
  if (!fs.existsSync(p)) return fallback;
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('Corrupt data file ' + p + ': ' + err.message);
  }
}

function writeObject(name, obj) {
  const p = filePath(name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function normId(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

// Upsert a single row by fiuId (case-insensitive match on fiuId).
function upsert(name, row) {
  if (!row || !row.fiuId || !String(row.fiuId).trim()) {
    throw new Error('fiuId is required');
  }
  const rows = readAll(name);
  const key = normId(row.fiuId);
  const idx = rows.findIndex(r => normId(r.fiuId) === key);
  const clean = { ...row, fiuId: String(row.fiuId).trim() };
  if (idx === -1) rows.push(clean);
  else rows[idx] = { ...rows[idx], ...clean };
  writeAll(name, rows);
  return clean;
}

// Upsert many rows at once (bulk import). Returns count.
function upsertMany(name, incomingRows) {
  const rows = readAll(name);
  const byKey = new Map(rows.map(r => [normId(r.fiuId), r]));
  let created = 0, updated = 0;
  for (const row of incomingRows) {
    if (!row || !row.fiuId || !String(row.fiuId).trim()) continue;
    const key = normId(row.fiuId);
    const clean = { ...row, fiuId: String(row.fiuId).trim() };
    if (byKey.has(key)) { byKey.set(key, { ...byKey.get(key), ...clean }); updated++; }
    else { byKey.set(key, clean); created++; }
  }
  writeAll(name, Array.from(byKey.values()));
  return { created, updated, total: byKey.size };
}

// Upsert many rows keyed by an arbitrary compound key (e.g. fiuId + month)
// instead of fiuId alone — used for tables like historical actuals where a
// single FIU legitimately has one row per month.
function upsertManyBy(name, incomingRows, keyFn) {
  const rows = readAll(name);
  const byKey = new Map(rows.map(r => [keyFn(r), r]));
  let created = 0, updated = 0;
  for (const row of incomingRows) {
    const key = keyFn(row);
    if (!key) continue;
    if (byKey.has(key)) { byKey.set(key, { ...byKey.get(key), ...row }); updated++; }
    else { byKey.set(key, row); created++; }
  }
  writeAll(name, Array.from(byKey.values()));
  return { created, updated, total: byKey.size };
}

function remove(name, fiuId) {
  const rows = readAll(name);
  const key = normId(fiuId);
  const next = rows.filter(r => normId(r.fiuId) !== key);
  const removed = next.length !== rows.length;
  if (removed) writeAll(name, next);
  return removed;
}

// Exposed so server.js can log it at startup — makes it obvious (without
// reading source) exactly where this run's data is actually being read
// from/written to, which matters a lot now that the default lives outside
// the app folder (see the DATA_DIR comment above).
module.exports = { readAll, writeAll, upsert, upsertMany, upsertManyBy, remove, normId, readObject, writeObject, DATA_DIR };
