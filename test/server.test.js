// Regression tests that actually spawn server.js as a real child process
// and talk to it over HTTP — for behavior that only exists at that level
// (the login gate, startup logging, DATA_DIR fallback, multipart uploads).
// Slower than compute.test.js (each test starts a fresh server against its
// own temp DATA_DIR) but still runs in a few seconds total. Run via
// `npm test` (see test/run.js and README's "Testing" section).
//
// Exports a Promise (module-level `main()` is invoked immediately below)
// so test/run.js can `await require('./server.test.js')` and know when
// every suite here — each of which spawns and tears down a real server —
// has actually finished, instead of racing ahead while child processes are
// still starting up or shutting down.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, testAsync, assert, assertEqual } = require('./harness');
const { buildChatContext } = require('../lib/chat');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

function freshDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rev-test-data-'));
}

// Spawns server.js with the given env overrides on a randomly-picked high
// port, waits for its startup log line (proof it's actually up and
// listening, not just that the process exists), and returns a handle for
// making requests against it and reading whatever it printed. Picking a
// random port per call (rather than a fixed one) keeps parallel/leftover
// processes from colliding — collisions are possible in principle but rare
// enough in practice for a sequential test run like this one.
function startServer(envOverrides) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const dataDir = freshDataDir();
    const env = Object.assign({}, process.env, {
      PORT: String(port),
      DATA_DIR: dataDir,
      // Every other optional integration (chat, email auto-pull) stays off
      // unless a test explicitly opts in — keeps these tests hermetic.
      ANTHROPIC_API_KEY: '', GMAIL_USER: '', GMAIL_APP_PASSWORD: '',
      APP_PASSWORD: '', SESSION_SECRET: ''
    }, envOverrides || {});
    // An envOverrides value of `undefined` means "actually unset this",
    // not "set it to the string 'undefined'" — used by the home-env-file
    // suite below, which needs APP_PASSWORD to be genuinely absent from
    // the child's environment (not merely ''), since dotenv only fills in
    // a variable that isn't already present at all.
    Object.keys(env).forEach(k => { if (env[k] === undefined) delete env[k]; });
    const proc = spawn('node', [SERVER_PATH], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error('server did not finish its startup log within 8s. Output so far:\n' + logs));
    }, 8000);
    function onData(chunk) {
      logs += chunk.toString();
      // Wait for "Login gate: ..." specifically, not just "listening on
      // port" — it's the last line server.js prints in its startup
      // sequence, so seeing it guarantees every earlier startup log line
      // (the port, the data directory, the SESSION_SECRET warning) already
      // arrived too. Resolving on "listening on port" alone raced ahead of
      // those later lines often enough to make getLogs() unreliable right
      // after start.
      if (!settled && /Login gate:/.test(logs)) {
        settled = true;
        clearTimeout(timer);
        resolve({
          port, baseUrl: 'http://127.0.0.1:' + port,
          dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : undefined,
          getLogs: () => logs,
          stop: () => new Promise(res => { proc.once('exit', res); proc.kill(); })
        });
      }
    }
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    proc.on('exit', code => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error('server exited early (code ' + code + '). Output:\n' + logs)); }
    });
  });
}

async function loginGateOffSuite() {
  await suite('Login gate — off by default', async () => {
    const server = await startServer({});
    try {
      await testAsync('APP_PASSWORD unset: root serves the app directly, no redirect', async () => {
        assert(/Login gate: OFF/.test(server.getLogs()), 'startup log should say the gate is OFF');
        const res = await fetch(server.baseUrl + '/', { redirect: 'manual' });
        assertEqual(res.status, 200, 'unauthenticated root request should not be redirected when auth is disabled');
      });
    } finally {
      await server.stop();
    }
  });
}

async function loginGateOnSuite() {
  await suite('Login gate — on when APP_PASSWORD is set', async () => {
    const server = await startServer({ APP_PASSWORD: 'correct-horse', SESSION_SECRET: 'test-secret-please-ignore' });
    try {
      await testAsync('startup log says ON, with no SESSION_SECRET warning since one is set', async () => {
        assert(/Login gate: ON \(APP_PASSWORD is set\)/.test(server.getLogs()));
        assert(!/SESSION_SECRET is not set/.test(server.getLogs().split('Login gate:')[1] || ''));
      });
      await testAsync('unauthenticated root request redirects to /login', async () => {
        const res = await fetch(server.baseUrl + '/', { redirect: 'manual' });
        assertEqual(res.status, 302);
        assertEqual(res.headers.get('location'), '/login');
      });
      await testAsync('unauthenticated API request gets a plain 401, not a redirect', async () => {
        const res = await fetch(server.baseUrl + '/api/fiu-metadata', { redirect: 'manual' });
        assertEqual(res.status, 401);
      });
      await testAsync('/healthz stays public even with auth on', async () => {
        const res = await fetch(server.baseUrl + '/healthz');
        assertEqual(res.status, 200);
      });
      await testAsync('wrong password is rejected', async () => {
        const res = await fetch(server.baseUrl + '/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'nope' })
        });
        assertEqual(res.status, 401);
      });
      let cookie;
      await testAsync('correct password logs in and sets a session cookie', async () => {
        const res = await fetch(server.baseUrl + '/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'correct-horse' })
        });
        assertEqual(res.status, 200);
        const setCookie = res.headers.get('set-cookie');
        assert(setCookie && /^session=/.test(setCookie), 'expected a session cookie to be set');
        cookie = setCookie.split(';')[0];
      });
      await testAsync('the session cookie then authenticates subsequent requests', async () => {
        const res = await fetch(server.baseUrl + '/api/fiu-metadata', { headers: { Cookie: cookie } });
        assertEqual(res.status, 200);
      });
    } finally {
      await server.stop();
    }
  });
}

async function dataDirFallbackSuite() {
  await suite('DATA_DIR fallback — explicit but unusable DATA_DIR doesn\'t crash the process', async () => {
    // A file (not a directory) makes any path *under* it fail with ENOTDIR
    // on mkdir — the same shape of failure as the real Render incident this
    // guards against (an env var pointing at a disk that was never actually
    // provisioned).
    const blockerFile = path.join(os.tmpdir(), 'rev-test-blocker-' + Date.now());
    fs.writeFileSync(blockerFile, 'not a directory');
    const badDataDir = path.join(blockerFile, 'sub');
    let server;
    try {
      await testAsync('server still starts, logs a warning, and falls back to the default data dir', async () => {
        server = await startServer({ DATA_DIR: badDataDir });
        const logs = server.getLogs();
        assert(/WARNING: DATA_DIR is set/.test(logs), 'expected the fallback warning to be logged');
        assert(/fell back to the default/.test(logs), 'startup summary line should say it fell back');
        const res = await fetch(server.baseUrl + '/healthz');
        assertEqual(res.status, 200, 'the app should still be fully up despite the bad DATA_DIR');
      });
    } finally {
      if (server) await server.stop();
      fs.unlinkSync(blockerFile);
    }
  });
}

async function historicalActualsDuplicateSuite() {
  await suite('Historical Actuals bulk upload — duplicate FIU ID rows', async () => {
    const server = await startServer({});
    try {
      // Matches the real shape found in production (ask: 2026-09-09): the
      // same FIU ID twice in one month's file, once per billing-type line.
      // AU count is identical across both rows on purpose (as it was in
      // the real case) — summing it would be an immediate, obvious bug.
      const csv = [
        'FIU ID,Revenue,AU Counts,DF Counts',
        'dup-fiu,1000,500,10000',
        'dup-fiu,2000,500,9990',
        'solo-fiu,300,50,900',
        ',,,' // a blank row — must be skipped, not crash the parse
      ].join('\n');

      await testAsync('duplicate rows: revenue summed, AU/DF take the larger value, reported in mergedFiuIds', async () => {
        const fd = new FormData();
        fd.append('month', '2026-08');
        fd.append('file', new Blob([csv], { type: 'text/csv' }), 'actuals.csv');
        const res = await fetch(server.baseUrl + '/api/historical-actuals/bulk', { method: 'POST', body: fd });
        const body = await res.json();
        assertEqual(res.status, 200, 'upload should succeed: ' + JSON.stringify(body));
        assert(body.mergedFiuIds.includes('dup-fiu'), 'dup-fiu should be reported as merged');
        assertEqual(body.mergedFiuIds.length, 1, 'solo-fiu has only one row and must not be reported as merged');
        assertEqual(body.created, 2, 'two distinct FIU IDs -> two records, not three');

        const rows = await (await fetch(server.baseUrl + '/api/historical-actuals')).json();
        const dup = rows.find(r => r.fiuId.toLowerCase() === 'dup-fiu' && r.month === '2026-08');
        assert(dup, 'expected a stored row for dup-fiu');
        assertEqual(dup.revenue, 3000, 'revenue: 1000 + 2000 summed');
        assertEqual(dup.auCount, 500, 'AU count: max(500, 500), NOT 1000 — this is the exact bug that shipped 2026-09-09/10');
        assertEqual(dup.dfCount, 10000, 'DF count: max(10000, 9990), NOT ~20000');

        const solo = rows.find(r => r.fiuId.toLowerCase() === 'solo-fiu' && r.month === '2026-08');
        assertEqual(solo.revenue, 300);
        assertEqual(solo.auCount, 50);
        assertEqual(solo.dfCount, 900);
      });

      await testAsync('re-uploading the same month overwrites cleanly (no accumulation across uploads)', async () => {
        const csv2 = 'FIU ID,Revenue,AU Counts,DF Counts\ndup-fiu,500,500,10000\n';
        const fd = new FormData();
        fd.append('month', '2026-08');
        fd.append('file', new Blob([csv2], { type: 'text/csv' }), 'actuals2.csv');
        await fetch(server.baseUrl + '/api/historical-actuals/bulk', { method: 'POST', body: fd });
        const rows = await (await fetch(server.baseUrl + '/api/historical-actuals')).json();
        const dup = rows.find(r => r.fiuId.toLowerCase() === 'dup-fiu' && r.month === '2026-08');
        assertEqual(dup.revenue, 500, 'a fresh upload for the same month must replace, not add to, the previous one');
      });
    } finally {
      await server.stop();
    }
  });
}

async function homeEnvSecretsFileSuite() {
  await suite('Durable ~/.fiu-revenue-estimator.env secrets file (fixed 2026-09-10)', async () => {
    // The app folder's own .env gets wiped on every update (fresh zip
    // extraction) — the exact issue behind the ask "Fix this so I do not
    // have to edit the .env file every time". The fix: also load a second
    // dotenv file from a fixed home-directory location that no update ever
    // touches. Uses a fake HOME so this never reads/writes the real one.
    //
    // server.js resolves its local .env relative to its own folder
    // (__dirname), not the process cwd — so every test below that expects
    // to see only the home-env file's values needs the *real* local .env
    // (if this machine happens to have one, e.g. for ANTHROPIC_API_KEY) out
    // of the way for the duration, since a real, non-blank APP_PASSWORD
    // sitting there would otherwise win and make these tests' outcomes
    // depend on whatever happens to be on the developer's own machine —
    // exactly the kind of environment-dependent failure that showed up as
    // a real report (some tests failing only on a machine with a real
    // local .env already configured, never in a clean checkout). Backed up
    // and restored around the whole suite, once, rather than per-test.
    const localEnvPath = path.join(__dirname, '..', '.env');
    const hadLocalEnv = fs.existsSync(localEnvPath);
    const localEnvBackup = hadLocalEnv ? fs.readFileSync(localEnvPath) : null;
    if (hadLocalEnv) fs.rmSync(localEnvPath);

    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-test-home-'));
    let server;
    try {
      await testAsync('no home-env file, no local .env: logs "not found", login gate stays off', async () => {
        server = await startServer({ HOME: fakeHome, APP_PASSWORD: undefined, SESSION_SECRET: undefined });
        const logs = server.getLogs();
        assert(logs.includes('Secrets file: ' + path.join(fakeHome, '.fiu-revenue-estimator.env') + ' (not found'),
          'expected the "not found" secrets-file log line. Logs:\n' + logs);
        assert(/Login gate: OFF/.test(logs), 'no APP_PASSWORD anywhere -> gate should be off');
        await server.stop();
        server = null;
      });

      await testAsync('APP_PASSWORD set only in the home-env file still turns the login gate on', async () => {
        fs.writeFileSync(path.join(fakeHome, '.fiu-revenue-estimator.env'),
          'APP_PASSWORD=from-home-env\nSESSION_SECRET=also-from-home-env\n');
        server = await startServer({ HOME: fakeHome, APP_PASSWORD: undefined, SESSION_SECRET: undefined });
        const logs = server.getLogs();
        assert(logs.includes('Secrets file: ' + path.join(fakeHome, '.fiu-revenue-estimator.env') + ' (loaded)'),
          'expected the "(loaded)" secrets-file log line. Logs:\n' + logs);
        assert(/Login gate: ON \(APP_PASSWORD is set\)/.test(logs),
          'a password that only exists in the home-env file should still enable the gate. Logs:\n' + logs);
        const res = await fetch(server.baseUrl + '/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'from-home-env' })
        });
        assertEqual(res.status, 200, 'the password loaded from the home-env file should actually work for login');
        await server.stop();
        server = null;
      });

      await testAsync('a blank placeholder line in the local .env does not block the home-env file\'s real value', async () => {
        // Regression for a real deployment failure (fixed 2026-09-10, same
        // day as the feature): .env.example ships every optional variable
        // as a blank placeholder line, e.g. `APP_PASSWORD=`. A naive
        // "dotenv.config() twice" implementation treats a key that's merely
        // *present* (even blank) as already set, so a leftover blank line
        // in the local .env — left over from following the "copy
        // .env.example to .env" instructions for an unrelated variable like
        // ANTHROPIC_API_KEY — silently blocked the home-env file's real
        // APP_PASSWORD from ever taking effect. The fix treats a blank
        // value the same as an absent line, regardless of which file (or
        // which order) it came from.
        fs.writeFileSync(localEnvPath, 'APP_PASSWORD=\nSESSION_SECRET=\n');
        try {
          fs.writeFileSync(path.join(fakeHome, '.fiu-revenue-estimator.env'),
            'APP_PASSWORD=from-home-env\nSESSION_SECRET=also-from-home-env\n');
          server = await startServer({ HOME: fakeHome, APP_PASSWORD: undefined, SESSION_SECRET: undefined });
          const logs = server.getLogs();
          assert(/Login gate: ON \(APP_PASSWORD is set\)/.test(logs),
            'a blank APP_PASSWORD= line in the local .env should not block the home-env file\'s real value. Logs:\n' + logs);
          const res = await fetch(server.baseUrl + '/api/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: 'from-home-env' })
          });
          assertEqual(res.status, 200, 'the home-env password should work even with a blank placeholder in the local .env');
        } finally {
          fs.rmSync(localEnvPath, { force: true });
        }
      });

      await testAsync('a real, non-blank local .env is left alone by these files (does not leak into other tests)', async () => {
        // Companion to the above: a *real* value already present in the
        // process environment before either file is read (this test
        // simulates that the same way startServer's own hermetic defaults
        // do, by passing APP_PASSWORD explicitly rather than deleting it)
        // must never be overwritten by file contents — otherwise a stray
        // local .env with real credentials would silently override every
        // other test in this whole suite file that expects the login gate
        // to stay off by default. This is the fix for the second
        // same-day regression: the first attempt at "blank shouldn't
        // block" went too far and let *any* blank process.env value
        // (including these hermetic test defaults) be filled in from
        // whatever real local .env happened to exist on disk.
        fs.writeFileSync(path.join(fakeHome, '.fiu-revenue-estimator.env'), 'APP_PASSWORD=from-home-env\n');
        server = await startServer({ HOME: fakeHome, APP_PASSWORD: 'explicitly-set-in-real-env' });
        const logs = server.getLogs();
        assert(/Login gate: ON \(APP_PASSWORD is set\)/.test(logs), 'a real env var should still enable the gate. Logs:\n' + logs);
        const res = await fetch(server.baseUrl + '/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'explicitly-set-in-real-env' })
        });
        assertEqual(res.status, 200, 'the real env var\'s value must win over the home-env file, not get overwritten by it');
        const wrongRes = await fetch(server.baseUrl + '/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'from-home-env' })
        });
        assertEqual(wrongRes.status, 401, 'the home-env file\'s value must NOT have silently replaced the real env var');
      });
    } finally {
      if (server) await server.stop();
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(localEnvPath, { force: true });
      if (hadLocalEnv) fs.writeFileSync(localEnvPath, localEnvBackup);
    }
  });
}

async function dataStatusSuite() {
  await suite('/api/data-status — self-diagnostic for the "data not persisting" class of bug', async () => {
    // Fixed 2026-09-23 (ask: "unable to preserve August actuals across
    // sessions" on Render) — a way to check where data is actually landing
    // without needing to dig through host deploy logs.
    let server;
    try {
      await testAsync('reports the real DATA_DIR, that it\'s writable, and the seeded historical months (Apr-Sep, no October yet)', async () => {
        // August joined the permanent seed 2026-09-24, September joined it
        // 2026-10-19 (see "Making a closed month's data survive for free"
        // in README.md) — KMBL-FIU-PROD and KMBL-FIU-PROD (PFM)'s new
        // DPU-table DF counts (ask: 2026-10-23 "the numbers I gave are for
        // September") landed inside the existing September rows, not as a
        // new October row — so a fresh DATA_DIR still has only August and
        // September seeded, same as before. October is still a reliable
        // "definitely not seeded" month for this test to check against.
        server = await startServer({});
        const res = await fetch(server.baseUrl + '/api/data-status');
        assertEqual(res.status, 200);
        const body = await res.json();
        assertEqual(body.dataDir, server.dataDir, 'should report this run\'s actual DATA_DIR');
        assertEqual(body.dataDirFellBack, false);
        assertEqual(body.dataDirInsideAppFolder, false, 'a temp DATA_DIR is never inside the app folder');
        assertEqual(body.writable, true);
        assert(body.historicalActuals && typeof body.historicalActuals.totalRows === 'number',
          'expected historicalActuals.totalRows. Body:\n' + JSON.stringify(body));
        assert(body.historicalActuals.rowsByMonth['2026-08'] > 0,
          'August is now part of the seed data — expected rowsByMonth to already include it. Body:\n' + JSON.stringify(body));
        assert(body.historicalActuals.rowsByMonth['2026-09'] > 0,
          'September is now part of the seed data too — expected rowsByMonth to already include it. Body:\n' + JSON.stringify(body));
        assert(!('2026-10' in (body.historicalActuals.rowsByMonth || {})),
          'a freshly seeded DATA_DIR should have no October rows yet');
      });

      await testAsync('a month uploaded through the app shows up here immediately', async () => {
        const csv = 'FIU ID,Revenue,AU Counts,DF Counts\nsome-fiu,1000,50,900\n';
        const fd = new FormData();
        fd.append('month', '2026-10');
        fd.append('file', new Blob([csv], { type: 'text/csv' }), 'oct.csv');
        await fetch(server.baseUrl + '/api/historical-actuals/bulk', { method: 'POST', body: fd });
        const res = await fetch(server.baseUrl + '/api/data-status');
        const body = await res.json();
        assertEqual(body.historicalActuals.rowsByMonth['2026-10'], 1,
          'October should now show up in rowsByMonth. Body:\n' + JSON.stringify(body));
      });

      await testAsync('requires login when the gate is on, same as every other /api/ route', async () => {
        await server.stop();
        server = await startServer({ APP_PASSWORD: 'secret123', SESSION_SECRET: 'test-secret' });
        const res = await fetch(server.baseUrl + '/api/data-status');
        assertEqual(res.status, 401);
      });
    } finally {
      if (server) await server.stop();
    }
  });
}

async function projectionBaselineSuite() {
  await suite('/api/revenue-projection-baseline — static Original FY Projection config (ask: 2026-09-24)', async () => {
    let server;
    try {
      // Seeded from data/revenue-projection-baseline.json (fixed 2026-09-24
      // — ask: "give you the projections for each month already ... remove
      // the input fields from the UI and just use the file with the data in
      // it") — same seedDataDirIfNeeded() mechanism as FIU Metadata/Yield &
      // CMGR/Historical Actuals, so a fresh DATA_DIR now comes pre-populated
      // with the committed FY-start plan rather than starting blank.
      await testAsync('starts out pre-seeded with the committed Original FY Projection baseline', async () => {
        server = await startServer({});
        const res = await fetch(server.baseUrl + '/api/revenue-projection-baseline');
        assertEqual(res.status, 200);
        const body = await res.json();
        assert(body && typeof body.values === 'object', 'expected a values object. Body:\n' + JSON.stringify(body));
        assertEqual(Object.keys(body.values).length, 12, 'expected all 12 FY months seeded from data/revenue-projection-baseline.json');
        assertEqual(body.values['2026-04'], 9415196);
        assertEqual(body.values['2027-03'], 26660084);
        assert(body.updatedAt, 'expected an updatedAt timestamp');
      });

      await testAsync('saves and reads back a set of monthly values', async () => {
        const res = await fetch(server.baseUrl + '/api/revenue-projection-baseline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: { '2026-04': 7921439, '2026-05': '8154435' } })
        });
        assertEqual(res.status, 200);
        const saved = await res.json();
        assertEqual(saved.values['2026-04'], 7921439);
        assertEqual(saved.values['2026-05'], 8154435, 'a numeric string should be coerced to a number');
        assert(saved.updatedAt, 'expected an updatedAt timestamp');

        const res2 = await fetch(server.baseUrl + '/api/revenue-projection-baseline');
        const body2 = await res2.json();
        assertEqual(body2.values['2026-04'], 7921439, 'should still be there on a fresh GET');
      });

      await testAsync('a second save replaces the whole config rather than merging', async () => {
        await fetch(server.baseUrl + '/api/revenue-projection-baseline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: { '2026-06': 8041628 } })
        });
        const res = await fetch(server.baseUrl + '/api/revenue-projection-baseline');
        const body = await res.json();
        assert(!('2026-04' in body.values), 'April should be gone — the grid always saves its full current state, not a delta');
        assertEqual(body.values['2026-06'], 8041628);
      });

      await testAsync('ignores a malformed month key and a non-numeric value rather than erroring', async () => {
        const res = await fetch(server.baseUrl + '/api/revenue-projection-baseline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: { 'not-a-month': 100, '2026-07': 'garbage', '2026-08': 1600000 } })
        });
        assertEqual(res.status, 200);
        const body = await res.json();
        assert(!('not-a-month' in body.values), 'malformed key should be dropped');
        assert(!('2026-07' in body.values), 'non-numeric value should be dropped');
        assertEqual(body.values['2026-08'], 1600000);
      });

      await testAsync('requires login when the gate is on, same as every other /api/ route', async () => {
        await server.stop();
        server = await startServer({ APP_PASSWORD: 'secret123', SESSION_SECRET: 'test-secret' });
        const getRes = await fetch(server.baseUrl + '/api/revenue-projection-baseline');
        assertEqual(getRes.status, 401);
        const postRes = await fetch(server.baseUrl + '/api/revenue-projection-baseline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: { '2026-04': 100 } })
        });
        assertEqual(postRes.status, 401);
      });
    } finally {
      if (server) await server.stop();
    }
  });
}

async function reseedSuite() {
  await suite('/api/reseed — manual reseed-from-bundled-data action (ask: 2026-10-20)', async () => {
    let server;
    try {
      await testAsync('overwrites a stale local data file with the bundled version', async () => {
        server = await startServer({});
        // Simulate a DATA_DIR that was seeded once, long before a later
        // patch changed the bundled yield-cmgr.json — exactly the scenario
        // that caused DPI Period Revenue to collapse to ~0 for Lending
        // while looking fine elsewhere.
        const ycPath = path.join(server.dataDir, 'yield-cmgr.json');
        const staleContent = JSON.stringify([{ fiuId: 'totally-stale-row', yield: 1, cmgr: 0 }]);
        fs.writeFileSync(ycPath, staleContent);
        const res = await fetch(server.baseUrl + '/api/reseed', { method: 'POST' });
        assertEqual(res.status, 200);
        const body = await res.json();
        assert(Array.isArray(body.reseeded) && body.reseeded.includes('yield-cmgr.json'),
          'expected yield-cmgr.json in the reseeded list. Body:\n' + JSON.stringify(body));
        const after = fs.readFileSync(ycPath, 'utf8');
        assert(after !== staleContent, 'yield-cmgr.json should have been overwritten, not left stale');
        const bundled = fs.readFileSync(path.join(__dirname, '..', 'data', 'yield-cmgr.json'), 'utf8');
        assertEqual(after, bundled, 'reseeded file should exactly match the bundled data/yield-cmgr.json');
      });

      await testAsync('reports every bundled .json file it reseeded', async () => {
        const res = await fetch(server.baseUrl + '/api/reseed', { method: 'POST' });
        const body = await res.json();
        const bundledNames = fs.readdirSync(path.join(__dirname, '..', 'data')).filter(n => n.endsWith('.json'));
        for (const name of bundledNames) {
          assert(body.reseeded.includes(name), name + ' should be in the reseeded list. Body:\n' + JSON.stringify(body));
        }
      });

      await testAsync('requires login when the gate is on, same as every other /api/ route', async () => {
        await server.stop();
        server = await startServer({ APP_PASSWORD: 'secret123', SESSION_SECRET: 'test-secret' });
        const res = await fetch(server.baseUrl + '/api/reseed', { method: 'POST' });
        assertEqual(res.status, 401);
      });
    } finally {
      if (server) await server.stop();
    }
  });
}

async function purposeCodeYieldSuite() {
  await suite('/api/compute — By License Type x Purpose Code yield (ask: 2026-10-26)', async () => {
    let server;
    try {
      await testAsync('dfYieldAnalysis.purposeCodeYield is well-formed and finds a real Stock Broker/105 combination with a nonzero Mar 2027 yield', async () => {
        server = await startServer({});
        // Use the bundled real FIU Metadata/Yield & CMGR config (seeded
        // fresh into this test's own DATA_DIR on first read, same as every
        // other test here) rather than hand-rolled fixtures — the business
        // logic itself (the per-purpose-code revenue/DF-volume formula) is
        // already thoroughly covered with controlled synthetic data in
        // compute.test.js's "purposeCodeYieldBreakdown()" suite; this test
        // exists only to catch a wiring regression in server.js's
        // buildComputeResponse (wrong field name, missed import, etc.),
        // which a unit test around lib/compute.js alone can't see.
        const metaRes = await fetch(server.baseUrl + '/api/fiu-metadata');
        const metaRows = await metaRes.json();
        // SBI_SECURITIES_FIU_PROD is a known Stock Broker FIU with a real,
        // measured purpose_code 105 slice in the bundled DPU-report-derived
        // yield-cmgr.json (100% of its code-105 volume in the 7mo slab) —
        // see scripts/recompute-deposit-rates.js. If a future data refresh
        // ever drops this specific FIU/code combination, this assertion
        // (not the feature) needs updating to point at whatever bundled
        // Stock Broker FIU has code 105 data at that point.
        const target = metaRows.find(m => String(m.fiuId).toUpperCase() === 'SBI_SECURITIES_FIU_PROD');
        assert(target, 'expected SBI_SECURITIES_FIU_PROD to still be in the bundled FIU Metadata — update this test if that FIU was retired');

        const csv = ['FIU ID,Active Users,Successful Data Fetches', 'SBI_SECURITIES_FIU_PROD,1000,500000'].join('\n');
        const fd = new FormData();
        fd.append('file', new Blob([csv], { type: 'text/csv' }), 'counts.csv');
        fd.append('asOfDate', '2026-09-09');
        fd.append('fyStartMonth', '4');
        fd.append('sucStartDate', '2026-10');
        const res = await fetch(server.baseUrl + '/api/compute', { method: 'POST', body: fd });
        const body = await res.json();
        assertEqual(res.status, 200, 'compute should succeed: ' + JSON.stringify(body));

        const pcy = body.dfYieldAnalysis && body.dfYieldAnalysis.purposeCodeYield;
        assert(pcy, 'expected dfYieldAnalysis.purposeCodeYield in the response');
        assert(Array.isArray(pcy.licenseTypes) && pcy.licenseTypes.length > 0, 'licenseTypes should be a non-empty array');
        assert(Array.isArray(pcy.purposeCodes) && pcy.purposeCodes.includes('105'), 'purposeCodes should include 105');
        assert(Array.isArray(pcy.byPeriod), 'byPeriod should be an array');

        const row = pcy.byPeriod.find(r => String(r.licenseType).toLowerCase() === 'stock broker' && r.purposeCode === '105');
        assert(row, 'expected a Stock Broker / 105 row in byPeriod. Rows seen: ' + JSON.stringify(pcy.byPeriod.filter(r => r.purposeCode === '105')));
        assert(row.mar2027 !== null && row.mar2027 > 0, 'Mar 2027 yield for Stock Broker / 105 should be a positive number once DPI Pricing is active: ' + JSON.stringify(row));
        assert(row.mar2027Revenue > 0 && row.mar2027DfCount > 0, 'Mar 2027 revenue and DF count should both be positive: ' + JSON.stringify(row));
      });

      await testAsync('dfYieldAnalysis.purposeCodeYield.totals is well-formed (ask: 2026-10-26, "purpose code wise count of Revenue and Yield")', async () => {
        server = await startServer({});
        const csv = ['FIU ID,Active Users,Successful Data Fetches', 'SBI_SECURITIES_FIU_PROD,1000,500000'].join('\n');
        const fd = new FormData();
        fd.append('file', new Blob([csv], { type: 'text/csv' }), 'counts.csv');
        fd.append('asOfDate', '2026-09-09');
        fd.append('fyStartMonth', '4');
        fd.append('sucStartDate', '2026-10');
        const res = await fetch(server.baseUrl + '/api/compute', { method: 'POST', body: fd });
        const body = await res.json();
        assertEqual(res.status, 200, 'compute should succeed: ' + JSON.stringify(body));

        const pcy = body.dfYieldAnalysis && body.dfYieldAnalysis.purposeCodeYield;
        assert(pcy, 'expected dfYieldAnalysis.purposeCodeYield in the response');
        assert(Array.isArray(pcy.totals), 'totals should be an array');
        assert(typeof pcy.totalsDpiLabel === 'string' && pcy.totalsDpiLabel.length > 0,
          'totalsDpiLabel should describe the DPI period once a DPI Pricing Start Date is set: ' + JSON.stringify(pcy.totalsDpiLabel));

        const code105 = pcy.totals.find(t => t.purposeCode === '105');
        assert(code105, 'expected a code 105 entry in totals. Rows seen: ' + JSON.stringify(pcy.totals));
        assert(code105.revenue > 0 && code105.dfCount > 0 && code105.yield > 0,
          'code 105 totals should be positive once DPI Pricing is active: ' + JSON.stringify(code105));

        // totals sums every license type across every DPI month (Oct-Mar
        // here), so it should be at least as large as the single Stock
        // Broker / Mar 2027 slice byPeriod already reports for the same
        // code — a regression check without re-deriving the whole formula
        // by hand.
        const stockBrokerMar = pcy.byPeriod.find(r => String(r.licenseType).toLowerCase() === 'stock broker' && r.purposeCode === '105');
        assert(stockBrokerMar && stockBrokerMar.mar2027Revenue > 0, 'expected a positive Stock Broker/105 Mar 2027 revenue to compare against');
        assert(code105.revenue >= stockBrokerMar.mar2027Revenue,
          'totals revenue for code 105 (summed across every license type and every DPI month) should be at least the single Stock Broker/Mar-2027 slice: ' + JSON.stringify({ code105, stockBrokerMar }));
      });

      await testAsync('purposeCodeYield.totals and totalsDpiLabel are empty when no DPI Pricing Start Date is set', async () => {
        server = await startServer({});
        const csv = ['FIU ID,Active Users,Successful Data Fetches', 'SBI_SECURITIES_FIU_PROD,1000,500000'].join('\n');
        const fd = new FormData();
        fd.append('file', new Blob([csv], { type: 'text/csv' }), 'counts.csv');
        fd.append('asOfDate', '2026-09-09');
        fd.append('fyStartMonth', '4');
        // sucStartDate intentionally omitted — no DPI Pricing Start Date set
        const res = await fetch(server.baseUrl + '/api/compute', { method: 'POST', body: fd });
        const body = await res.json();
        assertEqual(res.status, 200, 'compute should succeed: ' + JSON.stringify(body));

        const pcy = body.dfYieldAnalysis && body.dfYieldAnalysis.purposeCodeYield;
        assert(pcy, 'expected dfYieldAnalysis.purposeCodeYield in the response');
        assertEqual(pcy.totals.length, 0, 'totals should be empty with no DPI Pricing Start Date: ' + JSON.stringify(pcy.totals));
        assertEqual(pcy.totalsDpiLabel, null, 'totalsDpiLabel should be null with no DPI Pricing Start Date');
      });

      await testAsync('purposeCodeYield.totals carries a licenseType per row, broken out instead of collapsed across license types (ask: 2026-10-26, "add a license type column")', async () => {
        server = await startServer({});
        const csv = ['FIU ID,Active Users,Successful Data Fetches', 'SBI_SECURITIES_FIU_PROD,1000,500000'].join('\n');
        const fd = new FormData();
        fd.append('file', new Blob([csv], { type: 'text/csv' }), 'counts.csv');
        fd.append('asOfDate', '2026-09-09');
        fd.append('fyStartMonth', '4');
        fd.append('sucStartDate', '2026-10');
        const res = await fetch(server.baseUrl + '/api/compute', { method: 'POST', body: fd });
        const body = await res.json();
        assertEqual(res.status, 200, 'compute should succeed: ' + JSON.stringify(body));

        const pcy = body.dfYieldAnalysis && body.dfYieldAnalysis.purposeCodeYield;
        assert(pcy, 'expected dfYieldAnalysis.purposeCodeYield in the response');
        assert(pcy.totals.length > 0, 'expected at least one totals row with a DPI Pricing Start Date set');
        pcy.totals.forEach(t => {
          assert(typeof t.licenseType === 'string' && t.licenseType.length > 0,
            'every totals row should carry a non-empty licenseType: ' + JSON.stringify(t));
        });

        const code105Rows = pcy.totals.filter(t => t.purposeCode === '105');
        const code105StockBroker = code105Rows.find(t => String(t.licenseType).toLowerCase() === 'stock broker');
        assert(code105StockBroker && code105StockBroker.revenue > 0,
          'expected a Stock Broker row for code 105 in totals: ' + JSON.stringify(code105Rows));

        // Summing every license-type row for a given purpose code should
        // reconcile back to that code's single collapsed-across-license-type
        // revenue figure (code105 checked a few assertions up for byPeriod,
        // this checks the totals breakout sums correctly against itself).
        const code105Sum = code105Rows.reduce((s, t) => s + (t.revenue || 0), 0);
        assert(code105Sum >= code105StockBroker.revenue,
          'summed code-105 revenue across all license types should be at least the Stock Broker slice alone: ' + JSON.stringify({ code105Sum, code105StockBroker }));
      });

      await testAsync('purposeCodeYield.dpuSlabs and totals[].dpuSlabPct are well-formed (ask: 2026-10-27, "add a column for each DPU in the DPI rate card and mention each DPU\'s contribution % to DF during the DPI period")', async () => {
        server = await startServer({});
        const csv = ['FIU ID,Active Users,Successful Data Fetches', 'SBI_SECURITIES_FIU_PROD,1000,500000'].join('\n');
        const fd = new FormData();
        fd.append('file', new Blob([csv], { type: 'text/csv' }), 'counts.csv');
        fd.append('asOfDate', '2026-09-09');
        fd.append('fyStartMonth', '4');
        fd.append('sucStartDate', '2026-10');
        const res = await fetch(server.baseUrl + '/api/compute', { method: 'POST', body: fd });
        const body = await res.json();
        assertEqual(res.status, 200, 'compute should succeed: ' + JSON.stringify(body));

        const pcy = body.dfYieldAnalysis && body.dfYieldAnalysis.purposeCodeYield;
        assert(pcy, 'expected dfYieldAnalysis.purposeCodeYield in the response');
        assert(Array.isArray(pcy.dpuSlabs) && pcy.dpuSlabs.length === 8,
          'expected 8 DPU slabs (the DPI Utility Rate Card rows): ' + JSON.stringify(pcy.dpuSlabs));
        pcy.dpuSlabs.forEach(s => {
          assert(typeof s.key === 'string' && s.key.length > 0 && typeof s.label === 'string' && s.label.length > 0,
            'every dpuSlabs entry should carry a key and a label: ' + JSON.stringify(s));
        });
        assert(pcy.dpuSlabs.some(s => s.key === '7mo' && s.label === '7 Months'), 'expected a 7mo/"7 Months" slab: ' + JSON.stringify(pcy.dpuSlabs));

        const code105StockBroker = pcy.totals.find(t => t.purposeCode === '105' && String(t.licenseType).toLowerCase() === 'stock broker');
        assert(code105StockBroker, 'expected a Stock Broker / 105 row in totals: ' + JSON.stringify(pcy.totals.filter(t => t.purposeCode === '105')));
        assert(code105StockBroker.dpuSlabPct && typeof code105StockBroker.dpuSlabPct === 'object',
          'expected a dpuSlabPct object on the totals row: ' + JSON.stringify(code105StockBroker));
        pcy.dpuSlabs.forEach(s => {
          const v = code105StockBroker.dpuSlabPct[s.key];
          assert(v === null || (typeof v === 'number' && !isNaN(v)), 'dpuSlabPct.' + s.key + ' should be null or a number: ' + JSON.stringify(code105StockBroker.dpuSlabPct));
        });
        // dpuSlabPct values are a % of the row's OWN dfCount, and only the
        // Deposit-type share of a row has a DPU-slab breakdown at all (see
        // purposeCodeYieldBreakdown()'s comment in lib/compute.js) — so
        // they should sum to somewhere between 0% and 100%, never over.
        const slabPctSum = pcy.dpuSlabs.reduce((s, slab) => s + (code105StockBroker.dpuSlabPct[slab.key] || 0), 0);
        assert(slabPctSum >= 0 && slabPctSum <= 100.01,
          'dpuSlabPct values should sum to at most ~100% of the row\'s dfCount (the Deposit share, never more): ' + JSON.stringify({ slabPctSum, dpuSlabPct: code105StockBroker.dpuSlabPct }));
      });

      await testAsync('purposeCodeYield.byFiu is well-formed and reconciles with totals (ask: 2026-10-26, "FIU x Purpose Code wise Pre-DPI and Post-DPI Yield")', async () => {
        server = await startServer({});
        const csv = ['FIU ID,Active Users,Successful Data Fetches', 'SBI_SECURITIES_FIU_PROD,1000,500000'].join('\n');
        const fd = new FormData();
        fd.append('file', new Blob([csv], { type: 'text/csv' }), 'counts.csv');
        fd.append('asOfDate', '2026-09-09');
        fd.append('fyStartMonth', '4');
        fd.append('sucStartDate', '2026-10');
        const res = await fetch(server.baseUrl + '/api/compute', { method: 'POST', body: fd });
        const body = await res.json();
        assertEqual(res.status, 200, 'compute should succeed: ' + JSON.stringify(body));

        const pcy = body.dfYieldAnalysis && body.dfYieldAnalysis.purposeCodeYield;
        assert(pcy, 'expected dfYieldAnalysis.purposeCodeYield in the response');
        assert(Array.isArray(pcy.byFiu) && pcy.byFiu.length > 0, 'byFiu should be a non-empty array once DPI Pricing is active: ' + JSON.stringify(pcy.byFiu));

        const target = pcy.byFiu.find(r => String(r.fiuId).toUpperCase() === 'SBI_SECURITIES_FIU_PROD' && r.purposeCode === '105');
        assert(target, 'expected an SBI_SECURITIES_FIU_PROD / 105 row in byFiu. Rows seen: ' + JSON.stringify(pcy.byFiu.filter(r => r.purposeCode === '105')));
        assert(typeof target.legalName === 'string' && target.legalName.length > 0, 'byFiu row should carry a legalName: ' + JSON.stringify(target));
        assert(String(target.licenseType).toLowerCase() === 'stock broker', 'expected SBI_SECURITIES_FIU_PROD to be Stock Broker: ' + JSON.stringify(target));
        assert(target.revenue > 0 && target.dfCount > 0 && target.yield > 0,
          'byFiu revenue/dfCount/yield should all be positive once DPI Pricing is active: ' + JSON.stringify(target));

        // byFiu is the per-FIU breakout of the same underlying data as
        // totals (which is grouped by license type instead) — summing
        // byFiu's revenue for a given purpose code should exactly equal
        // summing totals' revenue for that same purpose code, since both
        // are built from the same buildPurposeCodeGroupTotals() call over
        // the same DPI-period rows, just grouped differently.
        const byFiuCode105Sum = pcy.byFiu.filter(r => r.purposeCode === '105').reduce((s, r) => s + (r.revenue || 0), 0);
        const totalsCode105Sum = pcy.totals.filter(t => t.purposeCode === '105').reduce((s, t) => s + (t.revenue || 0), 0);
        assert(Math.abs(byFiuCode105Sum - totalsCode105Sum) < 0.01,
          'byFiu revenue summed for code 105 should reconcile with totals revenue summed for code 105: ' + JSON.stringify({ byFiuCode105Sum, totalsCode105Sum }));
      });

      await testAsync('purposeCodeYield.byFiu is empty when no DPI Pricing Start Date is set', async () => {
        server = await startServer({});
        const csv = ['FIU ID,Active Users,Successful Data Fetches', 'SBI_SECURITIES_FIU_PROD,1000,500000'].join('\n');
        const fd = new FormData();
        fd.append('file', new Blob([csv], { type: 'text/csv' }), 'counts.csv');
        fd.append('asOfDate', '2026-09-09');
        fd.append('fyStartMonth', '4');
        // sucStartDate intentionally omitted — no DPI Pricing Start Date set
        const res = await fetch(server.baseUrl + '/api/compute', { method: 'POST', body: fd });
        const body = await res.json();
        assertEqual(res.status, 200, 'compute should succeed: ' + JSON.stringify(body));

        const pcy = body.dfYieldAnalysis && body.dfYieldAnalysis.purposeCodeYield;
        assert(pcy, 'expected dfYieldAnalysis.purposeCodeYield in the response');
        assertEqual(pcy.byFiu.length, 0, 'byFiu should be empty with no DPI Pricing Start Date: ' + JSON.stringify(pcy.byFiu));
      });

      await testAsync('requires login when the gate is on, same as every other /api/ route', async () => {
        await server.stop();
        server = await startServer({ APP_PASSWORD: 'secret123', SESSION_SECRET: 'test-secret' });
        const csv = ['FIU ID,Active Users,Successful Data Fetches', 'SBI_SECURITIES_FIU_PROD,1000,500000'].join('\n');
        const fd = new FormData();
        fd.append('file', new Blob([csv], { type: 'text/csv' }), 'counts.csv');
        const res = await fetch(server.baseUrl + '/api/compute', { method: 'POST', body: fd });
        assertEqual(res.status, 401);
      });
    } finally {
      if (server) await server.stop();
    }
  });
}

async function useCaseLicenseGroupingSuite() {
  await suite('/api/compute — groupedByUseCaseLicense (ask: 2026-10-26, "license type column... combination of use-case and license type")', async () => {
    let server;
    try {
      await testAsync('groupedByUseCaseLicense is well-formed and its revenue reconciles with groupedByUseCase', async () => {
        server = await startServer({});
        const csv = ['FIU ID,Active Users,Successful Data Fetches', 'SBI_SECURITIES_FIU_PROD,1000,500000'].join('\n');
        const fd = new FormData();
        fd.append('file', new Blob([csv], { type: 'text/csv' }), 'counts.csv');
        fd.append('asOfDate', '2026-09-09');
        fd.append('fyStartMonth', '4');
        fd.append('sucStartDate', '2026-10');
        const res = await fetch(server.baseUrl + '/api/compute', { method: 'POST', body: fd });
        const body = await res.json();
        assertEqual(res.status, 200, 'compute should succeed: ' + JSON.stringify(body));

        const uclt = body.groupedByUseCaseLicense;
        assert(uclt, 'expected groupedByUseCaseLicense in the response');
        assert(Array.isArray(uclt.revenue) && uclt.revenue.length > 0, 'groupedByUseCaseLicense.revenue should be a non-empty array');
        assert(Array.isArray(uclt.df) && uclt.df.length > 0, 'groupedByUseCaseLicense.df should be a non-empty array');
        uclt.revenue.forEach(g => {
          assert(typeof g.useCase === 'string' && g.useCase.length > 0, 'every row should carry a non-empty useCase: ' + JSON.stringify(g));
          assert(typeof g.licenseType === 'string' && g.licenseType.length > 0, 'every row should carry a non-empty licenseType: ' + JSON.stringify(g));
          assert(Array.isArray(g.monthly), 'every row should carry a monthly array: ' + JSON.stringify(g));
        });

        const sum = arr => arr.reduce((s, g) => s + g.monthly.reduce((a, b) => a + (b || 0), 0), 0);
        const ucltTotal = sum(uclt.revenue);
        const plainTotal = sum(body.groupedByUseCase.revenue);
        assert(Math.abs(ucltTotal - plainTotal) < 0.01,
          'groupedByUseCaseLicense.revenue summed across every (useCase, licenseType) pair should equal groupedByUseCase.revenue summed across every useCase: ' + JSON.stringify({ ucltTotal, plainTotal }));

        // Same check one level down: summing just the Lending use-case's
        // license-type breakout should reconcile with the plain Lending
        // row, same idea as the overall-total check above but scoped to
        // one use-case so a bug that only affects one useCase's split
        // (rather than the grand total) would still be caught.
        const lendingPlain = body.groupedByUseCase.revenue.find(g => g.label === 'Lending');
        if (lendingPlain) {
          const lendingPlainTotal = lendingPlain.monthly.reduce((a, b) => a + (b || 0), 0);
          const lendingUcltTotal = uclt.revenue.filter(g => g.useCase === 'Lending')
            .reduce((s, g) => s + g.monthly.reduce((a, b) => a + (b || 0), 0), 0);
          assert(Math.abs(lendingUcltTotal - lendingPlainTotal) < 0.01,
            'Lending summed across license types in groupedByUseCaseLicense should equal the plain groupedByUseCase Lending total: ' + JSON.stringify({ lendingUcltTotal, lendingPlainTotal }));
        }
      });
    } finally {
      if (server) await server.stop();
    }
  });
}

async function chatContextSuite() {
  await suite('lib/chat.js buildChatContext() — condensed data block stays in sync with the real /api/compute response (ask: 2026-10-27, "ensure that all text notes mentioned throughout the UI are consistent with the changes we have been making")', async () => {
    let server;
    try {
      await testAsync('groupedByUseCaseLicense and dfYieldAnalysis.purposeCodeYield (totals/byFiu/dpuSlabs) all survive into the chat context, not just the older pre-2026-10-26 fields', async () => {
        server = await startServer({});
        const csv = ['FIU ID,Active Users,Successful Data Fetches', 'SBI_SECURITIES_FIU_PROD,1000,500000'].join('\n');
        const fd = new FormData();
        fd.append('file', new Blob([csv], { type: 'text/csv' }), 'counts.csv');
        fd.append('asOfDate', '2026-09-09');
        fd.append('fyStartMonth', '4');
        fd.append('sucStartDate', '2026-10');
        const res = await fetch(server.baseUrl + '/api/compute', { method: 'POST', body: fd });
        const computeResult = await res.json();
        assertEqual(res.status, 200, 'compute should succeed: ' + JSON.stringify(computeResult));

        const ctx = buildChatContext(computeResult);

        assert(ctx.groupedByUseCaseLicense, 'expected groupedByUseCaseLicense in the chat context');
        assert(Array.isArray(ctx.groupedByUseCaseLicense.revenue) && ctx.groupedByUseCaseLicense.revenue.length > 0,
          'expected a non-empty groupedByUseCaseLicense.revenue in the chat context');
        assert(typeof ctx.groupedByUseCaseLicense.revenue[0].useCase === 'string' && typeof ctx.groupedByUseCaseLicense.revenue[0].licenseType === 'string',
          'groupedByUseCaseLicense rows in the chat context should carry useCase/licenseType: ' + JSON.stringify(ctx.groupedByUseCaseLicense.revenue[0]));

        const pcy = ctx.dfYieldAnalysis && ctx.dfYieldAnalysis.purposeCodeYield;
        assert(pcy, 'expected dfYieldAnalysis.purposeCodeYield in the chat context — the assistant needs this to answer By Purpose Code / By FIU x Purpose Code questions');
        assert(Array.isArray(pcy.totals) && pcy.totals.length > 0, 'expected a non-empty purposeCodeYield.totals in the chat context');
        assert(typeof pcy.totals[0].licenseType === 'string', 'chat context totals rows should carry licenseType: ' + JSON.stringify(pcy.totals[0]));
        assert(pcy.totals[0].dpuSlabPct && typeof pcy.totals[0].dpuSlabPct === 'object', 'chat context totals rows should carry dpuSlabPct: ' + JSON.stringify(pcy.totals[0]));
        assert(Array.isArray(pcy.dpuSlabs) && pcy.dpuSlabs.length === 8, 'expected the 8 dpuSlabs in the chat context: ' + JSON.stringify(pcy.dpuSlabs));
        assert(Array.isArray(pcy.byFiu) && pcy.byFiu.length > 0, 'expected a non-empty purposeCodeYield.byFiu in the chat context');
      });
    } finally {
      if (server) await server.stop();
    }
  });
}

async function bundledDataIntegritySuite() {
  await suite('Bundled data/fiu-metadata.json — License Type casing', async () => {
    await testAsync('no "Stock broker" (lowercase b) entries remain — merged into "Stock Broker" (ask: 2026-10-26)', async () => {
      // License Type is free text on the FIU Metadata tab (no fixed
      // dropdown), so a casing split like this can happen again — this is
      // a regression check on the bundled data, not on any compute logic.
      // Reads the committed file directly rather than going through a
      // running server, since this is about the data itself.
      const metaPath = path.join(__dirname, '..', 'data', 'fiu-metadata.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const lowercaseB = meta.filter(r => r.licenseType === 'Stock broker');
      assertEqual(lowercaseB.length, 0,
        'expected no FIUs left on the "Stock broker" casing variant, found: ' + JSON.stringify(lowercaseB.map(r => r.fiuId)));
      const properCase = meta.filter(r => r.licenseType === 'Stock Broker');
      assert(properCase.length > 0, 'expected at least some FIUs on the canonical "Stock Broker" casing');
    });
  });
}

async function main() {
  await loginGateOffSuite();
  await loginGateOnSuite();
  await dataDirFallbackSuite();
  await historicalActualsDuplicateSuite();
  await homeEnvSecretsFileSuite();
  await dataStatusSuite();
  await projectionBaselineSuite();
  await reseedSuite();
  await purposeCodeYieldSuite();
  await useCaseLicenseGroupingSuite();
  await chatContextSuite();
  await bundledDataIntegritySuite();
}

module.exports = main();

if (require.main === module) {
  module.exports.then(() => {
    const { summary } = require('./harness');
    const { failed } = summary('server.test.js');
    process.exit(failed ? 1 : 0);
  });
}
