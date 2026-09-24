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
      await testAsync('reports the real DATA_DIR, that it\'s writable, and the seeded historical months (Apr-Aug, no September yet)', async () => {
        // August joined the permanent seed 2026-09-24 (see "Making a closed
        // month's data survive for free" in README.md) once its actuals
        // were final — so a fresh DATA_DIR now legitimately has August
        // rows, same as Apr-Jul. September hasn't happened yet in-story, so
        // it's still a reliable "definitely not seeded" month for this
        // test to check against.
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
        assert(!('2026-09' in (body.historicalActuals.rowsByMonth || {})),
          'a freshly seeded DATA_DIR should have no September rows yet');
      });

      await testAsync('a month uploaded through the app shows up here immediately', async () => {
        const csv = 'FIU ID,Revenue,AU Counts,DF Counts\nsome-fiu,1000,50,900\n';
        const fd = new FormData();
        fd.append('month', '2026-09');
        fd.append('file', new Blob([csv], { type: 'text/csv' }), 'sep.csv');
        await fetch(server.baseUrl + '/api/historical-actuals/bulk', { method: 'POST', body: fd });
        const res = await fetch(server.baseUrl + '/api/data-status');
        const body = await res.json();
        assertEqual(body.historicalActuals.rowsByMonth['2026-09'], 1,
          'September should now show up in rowsByMonth. Body:\n' + JSON.stringify(body));
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

async function main() {
  await loginGateOffSuite();
  await loginGateOnSuite();
  await dataDirFallbackSuite();
  await historicalActualsDuplicateSuite();
  await homeEnvSecretsFileSuite();
  await dataStatusSuite();
  await projectionBaselineSuite();
}

module.exports = main();

if (require.main === module) {
  module.exports.then(() => {
    const { summary } = require('./harness');
    const { failed } = summary('server.test.js');
    process.exit(failed ? 1 : 0);
  });
}
