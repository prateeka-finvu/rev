// Minimal, dependency-free test harness — no test framework is installed
// (kept that way deliberately, see README's "Testing" section), so this is
// just enough structure to write and run assertions with readable output.
// Not meant to be a general-purpose framework — just what test/*.test.js
// need.

let currentSuite = '';
let currentTest = '';
let passed = 0;
let failed = 0;
const failures = [];

// Prints a header and runs fn(). If fn is async (or just returns a
// promise), the promise is returned so an async caller can `await
// suite(...)` and run suites strictly one after another — important for
// test/server.test.js, where each suite spawns and tears down a real
// server process and overlapping suites would race on ports/timing.
function suite(name, fn) {
  currentSuite = name;
  console.log('\n' + name);
  return fn();
}

function test(name, fn) {
  currentTest = name;
  try {
    fn();
    passed++;
    console.log('  ok  - ' + name);
  } catch (err) {
    failed++;
    failures.push({ suite: currentSuite, test: name, error: err });
    console.log('  FAIL - ' + name);
    console.log('        ' + (err && err.message ? err.message : err));
  }
}

// Async variant — awaited by the caller (test files use `await test(...)`
// for anything that talks to a spawned server).
async function testAsync(name, fn) {
  currentTest = name;
  try {
    await fn();
    passed++;
    console.log('  ok  - ' + name);
  } catch (err) {
    failed++;
    failures.push({ suite: currentSuite, test: name, error: err });
    console.log('  FAIL - ' + name);
    console.log('        ' + (err && err.message ? err.message : err));
  }
}

function fail(msg) {
  throw new Error(msg);
}

function assert(cond, msg) {
  if (!cond) fail(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    fail((msg ? msg + ' — ' : '') + 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

// Tolerant floating-point compare — every revenue/usage figure in this app
// goes through repeated multiplication (CMGR compounding), so exact
// equality is the wrong bar; this matches to the nearest rupee/unit by
// default (tolerance 0.01), which is plenty tight to catch a real bug
// while ignoring float noise.
function assertClose(actual, expected, tolerance, msg) {
  tolerance = tolerance == null ? 0.01 : tolerance;
  if (actual == null || expected == null || isNaN(actual) || isNaN(expected)) {
    if (Number.isNaN(actual) && Number.isNaN(expected)) return;
    fail((msg ? msg + ' — ' : '') + 'expected ~' + expected + ', got ' + actual);
  }
  if (Math.abs(actual - expected) > tolerance) {
    fail((msg ? msg + ' — ' : '') + 'expected ' + expected + ' ± ' + tolerance + ', got ' + actual);
  }
}

function assertNaN(actual, msg) {
  if (!Number.isNaN(actual)) fail((msg ? msg + ' — ' : '') + 'expected NaN, got ' + JSON.stringify(actual));
}

// Call at the end of a test file/run to print a summary and set the
// process exit code appropriately (test/run.js relies on this).
function summary(label) {
  console.log('\n' + (label ? label + ' — ' : '') + passed + ' passed, ' + failed + ' failed');
  return { passed, failed, failures };
}

module.exports = { suite, test, testAsync, assert, assertEqual, assertClose, assertNaN, fail, summary };
