#!/usr/bin/env node
// Recomputes sucDepositSlabShares (and sucDepositSharePct) in
// data/yield-cmgr.json from a real DPU SNA report (FIU x purpose_code x
// dpu_slab x fi_type, with fi_requests/successful_fetches columns — see the
// "Read Me" sheet of the report itself for exact column definitions).
//
// Usage:
//   node scripts/recompute-deposit-rates.js <dpu-report.xlsx>
//
// Writes the updated data/yield-cmgr.json in place (back up first if you
// want to diff/revert). Prints a summary of how many FIUs were updated,
// zeroed out (present in the report but with no Deposit-type volume), or
// left untouched (absent from the report).
//
// Methodology (ask: 2026-10-26, derived from a real September 2026 DPU SNA
// report, "dpu_sna_report_account_level_2026-09-01_2026-09-30.xlsx", and
// the Finfactor DPI Utility Rate Card screenshot shared 2026-10-26, as
// corrected by the ask of 2026-10-26 — "apply the tier discount based on
// the FIU's projected data fetch count for deposit FI type for each month.
// Do not simply apply discount based on September volumes."):
//
// 1. "Deposit FI Type" = the report's fi_type column values DEPOSIT,
//    TERM_DEPOSIT, RECURRING_DEPOSIT (and the TERM-DEPOSIT dash variant,
//    a one-off typo seen in the Sep 2026 report, folded in) — same
//    definition already used elsewhere in this app (savings/current/RD/
//    term-deposit/sole-proprietorship accounts).
// 2. Per FIU, per dpu_slab, sum successful_fetches across those Deposit
//    fi_types — this gives that FIU's own September distribution across
//    the 8 rate-card rows (13mo/7mo/4mo/1mo/1w/5d/1d/ps). A dpu_slab value
//    with no rate-card row (e.g. unknown_range) is excluded.
// 3. sucDepositSlabShares = that per-slab distribution expressed as
//    FRACTIONS OF THE FIU'S TOTAL DEPOSIT VOLUME (each slab's count ÷ the
//    FIU's total Deposit successful_fetches). This mix — unlike the
//    discount tier below — is held FIXED going forward at whatever this
//    report measured, since the regular monthly counts upload has no
//    DPU-slab breakdown to re-measure it from each month.
// 4. sucDepositSharePct = (that FIU's total Deposit successful_fetches) /
//    (its total successful_fetches across the fi_type='ALL' rows, which
//    the report's own Read Me says to use "for totals" since it counts
//    each session once regardless of how many FI types it touched).
//    Clamped to a maximum of 1.0 — a session touching more than one
//    Deposit-type sub-type (e.g. both DEPOSIT and TERM_DEPOSIT) is counted
//    in each of those fi_type-specific rows per the report's own documented
//    behavior ("a session with two FI types is in two rows, so these rows
//    do not add up"), which can push the raw Deposit sum very slightly
//    above the deduped ALL total for a FIU with many such sessions — this
//    affected 39 of 552 FIUs in the Sep 2026 report, nearly all by a few
//    percent, worst case ~17%. Clamping is the only sound fix without
//    session-level raw data.
// 5. IMPORTANT — what moved vs. patch 45: this script no longer bakes a
//    single ₹/fetch sucDepositRate out of the report + rate card. The
//    volume discount tier (<1,000,000 fetches/month = 0%, 1,000,000-
//    4,999,999 = 10%, 5,000,000-9,999,999 = 15%, >=10,000,000 = 20%) now
//    depends on each DPI-period MONTH's own projected Deposit-type Data
//    Fetch volume, which this script has no visibility into (that's a
//    runtime, per-month quantity computed in lib/compute.js from dfUsage ×
//    sucDepositSharePct). So the per-slab AA Fee lookup, the tier-discount
//    function, and the final blended-rate computation all now live in
//    lib/compute.js (SUC_DEPOSIT_RATE_CARD / sucDepositTierDiscount() /
//    sucDepositRateForMonth()) and run fresh every month. This script's
//    job is only to produce each FIU's fixed sucDepositSlabShares mix (the
//    thing the real monthly counts upload can never give us) — the mix
//    itself doesn't depend on volume, only on which slabs this FIU's
//    sessions actually fall into.
//    A FIU's existing static sucDepositRate field (if any, from a previous
//    run of this script before this rewrite, or set by hand) is left on
//    file untouched as a fallback for any FIU this report has no data for
//    — lib/compute.js prefers sucDepositSlabShares when present and only
//    reads sucDepositRate if it's absent.
//
// sucNonDepositRate is completely untouched by this script — non-Deposit
// FI types keep billing at each FIU's own realized historical rate exactly
// as before (ask: "replace Deposit type rates only while calculating
// revenue for other FI types at pre-DPI rates").
//
// KMBL-FIU-PROD shared-ID handling (ask: 2026-10-26 — "For KMBL, consider
// fetches for purpose codes 101 and 102 as PFM and for 103 and 104 as
// Lending"): Kotak Mahindra Bank has two business lines on file under
// related IDs — KMBL-FIU-PROD (Lending) and KMBL-FIU-PROD (PFM)` — but the
// real DPU SNA report only has ONE shared ID (KMBL-FIU-PROD) covering both
// lines combined, broken down by purpose_code. Patch 45 excluded both
// entities entirely to avoid re-merging them; this version instead splits
// KMBL-FIU-PROD's own report rows by purpose_code before aggregating:
// purpose_code 101 and 102 go toward `KMBL-FIU-PROD (PFM)`'s slab mix, and
// 103 and 104 go toward `KMBL-FIU-PROD`'s (Lending's) own slab mix. Both
// KMBL lines keep their established 100%-Deposit-share convention
// (sucDepositSharePct = 1) — the user's correction addressed the slab-mix
// derivation, not that convention — so sucDepositSharePct for both is set
// directly to 1 rather than computed from an ALL-type total (KMBL's
// combined ALL-type row can't be split by business line anyway). For the
// SAME reason (both lines are modeled as 100% Deposit regardless of each
// session's literal fi_type tag), their slab mix is built from the
// fi_type='ALL' rows (deduplicated per-session totals), NOT from rows
// literally tagged DEPOSIT/TERM_DEPOSIT/etc. — KMBL's own report rows
// split fi_type into ALL/DEPOSIT/EQUITIES/ETF/UNKNOWN, and only a minority
// of its sessions are literally tagged DEPOSIT, but the business
// convention established before this script (and unchanged by this ask)
// is to treat KMBL's full volume as Deposit-type for billing purposes.
// This is the one deliberate exception to step 2 above, which otherwise
// always sums literal Deposit-type rows for every other FIU.
//
// purposeCodeBreakdown (ask: 2026-10-26 — "(license type x purpose code)
// yield" for Stock Broker FIUs, purpose code 105, used to power a new
// "By License Type x Purpose Code" view in DF Yield Analysis — see
// purposeCodeYieldBreakdown() in lib/compute.js): in addition to each
// FIU's overall sucDepositSlabShares/sucDepositSharePct above, this script
// also writes a per-purpose-code breakdown,
// `purposeCodeBreakdown: { "<code>": { sharePct, depositSharePct,
// slabShares } }`, for every purpose_code this FIU has nonzero volume in.
// `sharePct` = that code's share of the FIU's total ALL-type volume (so
// shares across all of a FIU's codes sum to ~1); `depositSharePct` = that
// code's own Deposit-type share WITHIN that code (can differ from the
// FIU's overall sucDepositSharePct — a FIU can run a different FI-type mix
// on one purpose code than another); `slabShares` = that code's own
// per-slab mix, same shape and convention as sucDepositSlabShares. Same
// KMBL exception as above: both KMBL lines use fi_type='ALL' rows (not
// literal Deposit-type rows) for both the "total" and "deposit" side of
// this, consistent with their 100%-Deposit convention, and only
// purpose_code 101/102 (PFM) or 103/104 (Lending) ever populate each
// line's own purposeCodeBreakdown (a code that can't be classified to a
// line never reaches either). lib/compute.js only ever reads a specific
// purposeCodeBreakdown[code] on demand (when that code is selected in the
// UI) — a FIU with no volume in the selected code is simply excluded from
// that slice's aggregate, the same graceful-skip approach used elsewhere
// in this app for a FIU missing some piece of config.

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DEPOSIT_TYPES = new Set(['DEPOSIT', 'TERM_DEPOSIT', 'RECURRING_DEPOSIT', 'TERM-DEPOSIT']);
const KNOWN_SLABS = new Set(['13mo', '7mo', '4mo', '1mo', '1w', '5d', '1d', 'ps']);

const KMBL_FIU_ID = 'KMBL-FIU-PROD';
const KMBL_PURPOSE_CODE_SPLIT = {
  PFM: new Set(['101', '102']),
  LENDING: new Set(['103', '104'])
};
const KMBL_KEYS = {
  PFM: normId('KMBL-FIU-PROD (PFM)'),
  LENDING: normId('KMBL-FIU-PROD')
};

function normId(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

function slabSharesFromCounts(slabCounts) {
  const total = Array.from(slabCounts.values()).reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const shares = {};
  for (const [slab, n] of slabCounts) {
    if (n <= 0) continue;
    shares[slab] = Math.round((n / total) * 1e6) / 1e6;
  }
  return shares;
}

function main() {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error('Usage: node scripts/recompute-deposit-rates.js <dpu-report.xlsx>');
    process.exit(1);
  }
  const ycPath = path.join(__dirname, '..', 'data', 'yield-cmgr.json');
  const yc = JSON.parse(fs.readFileSync(ycPath, 'utf8'));
  const ycByKey = new Map(yc.map(r => [normId(r.fiuId), r]));

  const wb = XLSX.read(fs.readFileSync(reportPath), { type: 'buffer' });
  const sheetName = wb.SheetNames.find(n => /dpu report/i.test(n)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });

  const byFiuAll = new Map();              // key -> total ALL successful_fetches
  const byFiuSlabDeposit = new Map();      // key -> Map(slab -> deposit successful_fetches)

  // KMBL-FIU-PROD's own rows get split by purpose_code into two synthetic
  // per-line buckets instead of folding into byFiuSlabDeposit/byFiuAll
  // under its own real ID.
  const kmblSlabDeposit = { PFM: new Map(), LENDING: new Map() };

  // Finer-grained, per-purpose-code aggregation (see purposeCodeBreakdown
  // in the header comment) — keyed by the SAME effective key as the maps
  // above (a FIU's own normalized ID, or one of the two KMBL line keys),
  // then by purpose_code.
  const byFiuCodeAll = new Map();          // effectiveKey -> Map(code -> total ALL successful_fetches)
  const byFiuCodeSlabDeposit = new Map();  // effectiveKey -> Map(code -> Map(slab -> deposit successful_fetches))
  function bump2(map, k1, k2, n) {
    if (!map.has(k1)) map.set(k1, new Map());
    const inner = map.get(k1);
    inner.set(k2, (inner.get(k2) || 0) + n);
  }
  function bump3(map, k1, k2, k3, n) {
    if (!map.has(k1)) map.set(k1, new Map());
    const inner = map.get(k1);
    if (!inner.has(k2)) inner.set(k2, new Map());
    const inner2 = inner.get(k2);
    inner2.set(k3, (inner2.get(k3) || 0) + n);
  }

  for (const r of rows) {
    const key = normId(r.fiu_id);
    const fiType = String(r.fi_type || '').trim().toUpperCase();
    const slab = String(r.dpu_slab || '').trim();
    const sf = Number(r.successful_fetches) || 0;
    const purposeCode = String(r.purpose_code == null ? '' : r.purpose_code).trim();

    if (key === normId(KMBL_FIU_ID)) {
      // KMBL is modeled as 100% Deposit-type regardless of each session's
      // literal fi_type tag (see header comment) — use the fi_type='ALL'
      // (deduplicated per-session total) rows for its slab mix, split by
      // purpose_code, not a literal DEPOSIT_TYPES filter.
      if (fiType === 'ALL') {
        let line = null;
        if (KMBL_PURPOSE_CODE_SPLIT.PFM.has(purposeCode)) line = 'PFM';
        else if (KMBL_PURPOSE_CODE_SPLIT.LENDING.has(purposeCode)) line = 'LENDING';
        if (line) {
          const effectiveKey = KMBL_KEYS[line];
          bump2(byFiuCodeAll, effectiveKey, purposeCode, sf);
          if (KNOWN_SLABS.has(slab)) {
            bump3(byFiuCodeSlabDeposit, effectiveKey, purposeCode, slab, sf);
            const m = kmblSlabDeposit[line];
            m.set(slab, (m.get(slab) || 0) + sf);
          }
        }
      }
      continue; // KMBL-FIU-PROD's raw rows never feed the generic per-ID maps below
    }

    if (fiType === 'ALL') {
      byFiuAll.set(key, (byFiuAll.get(key) || 0) + sf);
      bump2(byFiuCodeAll, key, purposeCode, sf);
    }
    if (DEPOSIT_TYPES.has(fiType) && KNOWN_SLABS.has(slab)) {
      if (!byFiuSlabDeposit.has(key)) byFiuSlabDeposit.set(key, new Map());
      const m = byFiuSlabDeposit.get(key);
      m.set(slab, (m.get(slab) || 0) + sf);
      bump3(byFiuCodeSlabDeposit, key, purposeCode, slab, sf);
    }
  }

  // Build each effective key's purposeCodeBreakdown from the finer-grained
  // maps above — independent of (and run for every key seen in) the
  // FIU-level loop below, so it covers KMBL's two lines too.
  function buildPurposeCodeBreakdown(effectiveKey) {
    const codeAll = byFiuCodeAll.get(effectiveKey);
    if (!codeAll) return null;
    const fiuTotal = Array.from(codeAll.values()).reduce((a, b) => a + b, 0);
    if (fiuTotal <= 0) return null;
    const codeSlabDeposit = byFiuCodeSlabDeposit.get(effectiveKey) || new Map();
    const breakdown = {};
    for (const [code, codeTotal] of codeAll) {
      if (!code || codeTotal <= 0) continue; // skip blank/unspecified and zero-volume codes
      const slabs = codeSlabDeposit.get(code);
      const codeDepositTotal = slabs ? Array.from(slabs.values()).reduce((a, b) => a + b, 0) : 0;
      const shares = slabs ? slabSharesFromCounts(slabs) : null;
      breakdown[code] = {
        sharePct: Math.round((codeTotal / fiuTotal) * 1e6) / 1e6,
        depositSharePct: Math.min(1, Math.round((codeDepositTotal / codeTotal) * 1e6) / 1e6),
        slabShares: shares || {}
      };
    }
    return Object.keys(breakdown).length ? breakdown : null;
  }

  let updatedWithShares = 0, zeroedShare = 0, absentFromReport = 0, kmblUpdated = 0, withPurposeCodeBreakdown = 0;
  const clampedShare = [];

  for (const [key, row] of ycByKey) {
    if (key === KMBL_KEYS.PFM || key === KMBL_KEYS.LENDING) continue; // handled separately below
    const slabs = byFiuSlabDeposit.get(key);
    const presentInReport = byFiuAll.has(key) || !!slabs;
    if (!presentInReport) { absentFromReport++; continue; }

    const totalDeposit = slabs ? Array.from(slabs.values()).reduce((a, b) => a + b, 0) : 0;
    if (totalDeposit <= 0) {
      row.sucDepositSharePct = 0;
      delete row.sucDepositSlabShares;
      zeroedShare++;
    } else {
      const shares = slabSharesFromCounts(slabs);
      const allTotal = byFiuAll.get(key) || 0;
      let sharePct = allTotal > 0 ? totalDeposit / allTotal : null;
      if (sharePct !== null && sharePct > 1) {
        clampedShare.push([row.fiuId, sharePct]);
        sharePct = 1;
      }

      if (shares) row.sucDepositSlabShares = shares;
      if (sharePct !== null) row.sucDepositSharePct = Math.round(sharePct * 1e6) / 1e6;
      updatedWithShares++;
    }

    const breakdown = buildPurposeCodeBreakdown(key);
    if (breakdown) { row.purposeCodeBreakdown = breakdown; withPurposeCodeBreakdown++; }
    else delete row.purposeCodeBreakdown;
  }

  // KMBL-FIU-PROD's two business lines: both keep the established 100%-
  // Deposit convention; only the slab mix is newly derived (from the real
  // report, split by purpose_code) rather than left at its old hand-set
  // flat-rate values.
  for (const [line, key] of [['PFM', KMBL_KEYS.PFM], ['LENDING', KMBL_KEYS.LENDING]]) {
    const row = ycByKey.get(key);
    if (!row) continue;
    const slabs = kmblSlabDeposit[line];
    const shares = slabSharesFromCounts(slabs);
    if (shares) {
      row.sucDepositSlabShares = shares;
      row.sucDepositSharePct = 1;
      kmblUpdated++;
    }
    const breakdown = buildPurposeCodeBreakdown(key);
    if (breakdown) {
      // Both KMBL lines are 100%-Deposit by established convention
      // regardless of what the generic ALL-vs-known-slab ratio computes
      // (see header comment) — force it rather than trust the generic
      // depositSharePct-within-code formula for these two keys only.
      Object.values(breakdown).forEach(b => { b.depositSharePct = 1; });
      row.purposeCodeBreakdown = breakdown;
      withPurposeCodeBreakdown++;
    } else {
      delete row.purposeCodeBreakdown;
    }
  }

  fs.writeFileSync(ycPath, JSON.stringify(yc, null, 2) + '\n');

  console.log('Updated with a real sucDepositSlabShares mix (+ sucDepositSharePct):', updatedWithShares);
  console.log('KMBL-FIU-PROD lines updated via purpose-code split:', kmblUpdated);
  console.log('Set sucDepositSharePct = 0 (present in report, zero Deposit volume):', zeroedShare);
  console.log('Left untouched (absent from the report):', absentFromReport);
  console.log('Got a purposeCodeBreakdown (incl. both KMBL lines):', withPurposeCodeBreakdown);
  if (clampedShare.length) {
    console.log('sucDepositSharePct clamped to 1.0 for', clampedShare.length, 'FIU(s) whose raw ratio exceeded 100% (multi-FI-type session double-counting — see script header):');
    clampedShare.sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([id, pct]) => console.log('  ', id, (pct * 100).toFixed(2) + '%'));
    if (clampedShare.length > 10) console.log('  ... and', clampedShare.length - 10, 'more');
  }
}

main();
