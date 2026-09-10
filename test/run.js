// Entry point for `npm test` — runs every test/*.test.js file in sequence
// against one shared harness, then prints a single combined summary and
// exits non-zero if anything failed. See README's "Testing" section.
//
// Run this before every deploy, not just after a fix — several of the
// bugs this suite exists to catch were themselves introduced by a fix for
// something else.

require('./compute.test.js'); // synchronous; suites run as a side effect of loading

async function main() {
  await require('./server.test.js'); // exports a Promise — suites already started, this awaits completion

  const { summary } = require('./harness');
  const { passed, failed } = summary('TOTAL');
  if (failed) {
    console.log('\n' + failed + ' test(s) failed — see FAIL lines above. Do not deploy until this is clean.');
    process.exit(1);
  } else {
    console.log('\nAll ' + passed + ' tests passed.');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('\nTest run crashed unexpectedly (not a test failure — a bug in the tests themselves, or the environment):');
  console.error(err);
  process.exit(1);
});
