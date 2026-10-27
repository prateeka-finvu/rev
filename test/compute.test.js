// Regression tests for lib/compute.js — the revenue engine. Run via
// `npm test` (see test/run.js) before every deploy; see README's "Testing"
// section. Pure unit tests, no server/network/filesystem involved, so
// these run in well under a second.
//
// Every suite below traces back to either a documented, deliberate piece
// of business logic (billing-model classification, SUC Cliff/Recovery,
// the per-FIU overrides) or an actual bug this app has shipped and fixed —
// each of those is called out by date so a future change that reintroduces
// the same failure mode fails loudly here instead of surfacing again as a
// live "why is revenue wrong" report.

const { suite, test, assert, assertEqual, assertClose, assertNaN } = require('./harness');
const compute = require('../lib/compute');
const {
  computeRevenue, classifyBillingModel, projectMonthToDate, fyFullMonths,
  buildActualsByMonth, toNumber,
  SUC_DEPOSIT_RATE_CARD, sucDepositTierDiscount, sucDepositRateForMonth,
  purposeCodeYieldBreakdown
} = compute;

function d(year, month1to12, day) {
  return new Date(Date.UTC(year, month1to12 - 1, day));
}

function meta(fiuId, over) {
  return Object.assign({ fiuId, billingModel: 'Active Users' }, over || {});
}
function yc(fiuId, over) {
  return Object.assign({ fiuId, yield: 1, cmgr: 0.05 }, over || {});
}
function metaMap(list) { return new Map(list.map(m => [String(m.fiuId).trim().toUpperCase(), m])); }
function ycMap(list) { return new Map(list.map(y => [String(y.fiuId).trim().toUpperCase(), y])); }
function histMap(rows) {
  const m = new Map();
  rows.forEach(r => m.set(String(r.fiuId).trim().toUpperCase() + '::' + r.month, r));
  return m;
}

// Convenience: run computeRevenue for a single FIU and return its monthly
// row array (what nearly every test below inspects).
function rowFor(fiuId, opts) {
  const {
    metaOver, ycOver, counts, hist, asOf, fyStart, sucStart, scenarios, dfOptFactor
  } = opts;
  const metadataById = metaMap([meta(fiuId, metaOver)]);
  const yieldCmgrById = ycMap([yc(fiuId, ycOver)]);
  const result = computeRevenue(
    counts || [{ fiuId, activeUsers: 1000, dataFetches: '' }],
    metadataById, yieldCmgrById,
    asOf || d(2026, 9, 9), fyStart || 4, sucStart || null,
    hist ? histMap(hist) : new Map(),
    scenarios || {},
    dfOptFactor
  );
  return { result, row: result.rows.find(r => r.fiuId === fiuId) };
}

function monthlyByLabel(row) {
  const m = {};
  row.monthly.forEach((mm, i) => { m[i] = mm; });
  return m;
}

suite('classifyBillingModel', () => {
  test('Active Users / Unique Users -> au', () => {
    assertEqual(classifyBillingModel('Active Users').usageType, 'au');
    assertEqual(classifyBillingModel('Unique Users').usageType, 'au');
  });
  test('Data Fetch variants -> df', () => {
    assertEqual(classifyBillingModel('Data Fetch').usageType, 'df');
    assertEqual(classifyBillingModel('Data Fetches').usageType, 'df');
  });
  test('Fixed/Flat billing -> df', () => {
    assertEqual(classifyBillingModel('Fixed Billing').usageType, 'df');
    assertEqual(classifyBillingModel('Flat Fee').usageType, 'df');
  });
  test('blank / Unbilled / Not billed / unrecognized -> null (excluded)', () => {
    assertEqual(classifyBillingModel(''), null);
    assertEqual(classifyBillingModel('Unbilled'), null);
    assertEqual(classifyBillingModel('Not billed'), null);
    assertEqual(classifyBillingModel('Something Else Entirely'), null);
  });
  test('Quarterly/Annual period label detected', () => {
    assertEqual(classifyBillingModel('Active Users (Quarterly)').periodLabel, 'Quarterly');
    assertEqual(classifyBillingModel('Data Fetch Annual').periodLabel, 'Annual');
  });
});

suite('projectMonthToDate', () => {
  test('scales MTD volume to a full month', () => {
    // Sep 2026 has 30 days; day 9 of 30 -> full-month = mtd * 30/9
    assertClose(projectMonthToDate(900, d(2026, 9, 9)), 3000);
  });
  test('day 0 or earlier returns NaN (no divide-by-zero)', () => {
    const fakeDate = { getUTCDate: () => 0, getUTCFullYear: () => 2026, getUTCMonth: () => 8 };
    assertNaN(projectMonthToDate(500, fakeDate));
  });
});

suite('fyFullMonths', () => {
  test('12 months, FY starting April, containing the as-of month', () => {
    const months = fyFullMonths(d(2026, 9, 9), 4);
    assertEqual(months.length, 12);
    assertEqual(months[0].year, 2026); assertEqual(months[0].month, 4);
    assertEqual(months[11].year, 2027); assertEqual(months[11].month, 3);
  });
  test('FY start month other than April', () => {
    const months = fyFullMonths(d(2026, 2, 1), 1); // calendar-year FY, Feb is inside it
    assertEqual(months[0].month, 1);
    assertEqual(months[0].year, 2026);
    assertEqual(months[11].month, 12);
  });
});

suite('Past months — actuals display, independent of revenue presence', () => {
  // Fixed 2026-09-03: AU/DF counts for a historical month used to be hidden
  // whenever `hasActual` (revenue-specific) was false, even though the row
  // had real recorded AU/DF data — e.g. an Unbilled FIU that will never
  // have Revenue but still has real usage on file. usage/dfUsage must come
  // back from the row whenever they're present, regardless of revenue.
  test('a past month with revenue: hasActual/billable true, values as recorded', () => {
    const { row } = rowFor('FIU-A', {
      hist: [{ fiuId: 'FIU-A', month: '2026-07', revenue: 50000, auCount: 12000, dfCount: '' }]
    });
    const m = row.monthly[3]; // Apr=0 .. Jul=3
    assertEqual(m.isActual, true);
    assertEqual(m.hasActual, true);
    assertEqual(m.billable, true);
    assertClose(m.usage, 12000);
    assertClose(m.revenue, 50000);
  });
  test('a past month with AU/DF but NO revenue: usage still shown, hasActual/billable false', () => {
    const { row } = rowFor('FIU-B', {
      hist: [{ fiuId: 'FIU-B', month: '2026-07', revenue: '', auCount: 8000, dfCount: '' }]
    });
    const m = row.monthly[3];
    assertEqual(m.hasActual, false, 'no revenue on file -> hasActual false');
    assertEqual(m.billable, false);
    assertClose(m.usage, 8000, 0.01, 'usage should still come through even without revenue');
  });
  test('a past month with nothing recorded at all: NaN/no data, not a guessed 0', () => {
    const { row } = rowFor('FIU-C', { hist: [] });
    const m = row.monthly[3];
    assertNaN(m.usage);
    assertNaN(m.revenue);
    assertEqual(m.hasActual, false);
    assertEqual(m.billable, false);
  });
});

suite('Current month — always the live upload, unaffected by forward-chain anchoring', () => {
  test('current month usage/revenue reflect the live (possibly partial) upload', () => {
    const { row, result } = rowFor('FIU-D', {
      counts: [{ fiuId: 'FIU-D', activeUsers: 30000, dataFetches: '' }],
      hist: [
        { fiuId: 'FIU-D', month: '2026-07', revenue: 100000, auCount: 100000, dfCount: '' },
        { fiuId: 'FIU-D', month: '2026-08', revenue: 100000, auCount: 100000, dfCount: '' }
      ],
      asOf: d(2026, 9, 9)
    });
    const cur = row.monthly[result.currentIndex];
    assertClose(cur.usage, 30000, 0.01, 'current month must show the live upload, not an actual-anchored figure');
    assertClose(cur.revenue, 30000);
  });
});

suite('Future-month compounding anchors on the last actual, not the partial current month', () => {
  // Fixed 2026-09-09 — ask: "Projected vs Actual Revenue" chart dipping
  // sharply right after the last actual month then only gradually
  // recovering. Root cause: every future month compounded straight off the
  // current month's own (often month-to-date/partial) live upload. This is
  // the single most load-bearing regression test in this file — it's the
  // fix, and it also covers the fallback path and the no-anchor edge case.
  test('October compounds from August\'s real actual, ignoring September\'s partial upload', () => {
    const { row } = rowFor('FIU-E', {
      counts: [{ fiuId: 'FIU-E', activeUsers: 30000, dataFetches: '' }], // Sep MTD pull, much lower than a full month
      hist: [
        { fiuId: 'FIU-E', month: '2026-07', revenue: 100000, auCount: 100000, dfCount: '' },
        { fiuId: 'FIU-E', month: '2026-08', revenue: 100000, auCount: 100000, dfCount: '' }
      ],
      asOf: d(2026, 9, 9) // current month = September, index 5
    });
    // Sep (current, live/partial): 30,000 — unaffected, see suite above.
    assertClose(row.monthly[5].usage, 30000);
    // Oct = August's actual (100,000) compounded two steps at 5%/month —
    // once for Sep, once for Oct — NOT 30,000 * 1.05 (which the bug would
    // have produced).
    assertClose(row.monthly[6].usage, 100000 * 1.05 * 1.05, 1, 'October must anchor on last actual, not the partial September upload');
    assertClose(row.monthly[11].usage, 100000 * Math.pow(1.05, 7), 1, 'March should be a clean compound from August, 7 steps out');
  });

  test('falls back to the live current-month baseline when there is no past actual at all', () => {
    const { row } = rowFor('FIU-F', {
      counts: [{ fiuId: 'FIU-F', activeUsers: 30000, dataFetches: '' }],
      hist: [], // brand new FIU, first-ever live month
      asOf: d(2026, 9, 9)
    });
    assertClose(row.monthly[5].usage, 30000);
    assertClose(row.monthly[6].usage, 30000 * 1.05, 0.5, 'with no anchor to fall back on, October must compound from September\'s own live baseline');
  });

  test('a FIU missing from the current month\'s counts upload keeps showing "no data" going forward (documented, not fixed by the anchor change)', () => {
    const metadataById = metaMap([meta('FIU-G')]);
    const yieldCmgrById = ycMap([yc('FIU-G')]);
    const result = computeRevenue(
      [{ fiuId: 'OTHER-FIU', activeUsers: 5, dataFetches: '' }], // FIU-G absent from this month's file
      metadataById, yieldCmgrById, d(2026, 9, 9), 4, null,
      histMap([
        { fiuId: 'FIU-G', month: '2026-07', revenue: 100000, auCount: 100000, dfCount: '' },
        { fiuId: 'FIU-G', month: '2026-08', revenue: 100000, auCount: 100000, dfCount: '' }
      ]),
      {}
    );
    const row = result.rows.find(r => r.fiuId === 'FIU-G');
    assert(row, 'a configured FIU absent from this month\'s upload should still get a row');
    assertNaN(row.monthly[5].usage, 'current month: no live data and hasData gate blocks the anchor path');
    assertNaN(row.monthly[6].usage, 'future months: still no data, since there was nothing to seed this month with');
  });
});

suite('SUC Cliff / Recovery', () => {
  test('phase and rate switch exactly at the 3-month Cliff/Recovery boundary', () => {
    const { row } = rowFor('FIU-H', {
      metaOver: { billingModel: 'Data Fetch' },
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.13, sucRecoveryCmgr: 0.02 },
      counts: [{ fiuId: 'FIU-H', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-H', month: '2026-08', revenue: 100000, auCount: '', dfCount: 4000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    assertEqual(row.monthly[6].sucPhase, 'cliff', 'Oct = SUC month 0');
    assertEqual(row.monthly[7].sucPhase, 'cliff', 'Nov = SUC month 1');
    assertEqual(row.monthly[8].sucPhase, 'cliff', 'Dec = SUC month 2');
    assertEqual(row.monthly[9].sucPhase, 'recovery', 'Jan = SUC month 3, first Recovery month');
    // dfForwardChain anchors on August's 4,000,000 actual, compounds at the
    // regular 5% CMGR through September (not SUC yet), then at Cliff/
    // Recovery rates from October — same anchor mechanism as the usage
    // suite above, just for the parallel DF-volume chain.
    const sepAnchor = 4000000 * 1.05;
    const oct = sepAnchor * 0.87;
    const nov = oct * 0.87;
    const dec = nov * 0.87;
    const jan = dec * 1.02;
    assertClose(row.monthly[6].dfUsage, oct, 1);
    assertClose(row.monthly[7].dfUsage, nov, 1);
    assertClose(row.monthly[8].dfUsage, dec, 1);
    assertClose(row.monthly[9].dfUsage, jan, 1);
    assertClose(row.monthly[6].revenue, oct * 1, 1, 'revenue = dfUsage x SUC Yield');
  });

  test('SUC Recovery CMGR falls back to the FIU\'s regular CMGR when left blank', () => {
    const { row } = rowFor('FIU-I', {
      metaOver: { billingModel: 'Data Fetch' },
      ycOver: { cmgr: 0.03, sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.1 /* sucRecoveryCmgr omitted */ },
      counts: [{ fiuId: 'FIU-I', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-I', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    const sepAnchor = 1000000 * 1.03;
    const oct = sepAnchor * 0.9, nov = oct * 0.9, dec = nov * 0.9;
    const jan = dec * 1.03; // Recovery uses the regular 3% CMGR, not a configured Recovery rate
    assertClose(row.monthly[9].dfUsage, jan, 1);
  });

  test('SUC never applies without both SUC Yield and SUC Cliff CMGR configured', () => {
    const { row } = rowFor('FIU-J', {
      metaOver: { billingModel: 'Data Fetch' },
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1 /* no sucCliffCmgr */ },
      counts: [{ fiuId: 'FIU-J', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-J', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    assertEqual(row.monthly[6].sucActive, false, 'missing SUC Cliff CMGR should leave this FIU on its regular CMGR/Yield entirely');
  });
});

suite('DPI period Deposit/non-Deposit rate split (ask: 2026-10-20)', () => {
  // Deposit-type Data Fetch volume during the DPI period bills at the DPU
  // rate card (sucDepositRate — a blended rate derived externally from the
  // DPU report and the Finfactor DPI Utility Rate Card, not computed by
  // this file); non-Deposit volume keeps billing at sucNonDepositRate — the
  // FIU's own realized Rs/fetch rate, derived externally from its
  // Historical Actuals revenue / Data Fetch count (the same "DF Yield"
  // concept the DF Yield Analysis / Summary tabs already use elsewhere).
  // The old single "100% of DF volume x SUC Yield" formula no longer
  // drives revenue at all (SUC Yield / sucYieldValue is confirmed unused
  // for pricing from here on — ask: "No, it does not if you use the rate
  // card and divide the total fetches into different DPU buckets" — though
  // the field stays on file and is still what gates sucConfigured/
  // sucApplicable, unchanged from before this feature). Crucially,
  // sucNonDepositRate is NOT the same thing as the FIU's regular Yield &
  // CMGR `yield` field — that field is Rs/*user* for an Active/Unique-
  // User-billed FIU, and multiplying it straight against Data Fetch volume
  // would wildly overstate the non-Deposit portion (caught during this
  // feature's own build: axisbank's Rs-5/user Yield applied against its
  // ~2M-fetch DPI-period volume produced a ~17x-too-high monthly figure
  // before this was caught and sucNonDepositRate was introduced instead).
  test('100% Deposit share bills entirely at the DPU/rate-card Deposit rate, ignoring both sucNonDepositRate and the legacy SUC Yield', () => {
    const { row } = rowFor('FIU-DEP1', {
      metaOver: { billingModel: 'Data Fetch' },
      ycOver: { sucYield: 9 /* legacy field — must be ignored */, sucCliffCmgr: 0, sucRecoveryCmgr: 0, sucDepositSharePct: 1, sucDepositRate: 4, sucNonDepositRate: 1.5 },
      counts: [{ fiuId: 'FIU-DEP1', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-DEP1', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    const oct = 1000000 * 1.05; // Sept anchor at the regular 5% CMGR, flat (0%) Cliff rate thereafter
    assertClose(row.monthly[6].dfUsage, oct, 1);
    assertClose(row.monthly[6].revenue, oct * 4, 1, 'revenue = dfUsage x Deposit rate (4), not x sucNonDepositRate (1.5) or x legacy SUC Yield (9)');
  });

  test('0% Deposit share (no Deposit split configured at all) bills entirely at sucNonDepositRate, not the legacy SUC Yield', () => {
    const { row } = rowFor('FIU-DEP0', {
      metaOver: { billingModel: 'Data Fetch' },
      ycOver: { sucYield: 9 /* legacy field — must be ignored */, sucCliffCmgr: 0, sucRecoveryCmgr: 0, sucNonDepositRate: 2.5 /* no sucDepositSharePct/sucDepositRate at all */ },
      counts: [{ fiuId: 'FIU-DEP0', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-DEP0', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    // 0% Deposit share also makes this FIU "pureNonDepositFiu" (ask:
    // 2026-10-20, see the dedicated suite below) — Cliff CMGR (0%, set
    // above) is skipped in favor of the regular 5% CMGR, so October
    // compounds once more past the Sept anchor instead of staying flat.
    const oct = 1000000 * 1.05 * 1.05;
    assertClose(row.monthly[6].revenue, oct * 2.5, 1, 'revenue = dfUsage x sucNonDepositRate (2.5) when there is no Deposit share on file, not x legacy SUC Yield (9)');
  });

  test('a mixed Deposit share blends the Deposit rate and sucNonDepositRate proportionally', () => {
    const { row } = rowFor('FIU-DEPMIX', {
      metaOver: { billingModel: 'Data Fetch' },
      ycOver: { sucYield: 9 /* legacy field — must be ignored */, sucCliffCmgr: 0, sucRecoveryCmgr: 0, sucDepositSharePct: 0.4, sucDepositRate: 4, sucNonDepositRate: 1.5 },
      counts: [{ fiuId: 'FIU-DEPMIX', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-DEPMIX', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    const oct = 1000000 * 1.05;
    const expected = oct * (0.4 * 4 + 0.6 * 1.5); // 40% at the Deposit rate, 60% at sucNonDepositRate
    assertClose(row.monthly[6].revenue, expected, 1);
  });

  test('a Deposit share on file with no Deposit rate contributes zero from that portion instead of corrupting the whole month to NaN', () => {
    const { row } = rowFor('FIU-DEPNORATE', {
      metaOver: { billingModel: 'Data Fetch' },
      ycOver: { sucYield: 9 /* legacy field — must be ignored */, sucCliffCmgr: 0, sucRecoveryCmgr: 0, sucDepositSharePct: 0.4 /* sucDepositRate omitted */, sucNonDepositRate: 1.5 },
      counts: [{ fiuId: 'FIU-DEPNORATE', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-DEPNORATE', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    const oct = 1000000 * 1.05;
    assert(!isNaN(row.monthly[6].revenue), 'a missing Deposit rate should not NaN out the whole month\'s revenue');
    assertClose(row.monthly[6].revenue, oct * 0.6 * 1.5, 1, 'the 40% Deposit portion contributes 0 — only the 60% non-Deposit portion (at sucNonDepositRate 1.5) counts');
  });

  test('an Active/Unique-User-billed FIU is NOT billed against its own Rs/user Yield during the DPI period — that would be a unit mismatch against Data Fetch volume', () => {
    const { row } = rowFor('FIU-AUDEP', {
      metaOver: { billingModel: 'Unique Users' },
      // yield: 5 is Rs/user (the yc() helper default is overridden here to
      // make the mismatch obvious) — if this ever leaks into the DPI-period
      // formula again, dfUsage (500k-ish) x 5 would blow this test's
      // assertion way past sucNonDepositRate's modest 0.1 figure.
      ycOver: { yield: 5, sucYield: 9 /* legacy field — must be ignored */, sucCliffCmgr: 0, sucRecoveryCmgr: 0, sucNonDepositRate: 0.1 },
      counts: [{ fiuId: 'FIU-AUDEP', activeUsers: 50000, dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-AUDEP', month: '2026-08', revenue: 100000, auCount: 45000, dfCount: 1000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    // No sucDepositSharePct here either, so this FIU is also
    // "pureNonDepositFiu" — see the note on the previous test.
    const oct = 1000000 * 1.05 * 1.05;
    assertClose(row.monthly[6].revenue, oct * 0.1, 1, 'revenue = dfUsage x sucNonDepositRate (0.1), not x the Rs/user Yield (5)');
  });
});

suite('sucDepositTierDiscount() / sucDepositRateForMonth() — per-month Deposit tiering (ask: 2026-10-26)', () => {
  // The Finfactor DPI Utility Rate Card's AA Fee isn't one flat ₹/fetch
  // figure per DPU slab — it's volume-discounted (0/10/15/20% off the
  // row's higher-end figure), and the discount tier must be read off
  // EACH MONTH'S OWN projected Deposit-type Data Fetch volume, not locked
  // to whatever volume a single historical report happened to measure
  // (ask: "apply the tier discount based on the FIU's projected data
  // fetch count for deposit FI type for each month. Do not simply apply
  // discount based on September volumes.").
  test('tier boundaries: <1M = 0%, 1M-5M = 10%, 5M-10M = 15%, >=10M = 20%', () => {
    assertEqual(sucDepositTierDiscount(0), 0);
    assertEqual(sucDepositTierDiscount(999999), 0);
    assertEqual(sucDepositTierDiscount(1000000), 0.10);
    assertEqual(sucDepositTierDiscount(4999999), 0.10);
    assertEqual(sucDepositTierDiscount(5000000), 0.15);
    assertEqual(sucDepositTierDiscount(9999999), 0.15);
    assertEqual(sucDepositTierDiscount(10000000), 0.20);
    assertEqual(sucDepositTierDiscount(50000000), 0.20);
  });

  test('1-day and Profile-and-summary rows never discount regardless of volume', () => {
    assertEqual(SUC_DEPOSIT_RATE_CARD['1d'][1], false, '1d row must be marked non-discountable');
    assertEqual(SUC_DEPOSIT_RATE_CARD['ps'][1], false, 'ps row must be marked non-discountable');
    const highVolRate = sucDepositRateForMonth({ '1d': 1 }, 50000000);
    assertClose(highVolRate, 0.08, 0.0001, 'the 1d row stays at its flat ₹0.08 fee even at a 50M-fetch month');
  });

  test('a FIU split across several slabs blends each slab\'s own (independently discounted) fee by its fixed share — the KMBL-style purpose-code-split pattern', () => {
    // Mirrors how a FIU's fixed multi-slab mix (e.g. KMBL-FIU-PROD (PFM)'s
    // 13mo/4mo/1mo/1w/5d/1d split, purpose-code-derived in
    // scripts/recompute-deposit-rates.js) blends at a given month's volume
    // — the mix itself is fixed, but every discountable slab's fee moves
    // together as that month's total Deposit volume crosses a tier.
    const shares = { '13mo': 0.3, '1mo': 0.5, '1d': 0.2 };
    const lowVolRate = sucDepositRateForMonth(shares, 500000); // 0% discount
    const expectedLow = 0.3 * 4.8 + 0.5 * 0.470 + 0.2 * 0.08;
    assertClose(lowVolRate, expectedLow, 0.0001);

    const highVolRate = sucDepositRateForMonth(shares, 6000000); // 15% discount on discountable rows only
    const expectedHigh = 0.3 * (4.8 * 0.85) + 0.5 * (0.470 * 0.85) + 0.2 * 0.08; // 1d un-discounted
    assertClose(highVolRate, expectedHigh, 0.0001);
    assert(highVolRate < lowVolRate, 'a higher-volume month must land on a lower (or equal) blended rate than a lower-volume month, never higher');
  });

  test('a slab missing from the shares map contributes nothing (degrades gracefully, same philosophy as the rest of the Deposit/non-Deposit split)', () => {
    const rate = sucDepositRateForMonth({ '7mo': 1 }, 2000000); // only one of 8 slabs populated
    assertClose(rate, 3.35 * 0.90, 0.0001);
  });
});

suite('Per-month dynamic Deposit tiering inside computeRevenue (ask: 2026-10-26)', () => {
  // Patch 45 derived one static sucDepositRate per FIU, locked to whatever
  // discount tier a single historical (September) report's volume happened
  // to fall into. This correction instead stores each FIU's fixed per-slab
  // MIX as sucDepositSlabShares, and recomputes the blended rate fresh
  // every DPI Pricing month from that month's own projected Deposit
  // volume (dfUsage x sucDepositSharePct) — so a fast-growing FIU can move
  // into a better (or worse) discount tier partway through the DPI
  // Pricing period, which a single locked rate could never reflect.
  test('a FIU whose projected Deposit volume crosses a discount tier mid-DPI-period gets a different blended rate in the month it crosses, not the rate its launch-month volume implied', () => {
    const { row } = rowFor('FIU-TIERGROW', {
      metaOver: { billingModel: 'Data Fetch' },
      ycOver: {
        sucYield: 9 /* legacy field — must be ignored */,
        sucCliffCmgr: 0.8, sucRecoveryCmgr: 0.8,
        sucDepositSharePct: 1,
        sucDepositSlabShares: { '5d': 1 }, // single discountable slab, AA Fee high-end 0.180
        sucNonDepositRate: 1.5 // irrelevant here — 100% Deposit share
      },
      counts: [{ fiuId: 'FIU-TIERGROW', activeUsers: '', dataFetches: 500000 }], // current-month count only needs to be present (non-blank) to satisfy sucBillable — all SUC-period months below compound off the August historical actual instead, same forward-chain mechanic as every other test in this file
      hist: [{ fiuId: 'FIU-TIERGROW', month: '2026-08', revenue: 100000, auCount: '', dfCount: 900000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    const sept = 900000 * 1.05;           // regular (pre-SUC) CMGR anchor
    const oct = sept * 1.8;               // first Cliff month: 945000 * 1.8 = 1,701,000 -> 1M-5M tier (10% off)
    const nov = oct * 1.8;                // second Cliff month: 3,061,800 -> still 1M-5M tier (10% off)
    const dec = nov * 1.8;                // third Cliff month: 5,511,240 -> crosses into 5M-10M tier (15% off)

    assertClose(row.monthly[6].dfUsage, oct, 1);
    assertClose(row.monthly[6].revenue, oct * (0.180 * 0.90), 1, 'October lands in the 1M-5M (10%) tier off its OWN volume, not the 0% tier September\'s lower volume would have locked in');
    assertClose(row.monthly[7].revenue, nov * (0.180 * 0.90), 1, 'November is still in the same 10% tier as October');
    assertClose(row.monthly[8].revenue, dec * (0.180 * 0.85), 1, 'December crosses into the 5M-10M (15%) tier purely because its own projected volume grew past 5,000,000 — a locked, September-based rate could never show this');
    assert(row.monthly[8].revenue / dec < row.monthly[6].revenue / oct, 'the blended per-fetch rate must drop as volume moves into a richer discount tier');
  });

  test('a FIU with no sucDepositSlabShares on file falls back to its static sucDepositRate, completely unaffected by volume', () => {
    const { row } = rowFor('FIU-NOSLABS', {
      metaOver: { billingModel: 'Data Fetch' },
      ycOver: {
        sucYield: 9, sucCliffCmgr: 0.8, sucRecoveryCmgr: 0.8,
        sucDepositSharePct: 1, sucDepositRate: 4 /* static fallback, no sucDepositSlabShares at all */,
        sucNonDepositRate: 1.5
      },
      counts: [{ fiuId: 'FIU-NOSLABS', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-NOSLABS', month: '2026-08', revenue: 100000, auCount: '', dfCount: 900000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    const sept = 900000 * 1.05;
    const oct = sept * 1.8;
    const dec = oct * 1.8 * 1.8;
    // Even though December's volume (>5M) would land in a much richer
    // rate-card tier if it were slab-based, this FIU has no
    // sucDepositSlabShares on file, so it must keep billing at its flat,
    // unconditional static rate (4) in every month regardless of volume.
    assertClose(row.monthly[6].revenue, oct * 4, 1);
    assertClose(row.monthly[8].revenue, dec * 4, 1, 'no tiering should apply at all without sucDepositSlabShares — the static rate never varies by volume');
    assertEqual(row.sucDepositRateIsDynamic, false);
  });

  test('sucDepositRateIsDynamic reports true for a FIU with sucDepositSlabShares configured', () => {
    const { row } = rowFor('FIU-DYNFLAG', {
      metaOver: { billingModel: 'Data Fetch' },
      ycOver: {
        sucYield: 9, sucCliffCmgr: 0, sucRecoveryCmgr: 0,
        sucDepositSharePct: 1, sucDepositSlabShares: { '1mo': 1 },
        sucNonDepositRate: 1.5
      },
      counts: [{ fiuId: 'FIU-DYNFLAG', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-DYNFLAG', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    assertEqual(row.sucDepositRateIsDynamic, true);
  });
});

suite('purposeCodeYieldBreakdown() — (license type x purpose code) yield (ask: 2026-10-26)', () => {
  // "give me the march 2027 yield for 105 purpose code for the FIUs that
  // have a stock broker license type... it was (license type x purpose
  // code) yield" — this attributes just the slice of a FIU's revenue/DF
  // volume tagged with one purpose code (from its fixed, DPU-report-
  // derived purposeCodeBreakdown — see scripts/recompute-deposit-rates.js),
  // grouped by an arbitrary FIU Metadata field (license type here).
  function multiRowFor(fiuDefs, opts) {
    const { asOf, fyStart, sucStart, scenarios, dfOptFactor } = opts;
    const metadataById = metaMap(fiuDefs.map(f => meta(f.fiuId, f.metaOver)));
    const yieldCmgrById = ycMap(fiuDefs.map(f => yc(f.fiuId, f.ycOver)));
    const counts = fiuDefs.map(f => f.counts || { fiuId: f.fiuId, activeUsers: '', dataFetches: 500000 });
    const hist = [];
    fiuDefs.forEach(f => (f.hist || []).forEach(h => hist.push(h)));
    const result = computeRevenue(
      counts, metadataById, yieldCmgrById,
      asOf || d(2026, 9, 9), fyStart || 4, sucStart || null,
      histMap(hist), scenarios || {}, dfOptFactor
    );
    return { result, yieldCmgrById };
  }

  test('attributes revenue/DF volume for just the selected purpose code, blending that code\'s own slab mix against the FIU\'s overall Deposit-volume tier', () => {
    const { result, yieldCmgrById } = multiRowFor([{
      fiuId: 'FIU-PCY1',
      metaOver: { billingModel: 'Data Fetch', licenseType: 'Stock Broker' },
      ycOver: {
        sucYield: 9, sucCliffCmgr: 0, sucRecoveryCmgr: 0,
        sucDepositSharePct: 0.5, sucDepositSlabShares: { '5d': 1 },
        sucNonDepositRate: 2,
        purposeCodeBreakdown: { '105': { sharePct: 0.4, depositSharePct: 0.5, slabShares: { '5d': 1 } } }
      },
      hist: [{ fiuId: 'FIU-PCY1', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }]
    }], { sucStart: { year: 2026, month: 10 } });

    const octIndex = 6;
    const sept = 1000000 * 1.05;
    const oct = sept * 1; // cliffCmgr 0 -> flat
    const codeDfVolume = oct * 0.4;
    const codeDepositVolume = codeDfVolume * 0.5;
    // FIU's total Deposit volume this month = oct x 0.5 = 525000 -> under
    // the 1,000,000 tier floor, so 0% discount -> 5d row stays at its
    // full ₹0.180 AA Fee.
    const codeDepositRevenue = codeDepositVolume * 0.180;
    const codeNonDepositRevenue = (codeDfVolume - codeDepositVolume) * 2; // sucNonDepositRate
    const expectedRevenue = codeDepositRevenue + codeNonDepositRevenue;

    const byLicense = purposeCodeYieldBreakdown(result.rows, yieldCmgrById, r => r.licenseType, octIndex, '105');
    const g = byLicense.find(x => x.label === 'Stock Broker');
    assert(g, 'Stock Broker group should be present');
    assertClose(g.dfCount, codeDfVolume, 1);
    assertClose(g.revenue, expectedRevenue, 1);
    assertClose(g.yield, expectedRevenue / codeDfVolume, 0.0001);
  });

  test('slabVolumes breaks the group\'s Deposit-type DF volume into DPU rate-card slabs, summing to the Deposit share of dfCount (not the whole dfCount) (ask: 2026-10-27, "add a column for each DPU in the DPI rate card and mention each DPU\'s contribution % to DF")', () => {
    const { result, yieldCmgrById } = multiRowFor([{
      fiuId: 'FIU-PCY-DPU',
      metaOver: { billingModel: 'Data Fetch', licenseType: 'Stock Broker' },
      ycOver: {
        sucYield: 9, sucCliffCmgr: 0, sucRecoveryCmgr: 0,
        sucDepositSharePct: 0.5, sucDepositSlabShares: { '5d': 1 },
        sucNonDepositRate: 2,
        // This code's own Deposit-type DF volume is split 30% into the
        // 7mo slab and 70% into the 5d slab — deliberately different from
        // the FIU's overall sucDepositSlabShares above, same as
        // depositSharePct/sharePct can differ per purpose code.
        purposeCodeBreakdown: { '105': { sharePct: 0.4, depositSharePct: 0.5, slabShares: { '7mo': 0.3, '5d': 0.7 } } }
      },
      hist: [{ fiuId: 'FIU-PCY-DPU', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }]
    }], { sucStart: { year: 2026, month: 10 } });

    const octIndex = 6;
    const sept = 1000000 * 1.05;
    const oct = sept * 1;
    const codeDfVolume = oct * 0.4;
    const codeDepositVolume = codeDfVolume * 0.5; // 50% Deposit — the other 50% is non-Deposit, no DPU breakdown

    const byLicense = purposeCodeYieldBreakdown(result.rows, yieldCmgrById, r => r.licenseType, octIndex, '105');
    const g = byLicense.find(x => x.label === 'Stock Broker');
    assert(g.slabVolumes, 'expected a slabVolumes object on the group');
    assertClose(g.slabVolumes['7mo'], codeDepositVolume * 0.3, 1);
    assertClose(g.slabVolumes['5d'], codeDepositVolume * 0.7, 1);
    assertEqual(g.slabVolumes['1mo'], undefined, 'a slab with no share for this code should not appear in slabVolumes at all');
    const slabSum = Object.values(g.slabVolumes).reduce((s, v) => s + v, 0);
    assertClose(slabSum, codeDepositVolume, 1, 'slabVolumes should sum to the group\'s Deposit-type DF volume');
    assert(slabSum < g.dfCount, 'slabVolumes should sum to LESS than the group\'s whole dfCount — the non-Deposit half has no DPU breakdown to contribute');
  });

  test('a FIU with no purposeCodeBreakdown entry for the selected code is excluded entirely, not zeroed', () => {
    const { result, yieldCmgrById } = multiRowFor([{
      fiuId: 'FIU-PCY-NOCODE',
      metaOver: { billingModel: 'Data Fetch', licenseType: 'Stock Broker' },
      ycOver: {
        sucYield: 9, sucCliffCmgr: 0, sucRecoveryCmgr: 0,
        sucDepositSharePct: 0.5, sucDepositSlabShares: { '5d': 1 },
        sucNonDepositRate: 2
        // no purposeCodeBreakdown at all
      },
      hist: [{ fiuId: 'FIU-PCY-NOCODE', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }]
    }], { sucStart: { year: 2026, month: 10 } });

    const byLicense = purposeCodeYieldBreakdown(result.rows, yieldCmgrById, r => r.licenseType, 6, '105');
    assertEqual(byLicense.length, 0, 'a FIU with no measured volume in this purpose code should not even appear as a 0-revenue group');
  });

  test('a pre-DPI-Pricing month (not yet sucActive) has no purpose-code attribution at all', () => {
    const { result, yieldCmgrById } = multiRowFor([{
      fiuId: 'FIU-PCY-PREDPI',
      metaOver: { billingModel: 'Data Fetch', licenseType: 'Stock Broker' },
      ycOver: {
        sucYield: 9, sucCliffCmgr: 0, sucRecoveryCmgr: 0,
        sucDepositSharePct: 0.5, sucDepositSlabShares: { '5d': 1 },
        sucNonDepositRate: 2,
        purposeCodeBreakdown: { '105': { sharePct: 0.4, depositSharePct: 0.5, slabShares: { '5d': 1 } } }
      },
      hist: [{ fiuId: 'FIU-PCY-PREDPI', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }]
    }], { sucStart: { year: 2026, month: 12 } }); // DPI Pricing doesn't start until December

    const sepIndex = 5; // Sept 2026 — before DPI Pricing starts
    const byLicense = purposeCodeYieldBreakdown(result.rows, yieldCmgrById, r => r.licenseType, sepIndex, '105');
    assertEqual(byLicense.length, 0, 'pre-DPI months have no FI-type/purpose-code attribution at all, so this purpose code contributes nothing yet');
  });

  test('two FIUs of the same license type sum (not average) into one blended group yield', () => {
    const def = (fiuId, dfCount) => ({
      fiuId,
      metaOver: { billingModel: 'Data Fetch', licenseType: 'Stock Broker' },
      ycOver: {
        sucYield: 9, sucCliffCmgr: 0, sucRecoveryCmgr: 0,
        sucDepositSharePct: 0.5, sucDepositSlabShares: { '5d': 1 },
        sucNonDepositRate: 2,
        purposeCodeBreakdown: { '105': { sharePct: 0.4, depositSharePct: 0.5, slabShares: { '5d': 1 } } }
      },
      hist: [{ fiuId, month: '2026-08', revenue: 100000, auCount: '', dfCount }]
    });
    const { result, yieldCmgrById } = multiRowFor(
      [def('FIU-PCY-A', 1000000), def('FIU-PCY-B', 2000000)],
      { sucStart: { year: 2026, month: 10 } }
    );
    const byLicense = purposeCodeYieldBreakdown(result.rows, yieldCmgrById, r => r.licenseType, 6, '105');
    const g = byLicense.find(x => x.label === 'Stock Broker');
    const octA = 1000000 * 1.05;
    const octB = 2000000 * 1.05;
    const codeDfA = octA * 0.4, codeDfB = octB * 0.4;
    assertClose(g.dfCount, codeDfA + codeDfB, 1, 'the group DF count is the sum across both FIUs, not an average');
  });
});

suite('Pure non-Deposit FIUs are indifferent to DPI Pricing (ask: 2026-10-20)', () => {
  // A FIU whose Data Fetch volume is 100% non-Deposit FI types has zero
  // exposure to the DPI Pricing Rate Card — only Deposit-type fetches are
  // ever billed off it (see the suite above) — so its real per-fetch cost
  // never actually rises once DPI Pricing starts. DPI Pricing Cliff and
  // Recovery CMGR, and both what-if scenarios below, all exist specifically
  // to model demand/revenue reacting to that price rise (a volume dip then
  // partial recovery, or a non-bank PFM FIU losing its revenue entirely);
  // modeling any of those reactions for a FIU that was never actually
  // charged more would be wrong. Such a FIU (sucDepositSharePct effectively
  // 0, including when unconfigured at all — see the previous suite's
  // default) keeps compounding at its regular pre-DPI CMGR straight through
  // the whole DPI Pricing period instead — not just during Cliff, since
  // there's no price rise for it to "recover" from either — and is left out
  // of both what-if scenarios regardless of Use-case/License Type.
  test('0% Deposit share: Cliff CMGR is ignored, regular CMGR applies instead', () => {
    const { row } = rowFor('FIU-PURENONDEP', {
      metaOver: { billingModel: 'Data Fetch' },
      ycOver: { yield: 1, cmgr: 0.05, sucYield: 9, sucCliffCmgr: -0.13, sucRecoveryCmgr: 0.02, sucDepositSharePct: 0, sucNonDepositRate: 1 },
      counts: [{ fiuId: 'FIU-PURENONDEP', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-PURENONDEP', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    const sepAnchor = 1000000 * 1.05;
    const octExpected = sepAnchor * 1.05; // regular CMGR, NOT the -13% Cliff CMGR
    assertClose(row.monthly[6].dfUsage, octExpected, 1, 'October (1st Cliff month) should use the regular 5% CMGR, not the -13% Cliff CMGR');
  });

  test('0% Deposit share: Recovery CMGR is also ignored, every month past Cliff', () => {
    const { row } = rowFor('FIU-PURENONDEP2', {
      metaOver: { billingModel: 'Data Fetch' },
      ycOver: { yield: 1, cmgr: 0.05, sucYield: 9, sucCliffCmgr: -0.13, sucRecoveryCmgr: 0.3, sucDepositSharePct: 0, sucNonDepositRate: 1 },
      counts: [{ fiuId: 'FIU-PURENONDEP2', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-PURENONDEP2', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    // Jan 2027 (month index 9) is into Recovery (sucStart=Oct, so Oct/Nov/
    // Dec are the 3-month Cliff and Jan is the 1st Recovery month) — still
    // the regular 5% CMGR every step (Sep, Oct, Nov, Dec, Jan = 5
    // compoundings from the Aug anchor), never switching to the -13%
    // Cliff or +30% Recovery rate.
    const expected = 1000000 * Math.pow(1.05, 5);
    assertClose(row.monthly[9].dfUsage, expected, 1, 'January should still be on the regular CMGR, never switching to Cliff or Recovery');
  });

  test('any nonzero Deposit share, even a small one, still uses Cliff/Recovery CMGR normally', () => {
    const { row } = rowFor('FIU-TINYDEP', {
      metaOver: { billingModel: 'Data Fetch' },
      ycOver: { yield: 1, cmgr: 0.05, sucYield: 9, sucCliffCmgr: -0.13, sucRecoveryCmgr: 0.02, sucDepositSharePct: 0.0001, sucDepositRate: 5, sucNonDepositRate: 1 },
      counts: [{ fiuId: 'FIU-TINYDEP', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-TINYDEP', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    const sepAnchor = 1000000 * 1.05;
    const octExpected = sepAnchor * 0.87; // its own -13% Cliff CMGR, not the regular 5%
    assertClose(row.monthly[6].dfUsage, octExpected, 1, 'even a 0.01% Deposit share is enough to keep the normal Cliff CMGR in effect');
  });

  test('the Lending DF volume -50% what-if scenario never applies to a pure non-Deposit FIU', () => {
    const { row } = rowFor('FIU-PURENONDEP-LEND', {
      metaOver: { billingModel: 'Data Fetch', useCase: 'Lending' },
      ycOver: { yield: 1, cmgr: 0.05, sucYield: 9, sucCliffCmgr: -0.13, sucRecoveryCmgr: 0.02, sucDepositSharePct: 0, sucNonDepositRate: 1 },
      counts: [{ fiuId: 'FIU-PURENONDEP-LEND', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-PURENONDEP-LEND', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 },
      scenarios: { lendingCmgrWorse: true }
    });
    const sepAnchor = 1000000 * 1.05;
    const octExpected = sepAnchor * 1.05; // still the regular CMGR, not the -20.63% "worse" override
    assertClose(row.monthly[6].dfUsage, octExpected, 1, 'a pure non-Deposit Lending FIU is indifferent to DPI pricing, so the "worse Cliff" scenario has nothing to make worse');
  });

  test('pureNonDepositFiu is reported on the row for a 0%-share FIU, and not for one with any share', () => {
    const { row: zeroShareRow } = rowFor('FIU-PUREFLAG0', {
      metaOver: { billingModel: 'Data Fetch' },
      ycOver: { sucYield: 9, sucCliffCmgr: 0, sucRecoveryCmgr: 0, sucDepositSharePct: 0, sucNonDepositRate: 1 },
      counts: [{ fiuId: 'FIU-PUREFLAG0', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-PUREFLAG0', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    assertEqual(zeroShareRow.pureNonDepositFiu, true);

    const { row: someShareRow } = rowFor('FIU-PUREFLAG1', {
      metaOver: { billingModel: 'Data Fetch' },
      ycOver: { sucYield: 9, sucCliffCmgr: 0, sucRecoveryCmgr: 0, sucDepositSharePct: 0.2, sucDepositRate: 5, sucNonDepositRate: 1 },
      counts: [{ fiuId: 'FIU-PUREFLAG1', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-PUREFLAG1', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    assertEqual(someShareRow.pureNonDepositFiu, false);
  });

  test('the non-bank PFM -> ₹0 what-if scenario never applies to a pure non-Deposit FIU', () => {
    const { row } = rowFor('FIU-PURENONDEP-PFM', {
      metaOver: { billingModel: 'Active Users', useCase: 'PFM', licenseType: 'NBFC' },
      ycOver: { yield: 1, cmgr: 0.05, sucYield: 5, sucCliffCmgr: -0.1, sucDepositSharePct: 0, sucNonDepositRate: 1 },
      counts: [{ fiuId: 'FIU-PURENONDEP-PFM', activeUsers: 1000, dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-PURENONDEP-PFM', month: '2026-08', revenue: 20000, auCount: 1000, dfCount: 4000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 },
      scenarios: { nonBankPfmZero: true }
    });
    assert(row.monthly[6].revenue > 0, 'a pure non-Deposit non-bank PFM FIU is indifferent to DPI Pricing, so the scenario should not force its revenue to 0');
  });
});

suite('PFM/non-Bank DF ÷6 cut persists across the whole SUC period', () => {
  // Fixed 2026-09-10 — the same anchor split that fixed the chart dip
  // above briefly broke this: the one-time ÷6 cut was applied to the
  // display value only, so the very next SUC month's compounding silently
  // resumed from the pre-cut figure. This test would have caught it (Nov's
  // dfUsage would come back 6x too high without the fix).
  test('cut applies once at the SUC switch, then all later SUC months keep compounding from the reduced baseline', () => {
    const { row } = rowFor('FIU-K', {
      metaOver: { billingModel: 'Active Users', useCase: 'PFM', licenseType: 'NBFC' },
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.13, sucRecoveryCmgr: 0.02 },
      counts: [{ fiuId: 'FIU-K', activeUsers: 30000, dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-K', month: '2026-08', revenue: 100000, auCount: 100000, dfCount: 4000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    const sepAnchor = 4000000 * 1.05;
    const octPreCut = sepAnchor * 0.87;
    const octCut = octPreCut / 6;                 // the one-time cut, at the SUC switch month
    const nov = octCut * 0.87;                     // must compound from the CUT figure, not octPreCut
    const dec = nov * 0.87;
    assertClose(row.monthly[6].dfUsage, octCut, 1, 'October: cut applied');
    assertClose(row.monthly[7].dfUsage, nov, 1, 'November: still reduced — this is the regression the 2026-09-10 fix targets');
    assertClose(row.monthly[8].dfUsage, dec, 1, 'December: still reduced');
    assert(row.monthly[8].dfUsage < octPreCut, 'sanity check: December must stay far below what an un-cut chain would show');
  });

  test('a Bank-licensed PFM FIU is NOT subject to the ÷6 cut', () => {
    const { row } = rowFor('FIU-L', {
      metaOver: { billingModel: 'Active Users', useCase: 'PFM', licenseType: 'Bank' },
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.13 },
      counts: [{ fiuId: 'FIU-L', activeUsers: 30000, dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-L', month: '2026-08', revenue: 100000, auCount: 100000, dfCount: 4000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 },
      // A Bank-licensed PFM FIU like this one IS subject to the separate
      // Bank-PFM Data Fetch Optimization factor added 2026-10-23 (see its
      // own suite below) — disabled here (0%) to keep this test isolated
      // to exactly what it's named for: the ÷6 non-Bank cut not applying.
      dfOptFactor: 0
    });
    const sepAnchor = 4000000 * 1.05;
    const oct = sepAnchor * 0.87;
    assertClose(row.monthly[6].dfUsage, oct, 1, 'Bank license -> no ÷6 cut, plain Cliff compounding only');
  });

  test('fiulive@dreamplug is cut BY 65% (retains 35%), not the general 1/6 (ask: 2026-10-24)', () => {
    const { row } = rowFor('FIULIVE@DREAMPLUG', {
      metaOver: { billingModel: 'Active Users', useCase: 'PFM', licenseType: 'RIA' },
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.13, sucRecoveryCmgr: 0.02 },
      counts: [{ fiuId: 'FIULIVE@DREAMPLUG', activeUsers: 30000, dataFetches: 500000 }],
      hist: [{ fiuId: 'FIULIVE@DREAMPLUG', month: '2026-08', revenue: 100000, auCount: 100000, dfCount: 4000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    const sepAnchor = 4000000 * 1.05;
    const octPreCut = sepAnchor * 0.87;
    const octCut = octPreCut * 0.35;                // dreamplug's override: retain 35% (cut by 65%), not 1/6
    const nov = octCut * 0.87;                      // must keep compounding from the overridden (35%) baseline
    assertClose(row.monthly[6].dfUsage, octCut, 1, 'October: cut by 65% (retain 35%), not the general 1/6');
    assertClose(row.monthly[7].dfUsage, nov, 1, 'November: still compounding from the 35%-retained baseline');
  });
});

suite('HDFC 43% cut (fiulive@hdfc / HDFC-FIU) — Unbilled but forced onto SUC', () => {
  test('Unbilled + forced SUC eligibility, 43% cut persists across later SUC months', () => {
    const { row } = rowFor('FIULIVE@HDFC', {
      metaOver: { billingModel: 'Unbilled' }, // would normally exclude this FIU from SUC entirely
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.1, sucRecoveryCmgr: 0.02 },
      counts: [{ fiuId: 'FIULIVE@HDFC', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIULIVE@HDFC', month: '2026-08', revenue: '', auCount: '', dfCount: 2000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    assertEqual(row.notBillable, true, 'Unbilled billing model is still excluded from the regular Yield x usage path');
    const sepAnchor = 2000000 * 1.05;
    const octPreCut = sepAnchor * 0.9;
    const octCut = octPreCut * 0.57; // cut by 43%
    const nov = octCut * 0.9;
    assertClose(row.monthly[6].dfUsage, octCut, 1, 'October: 43% cut applied despite Unbilled billing model');
    assertClose(row.monthly[7].dfUsage, nov, 1, 'November: still reflects the cut — must not silently revert');
    assertClose(row.monthly[6].revenue, octCut * 1, 1);
  });
});

suite('axisbank overrides (fiulive@axisbank)', () => {
  test('AU count fixed at 25,000/month from Sep 2026, pre-SUC', () => {
    const { row } = rowFor('FIULIVE@AXISBANK', {
      metaOver: { billingModel: 'Active Users' },
      counts: [{ fiuId: 'FIULIVE@AXISBANK', activeUsers: 999, dataFetches: '' }],
      hist: [{ fiuId: 'FIULIVE@AXISBANK', month: '2026-08', revenue: 50000, auCount: 40000, dfCount: '' }],
      asOf: d(2026, 9, 9)
    });
    assertClose(row.monthly[5].usage, 25000, 0.01, 'September (>= Sep 2026 override start): AU forced to 25,000, not the 999 uploaded');
    assertClose(row.monthly[6].usage, 25000, 0.01, 'October: override still applies (no SUC configured here)');
  });

  test('DF count during SUC fixed at 10% of the recorded July actual, flat every SUC month', () => {
    const { row } = rowFor('FIULIVE@AXISBANK', {
      metaOver: { billingModel: 'Active Users' },
      ycOver: { sucYield: 2, sucDepositSharePct: 1, sucDepositRate: 2, sucCliffCmgr: -0.1 },
      counts: [{ fiuId: 'FIULIVE@AXISBANK', activeUsers: 999, dataFetches: 123 }],
      hist: [
        { fiuId: 'FIULIVE@AXISBANK', month: '2026-07', revenue: '', auCount: '', dfCount: 1000000 },
        { fiuId: 'FIULIVE@AXISBANK', month: '2026-08', revenue: 50000, auCount: 40000, dfCount: '' }
      ],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    // 10% of July's 1,000,000 = 100,000, flat every SUC month — NOT compounded.
    assertClose(row.monthly[6].dfUsage, 100000, 0.01, 'October');
    assertClose(row.monthly[9].dfUsage, 100000, 0.01, 'January — still flat, not compounding');
    // Revenue checked in January, not October: fiulive@axisbank has a
    // separate, unconditional October-2026-only revenue override (ask:
    // 2026-10-23, "Change Axis revenue for October to 14,10,965") that
    // always wins regardless of this fixture's config — see the
    // "FIULIVE@AXISBANK: October 2026 revenue forced..." test below.
    assertClose(row.monthly[9].revenue, 100000 * 2, 0.01, 'January revenue = flat dfUsage x SUC Yield');
  });
});

suite('What-if scenario: Lending DF volume falls 50% during SUC Cliff', () => {
  test('exactly a 50% cumulative fall over the 3-month Cliff for a negative-CMGR Lending FIU', () => {
    const { row } = rowFor('FIU-LEND', {
      metaOver: { billingModel: 'Data Fetch', useCase: 'Lending' },
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.13, sucRecoveryCmgr: 0.02 },
      counts: [{ fiuId: 'FIU-LEND', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-LEND', month: '2026-08', revenue: 100000, auCount: '', dfCount: 4000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 },
      scenarios: { lendingCmgrWorse: true }
    });
    const sepAnchor = 4000000 * 1.05;
    const decExpected = sepAnchor * 0.5; // exactly half, 3 Cliff months later
    assertClose(row.monthly[8].dfUsage, decExpected, 1, 'December (3rd Cliff month) should be exactly 50% of the pre-Cliff anchor');
  });

  test('a Lending FIU with a zero/positive Cliff CMGR is left untouched', () => {
    const { row } = rowFor('FIU-LEND2', {
      metaOver: { billingModel: 'Data Fetch', useCase: 'Lending' },
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: 0.02, sucRecoveryCmgr: 0.02 },
      counts: [{ fiuId: 'FIU-LEND2', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-LEND2', month: '2026-08', revenue: 100000, auCount: '', dfCount: 4000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 },
      scenarios: { lendingCmgrWorse: true }
    });
    const sepAnchor = 4000000 * 1.05;
    const octExpected = sepAnchor * 1.02; // its own (positive) Cliff CMGR, not the -20.63% override
    assertClose(row.monthly[6].dfUsage, octExpected, 1);
  });

  test('a non-Lending FIU is never affected, even with a negative Cliff CMGR', () => {
    const { row } = rowFor('FIU-NONLEND', {
      // useCase deliberately not 'PFM'/'Lending' and licenseType not 'Bank'
      // — this test is only about the Lending-only scenario eligibility, so
      // it must stay clear of both the PFM/non-Bank 1/6 cut and the
      // Bank-PFM Data Fetch Optimization factor (default 20%), either of
      // which would also change this FIU's expected dfUsage for reasons
      // unrelated to what this test checks.
      metaOver: { billingModel: 'Data Fetch', useCase: 'RIA', licenseType: 'RIA' },
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.13 },
      counts: [{ fiuId: 'FIU-NONLEND', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-NONLEND', month: '2026-08', revenue: 100000, auCount: '', dfCount: 4000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 },
      scenarios: { lendingCmgrWorse: true }
    });
    const sepAnchor = 4000000 * 1.05;
    const octExpected = sepAnchor * 0.87; // its own -13%, not the -20.63% Lending override
    assertClose(row.monthly[6].dfUsage, octExpected, 1);
  });
});

suite('What-if scenario: non-bank PFM FIUs -> ₹0 post-SUC', () => {
  test('revenue forced to 0 for every SUC month, but dfUsage still shown normally', () => {
    const { row } = rowFor('FIU-PFM0', {
      metaOver: { billingModel: 'Active Users', useCase: 'PFM', licenseType: 'NBFC' },
      ycOver: { sucYield: 5, sucDepositSharePct: 1, sucDepositRate: 5, sucCliffCmgr: -0.1 },
      counts: [{ fiuId: 'FIU-PFM0', activeUsers: 1000, dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-PFM0', month: '2026-08', revenue: 20000, auCount: 1000, dfCount: 4000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 },
      scenarios: { nonBankPfmZero: true }
    });
    assertEqual(row.monthly[6].revenue, 0, 'revenue forced to 0');
    assertEqual(row.monthly[6].billable, true, 'still an explicit billed ₹0, not a missing/"—" figure');
    assert(row.monthly[6].dfUsage > 0, 'dfUsage keeps being computed/shown as normal');
  });
});

suite('Flat SUC-period revenue overrides (ICICI, SBI CARDS)', () => {
  // KMBL-FIU-PROD (PFM) used to be the third entry here, with a schedule
  // that stepped down from ₹13,79,669/month to ₹2,29,945/month at Jan 2027
  // — removed 2026-10-23 (ask: "replace it") once a real DPU-level fetch
  // count became available for it (see the new Historical Actuals entry
  // for it instead, and the "DPI period Deposit/non-Deposit rate split"
  // suite for its new sucDepositRate/sucDepositSharePct). The step-down
  // behavior itself was just a plain per-month-key lookup into the
  // schedule object — the same mechanism the "flat schedule applies" test
  // below already exercises (just with one amount throughout rather than
  // two different ones) — so no separate regression coverage is needed
  // for the lookup itself now that no real schedule uses more than one
  // amount.
  test('flat schedule applies while the current month\'s DF count is still 0/missing', () => {
    const { row } = rowFor('ICICI', {
      metaOver: { billingModel: 'Data Fetch', useCase: 'PFM' },
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.1 },
      counts: [{ fiuId: 'ICICI', activeUsers: '', dataFetches: '' }], // no live DF count yet
      hist: [],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    assertEqual(row.monthly[6].revenue, 51000, 'October — flat scheduled amount');
    assertEqual(row.monthly[8].revenue, 51000, 'December — still flat');
  });

  test('a real nonzero current-month DF count switches this FIU off the flat schedule for good', () => {
    const { row } = rowFor('ICICI', {
      metaOver: { billingModel: 'Data Fetch', useCase: 'PFM' },
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.1 },
      counts: [{ fiuId: 'ICICI', activeUsers: '', dataFetches: 200000 }], // real usage has started
      hist: [],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    assert(row.monthly[6].revenue !== 51000, 'once real DF volume shows up, the flat override must stop applying');
  });
});

suite('Fixed monthly-schedule/flat-until-SUC revenue overrides', () => {
  test('FIULIVE@CANARABANK: 0 every month except the Nov 2026 scheduled amount', () => {
    const { row } = rowFor('FIULIVE@CANARABANK', {
      counts: [{ fiuId: 'FIULIVE@CANARABANK', activeUsers: 5000, dataFetches: '' }],
      hist: [],
      asOf: d(2026, 9, 9)
    });
    assertEqual(row.monthly[6].revenue, 0, 'October — default 0');
    assertEqual(row.monthly[7].revenue, 350000, 'November — the one scheduled month');
    assertEqual(row.monthly[8].revenue, 0, 'December — back to default 0');
  });

  test('FIULIVE@MONEYCONTROL: flat until SUC starts, then falls through to normal computation', () => {
    const { row } = rowFor('FIULIVE@MONEYCONTROL', {
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.1 },
      counts: [{ fiuId: 'FIULIVE@MONEYCONTROL', activeUsers: '', dataFetches: 100000 }],
      metaOver: { billingModel: 'Data Fetch' },
      hist: [{ fiuId: 'FIULIVE@MONEYCONTROL', month: '2026-08', revenue: 999, auCount: '', dfCount: 900000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    assertEqual(row.monthly[5].revenue, 160000, 'September (pre-SUC) — flat 160,000 regardless of live usage');
    assert(row.monthly[6].revenue !== 160000, 'October (SUC-active) — falls through to the normal SUC computation, no longer flat');
  });

  test('FIULIVE@NUINVESTORS: usage/dfUsage/revenue all zeroed from November 2026 onward (churned, ask: 2026-10-24)', () => {
    const { row } = rowFor('FIULIVE@NUINVESTORS', {
      metaOver: { billingModel: 'Unique Users' },
      counts: [{ fiuId: 'FIULIVE@NUINVESTORS', activeUsers: 35285, dataFetches: 2722200 }],
      hist: [{ fiuId: 'FIULIVE@NUINVESTORS', month: '2026-09', revenue: 689120, auCount: 34456, dfCount: 3580574 }],
      asOf: d(2026, 10, 24)
    });
    assertEqual(row.monthly[5].revenue, 689120, 'September — real recorded actual, untouched by the override');
    assertEqual(row.monthly[6].usage, 35285, 'October (current month) — real live upload, untouched by the override');
    assertEqual(row.monthly[7].usage, 0, 'November — usage zeroed');
    assertEqual(row.monthly[7].dfUsage, 0, 'November — dfUsage zeroed too, not just the billed usage metric');
    assertEqual(row.monthly[7].revenue, 0, 'November — revenue zeroed');
    assert(row.monthly[7].billable, 'November — an explicit ₹0, not a "no data"/"missing config" badge');
    assertEqual(row.monthly[11].revenue, 0, 'March — still zeroed; the override has no end date');
  });

  test('FIULIVE@DREAMPLUG: flat 13,33,000 pre-DPI, falls through once DPI Pricing starts (ask: 2026-10-23)', () => {
    const { row } = rowFor('FIULIVE@DREAMPLUG', {
      metaOver: { billingModel: 'Active Users', useCase: 'PFM', licenseType: 'RIA' },
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.13 },
      counts: [{ fiuId: 'FIULIVE@DREAMPLUG', activeUsers: 30000, dataFetches: 500000 }],
      hist: [{ fiuId: 'FIULIVE@DREAMPLUG', month: '2026-08', revenue: 999, auCount: 100000, dfCount: 4000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    assertEqual(row.monthly[5].revenue, 1333000, 'September (pre-DPI) — flat 13,33,000 regardless of live usage');
    assert(row.monthly[6].revenue !== 1333000, 'October (DPI-active) — falls through to the normal SUC computation, no longer flat');
  });

  test('FIULIVE@DREAMPLUG: no DPI Pricing Start Date set at all — flat 13,33,000 for every month of the FY', () => {
    const { row } = rowFor('FIULIVE@DREAMPLUG', {
      metaOver: { billingModel: 'Active Users', useCase: 'PFM', licenseType: 'RIA' },
      counts: [{ fiuId: 'FIULIVE@DREAMPLUG', activeUsers: 30000, dataFetches: 500000 }],
      hist: [],
      asOf: d(2026, 9, 9)
      // sucStart omitted -> null, matching the live app's current "None" DPI Pricing Start Date
    });
    assertEqual(row.monthly[5].revenue, 1333000, 'September');
    assertEqual(row.monthly[11].revenue, 1333000, 'March — the override has no end date without a DPI Pricing Start Date');
  });

  test('FIULIVE@AXISBANK: October 2026 revenue forced to 14,10,965; every other month keeps its own normal computation (ask: 2026-10-23)', () => {
    const { row } = rowFor('FIULIVE@AXISBANK', {
      metaOver: { billingModel: 'Active Users' },
      counts: [{ fiuId: 'FIULIVE@AXISBANK', activeUsers: 999, dataFetches: '' }],
      hist: [{ fiuId: 'FIULIVE@AXISBANK', month: '2026-08', revenue: 50000, auCount: 40000, dfCount: '' }],
      asOf: d(2026, 9, 9)
    });
    assertEqual(row.monthly[6].revenue, 1410965, 'October — forced to the new figure, overriding what the AU override alone would give (25,000 x Yield 1 = 25,000)');
    assertClose(row.monthly[7].usage, 25000, 0.01, 'November — AU override still in effect (sanity check)');
    assertClose(row.monthly[7].revenue, 25000, 0.01, 'November — untouched by the October-only override, computes normally (25,000 x Yield 1)');
  });
});

suite('Bank-license PFM Data Fetch Optimization factor (ask: 2026-10-23)', () => {
  test('default 20% cut applies once at the DPI Pricing switch, then later months compound from the reduced baseline', () => {
    const { row } = rowFor('FIU-BANKPFM', {
      metaOver: { billingModel: 'Active Users', useCase: 'PFM', licenseType: 'Bank' },
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.13, sucRecoveryCmgr: 0.02 },
      counts: [{ fiuId: 'FIU-BANKPFM', activeUsers: 30000, dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-BANKPFM', month: '2026-08', revenue: 100000, auCount: 100000, dfCount: 4000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    const sepAnchor = 4000000 * 1.05;
    const octPreCut = sepAnchor * 0.87;
    const octCut = octPreCut * 0.8; // default factor: retain 80% (cut 20%)
    const nov = octCut * 0.87;
    assertClose(row.monthly[6].dfUsage, octCut, 1, 'October: 20% cut applied (default factor)');
    assertClose(row.monthly[7].dfUsage, nov, 1, 'November: still reduced — must keep compounding from the cut baseline, not revert');
  });

  test('pre-DPI months are completely unaffected by the factor', () => {
    const { row } = rowFor('FIU-BANKPFM2', {
      metaOver: { billingModel: 'Data Fetch', useCase: 'PFM', licenseType: 'Bank' },
      counts: [{ fiuId: 'FIU-BANKPFM2', activeUsers: '', dataFetches: 500000 }],
      hist: [],
      asOf: d(2026, 9, 9)
      // no sucStart -> no DPI Pricing at all this compute
    });
    const expectedDf = projectMonthToDate(500000, d(2026, 9, 9));
    assertClose(row.monthly[5].dfUsage, expectedDf, 1, 'September (current month, no DPI Pricing) — plain MTD projection, no cut');
  });

  test('a custom factor value (e.g. 50%) overrides the 20% default', () => {
    const { row } = rowFor('FIU-BANKPFM3', {
      metaOver: { billingModel: 'Active Users', useCase: 'PFM', licenseType: 'Bank' },
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.13 },
      counts: [{ fiuId: 'FIU-BANKPFM3', activeUsers: 30000, dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-BANKPFM3', month: '2026-08', revenue: 100000, auCount: 100000, dfCount: 4000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 },
      dfOptFactor: 0.5
    });
    const sepAnchor = 4000000 * 1.05;
    const octPreCut = sepAnchor * 0.87;
    const octCut = octPreCut * 0.5; // custom factor: retain 50% (cut 50%)
    assertClose(row.monthly[6].dfUsage, octCut, 1, 'October: custom 50% factor applied instead of the 20% default');
  });

  test('a non-Bank PFM FIU is not subject to this cut — only the pre-existing 1/6 non-Bank cut applies to it', () => {
    const { row } = rowFor('FIU-NONBANKPFM', {
      metaOver: { billingModel: 'Active Users', useCase: 'PFM', licenseType: 'NBFC' },
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.13 },
      counts: [{ fiuId: 'FIU-NONBANKPFM', activeUsers: 30000, dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-NONBANKPFM', month: '2026-08', revenue: 100000, auCount: 100000, dfCount: 4000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    const sepAnchor = 4000000 * 1.05;
    const octPreCut = sepAnchor * 0.87;
    const octCut = octPreCut / 6; // the existing PFM/non-Bank cut, NOT the new 20% Bank factor
    assertClose(row.monthly[6].dfUsage, octCut, 1, 'October: only the pre-existing 1/6 non-Bank cut applies');
  });

  test('fiulive@axisbank, tagged PFM+Bank (matching production), has the factor baked into its hardcoded 10%-of-July DF figure, flat every DPI Pricing month', () => {
    const { row } = rowFor('FIULIVE@AXISBANK', {
      metaOver: { billingModel: 'Active Users', useCase: 'PFM', licenseType: 'Bank' },
      ycOver: { sucYield: 2, sucDepositSharePct: 1, sucDepositRate: 2, sucCliffCmgr: -0.1 },
      counts: [{ fiuId: 'FIULIVE@AXISBANK', activeUsers: 999, dataFetches: 123 }],
      hist: [
        { fiuId: 'FIULIVE@AXISBANK', month: '2026-07', revenue: '', auCount: '', dfCount: 1000000 },
        { fiuId: 'FIULIVE@AXISBANK', month: '2026-08', revenue: 50000, auCount: 40000, dfCount: '' }
      ],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    // 10% of July's 1,000,000 = 100,000, then the default 20% factor cuts it to 80,000 — flat every
    // DPI Pricing month (it's a hardcoded figure, not a compounding chain), not compounding further.
    assertClose(row.monthly[6].dfUsage, 80000, 0.01, 'October');
    assertClose(row.monthly[9].dfUsage, 80000, 0.01, 'January — still flat at the reduced figure, not compounding');
    // Revenue checked in January, not October — see the comment on the same
    // pattern in the "DF count during SUC fixed at 10%..." test above:
    // October's revenue is always overridden to a separate fixed figure.
    assertClose(row.monthly[9].revenue, 80000 * 2, 0.01, 'January revenue = flat (already-reduced) dfUsage x SUC Yield');
  });

  test('fiulive@axisbank with a custom factor (e.g. 50%) applied to its hardcoded DF figure', () => {
    const { row } = rowFor('FIULIVE@AXISBANK', {
      metaOver: { billingModel: 'Active Users', useCase: 'PFM', licenseType: 'Bank' },
      ycOver: { sucYield: 2, sucDepositSharePct: 1, sucDepositRate: 2, sucCliffCmgr: -0.1 },
      counts: [{ fiuId: 'FIULIVE@AXISBANK', activeUsers: 999, dataFetches: 123 }],
      hist: [
        { fiuId: 'FIULIVE@AXISBANK', month: '2026-07', revenue: '', auCount: '', dfCount: 1000000 },
        { fiuId: 'FIULIVE@AXISBANK', month: '2026-08', revenue: 50000, auCount: 40000, dfCount: '' }
      ],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 },
      dfOptFactor: 0.5
    });
    assertClose(row.monthly[6].dfUsage, 50000, 0.01, 'October: 10% of July (100,000) cut by a custom 50% factor = 50,000');
  });

  test('the existing axisbank DF-SUC test fixture (no useCase/licenseType set) is unaffected — eligibility is a real metadata match, not just being axisbank', () => {
    const { row } = rowFor('FIULIVE@AXISBANK', {
      metaOver: { billingModel: 'Active Users' }, // no useCase/licenseType -> not eligible for the new factor
      ycOver: { sucYield: 2, sucDepositSharePct: 1, sucDepositRate: 2, sucCliffCmgr: -0.1 },
      counts: [{ fiuId: 'FIULIVE@AXISBANK', activeUsers: 999, dataFetches: 123 }],
      hist: [
        { fiuId: 'FIULIVE@AXISBANK', month: '2026-07', revenue: '', auCount: '', dfCount: 1000000 },
        { fiuId: 'FIULIVE@AXISBANK', month: '2026-08', revenue: 50000, auCount: 40000, dfCount: '' }
      ],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    assertClose(row.monthly[6].dfUsage, 100000, 0.01, 'October: plain 10% of July, no Bank-PFM factor baked in without a matching useCase/licenseType');
  });

  test('fiulive@hdfc: the new factor applies ON TOP of the existing 43% cut (hdfc is PFM+Bank in production)', () => {
    const { row } = rowFor('FIULIVE@HDFC', {
      metaOver: { billingModel: 'Unbilled', useCase: 'PFM', licenseType: 'Bank' },
      ycOver: { sucYield: 1, sucDepositSharePct: 1, sucDepositRate: 1, sucCliffCmgr: -0.1, sucRecoveryCmgr: 0.02 },
      counts: [{ fiuId: 'FIULIVE@HDFC', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIULIVE@HDFC', month: '2026-08', revenue: '', auCount: '', dfCount: 2000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    const sepAnchor = 2000000 * 1.05;
    const octPreCut = sepAnchor * 0.9;
    const oct43Cut = octPreCut * 0.57;   // existing HDFC 43% cut, applied first
    const octFinal = oct43Cut * 0.8;     // then the new default 20% Bank-PFM factor, on top
    assertClose(row.monthly[6].dfUsage, octFinal, 1, 'October: 43% cut, then the 20% Bank-PFM factor on top of that');
  });
});

suite('Duplicate FIU ID within one counts upload', () => {
  test('only the first occurrence is used; the rest are reported, not double-counted', () => {
    const metadataById = metaMap([meta('DUP-FIU')]);
    const yieldCmgrById = ycMap([yc('DUP-FIU')]);
    const result = computeRevenue(
      [
        { fiuId: 'DUP-FIU', activeUsers: 1000, dataFetches: '' },
        { fiuId: 'DUP-FIU', activeUsers: 999999, dataFetches: '' } // a duplicate row further down the file
      ],
      metadataById, yieldCmgrById, d(2026, 9, 9), 4, null, new Map(), {}
    );
    assertEqual(result.duplicateCounts.length, 1);
    assertEqual(result.duplicateCounts[0], 'DUP-FIU');
    const row = result.rows.find(r => r.fiuId === 'DUP-FIU');
    assertClose(row.monthly[5].usage, 1000, 0.01, 'the second (duplicate) row must never win');
  });
});

suite('buildActualsByMonth — the "Actual" series behind the Projected vs Actual chart', () => {
  test('sums revenue per month across metadata-matched FIUs only', () => {
    const metadataById = metaMap([meta('AC-FIU-1'), meta('AC-FIU-2')]);
    const hist = histMap([
      { fiuId: 'AC-FIU-1', month: '2026-07', revenue: 1000, auCount: '', dfCount: '' },
      { fiuId: 'AC-FIU-2', month: '2026-07', revenue: 2000, auCount: '', dfCount: '' },
      { fiuId: 'NOT-IN-CONFIG', month: '2026-07', revenue: 99999, auCount: '', dfCount: '' } // unmatched, must be excluded
    ]);
    const months = fyFullMonths(d(2026, 9, 9), 4);
    const totals = buildActualsByMonth(months, hist, metadataById);
    assertClose(totals[3], 3000, 0.01, 'July = 1000 + 2000, NOT-IN-CONFIG excluded');
  });
  test('a month with no historical rows at all is null, not 0', () => {
    const metadataById = metaMap([meta('AC-FIU-1')]);
    const months = fyFullMonths(d(2026, 9, 9), 4);
    const totals = buildActualsByMonth(months, new Map(), metadataById);
    assertEqual(totals[3], null);
  });
  test('a month with rows but no usable revenue value sums to 0, not null', () => {
    const metadataById = metaMap([meta('AC-FIU-1')]);
    const hist = histMap([{ fiuId: 'AC-FIU-1', month: '2026-07', revenue: '', auCount: 500, dfCount: '' }]);
    const months = fyFullMonths(d(2026, 9, 9), 4);
    const totals = buildActualsByMonth(months, hist, metadataById);
    assertEqual(totals[3], 0);
  });
});

suite('toNumber', () => {
  test('strips currency symbols, commas, percent signs, whitespace', () => {
    assertClose(toNumber('₹1,23,456.50'), 123456.5);
    assertClose(toNumber(' 12% '), 12);
    assertClose(toNumber('$1,000'), 1000);
  });
  test('blank/undefined/null/unparseable -> NaN', () => {
    assertNaN(toNumber(''));
    assertNaN(toNumber(undefined));
    assertNaN(toNumber(null));
    assertNaN(toNumber('not a number'));
  });
  test('a real number passes through unchanged', () => {
    assertClose(toNumber(42.5), 42.5);
  });
});

// Suites above already ran (registering their pass/fail with the shared
// harness) as a side effect of this file being loaded. When run directly
// (`node test/compute.test.js`), print this file's own tally and exit
// accordingly; when required from test/run.js alongside server.test.js,
// leave the summary/exit to run.js so the two files share one combined
// tally instead of each reporting (and potentially exiting on) their own.
if (require.main === module) {
  const { summary } = require('./harness');
  const { failed } = summary('compute.test.js');
  process.exit(failed ? 1 : 0);
}
