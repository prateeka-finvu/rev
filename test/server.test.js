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
    const env = Object.assign({}, process.env, {
      PORT: String(port),
      DATA_DIR: freshDataDir(),
      // Every other optional integration (chat, email auto-pull) stays off
      // unless a test explicitly opts in — keeps these tests hermetic.
      ANTHROPIC_API_KEY: '', GMAIL_USER: '', GMAIL_APP_PASSWORD: '',
      APP_PASSWORD: '', SESSION_SECRET: ''
    }, envOverrides || {});
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

async function main() {
  await loginGateOffSuite();
  await loginGateOnSuite();
  await dataDirFallbackSuite();
  await historicalActualsDuplicateSuite();
}

module.exports = main();

if (require.main === module) {
  module.exports.then(() => {
    const { summary } = require('./harness');
    const { failed } = summary('server.test.js');
    process.exit(failed ? 1 : 0);
  });
}
