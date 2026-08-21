// Tiny JSON-file-backed store — no database server required. Good fit for a
// few hundred FIU rows maintained by a small team. Each "table" is a single
// JSON file under data/ containing an array of row objects, upserted by
// fiuId. Swap this module out for a real database later if concurrent
// multi-writer access ever becomes a problem.
const fs = require('fs');
const path = require('path');

// SEED_DIR is the data/ folder bundled with the repo — the starting FIU
// Metadata / Yield & CMGR / Historical Actuals every fresh checkout ships
// with. DATA_DIR is where the app actually reads/writes at runtime: by
// default that's the same folder (so local `npm start` behaves exactly as
// it always has), but on a host with a persistent disk mounted elsewhere —
// e.g. Render, see render.yaml — DATA_DIR points there instead, so edits
// made through the app survive a redeploy instead of living in the
// container's throwaway filesystem.
const SEED_DIR = path.join(__dirname, '..', 'data');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : SEED_DIR;

// A persistent disk starts out empty on its very first mount, which would
// otherwise make a fresh deploy look like a blank slate — no FIU Metadata,
// no Yield & CMGR, no Historical Actuals. This copies the bundled seed
// files over once, but only ones that don't already exist at the target —
// so it seeds a fresh disk on first boot and never touches (or overwrites)
// real data on every boot after that.
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

module.exports = { readAll, writeAll, upsert, upsertMany, upsertManyBy, remove, normId, readObject, writeObject };
