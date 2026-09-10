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
  buildActualsByMonth, toNumber
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
    metaOver, ycOver, counts, hist, asOf, fyStart, sucStart, scenarios
  } = opts;
  const metadataById = metaMap([meta(fiuId, metaOver)]);
  const yieldCmgrById = ycMap([yc(fiuId, ycOver)]);
  const result = computeRevenue(
    counts || [{ fiuId, activeUsers: 1000, dataFetches: '' }],
    metadataById, yieldCmgrById,
    asOf || d(2026, 9, 9), fyStart || 4, sucStart || null,
    hist ? histMap(hist) : new Map(),
    scenarios || {}
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
      ycOver: { sucYield: 1, sucCliffCmgr: -0.13, sucRecoveryCmgr: 0.02 },
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
      ycOver: { cmgr: 0.03, sucYield: 1, sucCliffCmgr: -0.1 /* sucRecoveryCmgr omitted */ },
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
      ycOver: { sucYield: 1 /* no sucCliffCmgr */ },
      counts: [{ fiuId: 'FIU-J', activeUsers: '', dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-J', month: '2026-08', revenue: 100000, auCount: '', dfCount: 1000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    assertEqual(row.monthly[6].sucActive, false, 'missing SUC Cliff CMGR should leave this FIU on its regular CMGR/Yield entirely');
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
      ycOver: { sucYield: 1, sucCliffCmgr: -0.13, sucRecoveryCmgr: 0.02 },
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
      ycOver: { sucYield: 1, sucCliffCmgr: -0.13 },
      counts: [{ fiuId: 'FIU-L', activeUsers: 30000, dataFetches: 500000 }],
      hist: [{ fiuId: 'FIU-L', month: '2026-08', revenue: 100000, auCount: 100000, dfCount: 4000000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    const sepAnchor = 4000000 * 1.05;
    const oct = sepAnchor * 0.87;
    assertClose(row.monthly[6].dfUsage, oct, 1, 'Bank license -> no ÷6 cut, plain Cliff compounding only');
  });
});

suite('HDFC 43% cut (fiulive@hdfc / HDFC-FIU) — Unbilled but forced onto SUC', () => {
  test('Unbilled + forced SUC eligibility, 43% cut persists across later SUC months', () => {
    const { row } = rowFor('FIULIVE@HDFC', {
      metaOver: { billingModel: 'Unbilled' }, // would normally exclude this FIU from SUC entirely
      ycOver: { sucYield: 1, sucCliffCmgr: -0.1, sucRecoveryCmgr: 0.02 },
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
      ycOver: { sucYield: 2, sucCliffCmgr: -0.1 },
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
    assertClose(row.monthly[6].revenue, 100000 * 2, 0.01, 'revenue = flat dfUsage x SUC Yield');
  });
});

suite('What-if scenario: Lending DF volume falls 50% during SUC Cliff', () => {
  test('exactly a 50% cumulative fall over the 3-month Cliff for a negative-CMGR Lending FIU', () => {
    const { row } = rowFor('FIU-LEND', {
      metaOver: { billingModel: 'Data Fetch', useCase: 'Lending' },
      ycOver: { sucYield: 1, sucCliffCmgr: -0.13, sucRecoveryCmgr: 0.02 },
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
      ycOver: { sucYield: 1, sucCliffCmgr: 0.02, sucRecoveryCmgr: 0.02 },
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
      metaOver: { billingModel: 'Data Fetch', useCase: 'PFM', licenseType: 'Bank' },
      ycOver: { sucYield: 1, sucCliffCmgr: -0.13 },
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
      ycOver: { sucYield: 5, sucCliffCmgr: -0.1 },
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

suite('Flat SUC-period revenue overrides (ICICI, SBI CARDS, KMBL-FIU-PROD (PFM))', () => {
  test('flat schedule applies while the current month\'s DF count is still 0/missing', () => {
    const { row } = rowFor('ICICI', {
      metaOver: { billingModel: 'Data Fetch', useCase: 'PFM' },
      ycOver: { sucYield: 1, sucCliffCmgr: -0.1 },
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
      ycOver: { sucYield: 1, sucCliffCmgr: -0.1 },
      counts: [{ fiuId: 'ICICI', activeUsers: '', dataFetches: 200000 }], // real usage has started
      hist: [],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    assert(row.monthly[6].revenue !== 51000, 'once real DF volume shows up, the flat override must stop applying');
  });

  test('KMBL-FIU-PROD (PFM) steps down from Jan 2027', () => {
    const { row } = rowFor('KMBL-FIU-PROD (PFM)', {
      metaOver: { billingModel: 'Data Fetch', useCase: 'PFM' },
      ycOver: { sucYield: 1, sucCliffCmgr: -0.1 },
      counts: [{ fiuId: 'KMBL-FIU-PROD (PFM)', activeUsers: '', dataFetches: '' }],
      hist: [],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    assertEqual(row.monthly[8].revenue, 1379669, 'December — first tier');
    assertEqual(row.monthly[9].revenue, 229945, 'January — stepped down');
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
      ycOver: { sucYield: 1, sucCliffCmgr: -0.1 },
      counts: [{ fiuId: 'FIULIVE@MONEYCONTROL', activeUsers: '', dataFetches: 100000 }],
      metaOver: { billingModel: 'Data Fetch' },
      hist: [{ fiuId: 'FIULIVE@MONEYCONTROL', month: '2026-08', revenue: 999, auCount: '', dfCount: 900000 }],
      asOf: d(2026, 9, 9),
      sucStart: { year: 2026, month: 10 }
    });
    assertEqual(row.monthly[5].revenue, 160000, 'September (pre-SUC) — flat 160,000 regardless of live usage');
    assert(row.monthly[6].revenue !== 160000, 'October (SUC-active) — falls through to the normal SUC computation, no longer flat');
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
