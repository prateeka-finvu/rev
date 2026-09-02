// Core revenue computation: billing-model classification, month-to-date ->
// full-month projection for Data Fetch usage, the fiscal-year month list,
// and CMGR-based forward projection. Ported from the earlier single-file
// tool's verified logic (Active/Unique Users use the AU count as-is; Data
// Fetch/Fix Billing project the DF count from a month-to-date total to a
// full month using day-of-month / days-in-month).

function normHeader(h) {
  return String(h == null ? '' : h).trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

// Maps a Billing Model label (from FIU Metadata config) to which usage
// figure feeds the calculation, plus an informational billing period
// (Quarterly/Annual) when present. "Active Users" and "Unique Users" are
// the same billing model. Blank / "Not billed" / "Unbilled" / anything
// unrecognized is excluded, never guessed.
function classifyBillingModel(billingModel) {
  const m = normHeader(billingModel);
  if (!m) return null;
  let usageType = null;
  if (/active\s*user|unique\s*user/.test(m)) usageType = 'au';
  else if (/data\s*fetch/.test(m)) usageType = 'df';
  else if (/fix(ed)?\s*bill|^fixed$|flat\s*fee/.test(m)) usageType = 'df';
  if (!usageType) return null;
  let periodLabel = null;
  if (/quarter/.test(m)) periodLabel = 'Quarterly';
  else if (/annual|yearly/.test(m)) periodLabel = 'Annual';
  return { usageType, periodLabel };
}

function toNumber(v) {
  if (v === undefined || v === null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const cleaned = String(v).replace(/[,%\s]/g, '').replace(/[₹$]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? NaN : n;
}

function daysInMonth(year, month1to12) {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

// Project a month-to-date Data Fetch total to a full-month figure using the
// as-of date's day-of-month and the full length of that month.
function projectMonthToDate(mtdVolume, asOfDate) {
  const day = asOfDate.getUTCDate();
  const dim = daysInMonth(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth() + 1);
  if (day <= 0) return NaN;
  return (mtdVolume / day) * dim;
}

// List of {year, month(1-12)} from the as-of date's month through the end
// of its fiscal year, inclusive. fyStartMonth defaults to 4 (April).
function fyRemainingMonths(asOfDate, fyStartMonth) {
  fyStartMonth = fyStartMonth || 4;
  const asOfYear = asOfDate.getUTCFullYear();
  const asOfMonth = asOfDate.getUTCMonth() + 1;
  const fyEndYear = asOfMonth >= fyStartMonth ? asOfYear + 1 : asOfYear;
  const fyEndMonth = fyStartMonth === 1 ? 12 : fyStartMonth - 1; // month right before FY start
  const months = [];
  let y = asOfYear, m = asOfMonth;
  // Safety cap at 12 iterations — a fiscal year is never longer than that.
  for (let i = 0; i < 12; i++) {
    months.push({ year: y, month: m });
    if (y === fyEndYear && m === fyEndMonth) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}

function monthLabel(year, month1to12) {
  return new Date(Date.UTC(year, month1to12 - 1, 1))
    .toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Compares two { year, month } points; negative if a < b, 0 if equal, positive if a > b.
function ymCompare(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  return a.month - b.month;
}

function ymKey(year, month) {
  return year + '-' + String(month).padStart(2, '0');
}

// Whole-month distance from a to b (b - a, in months) — e.g. Jan 2027 minus
// Oct 2026 = 3. Used to split the SUC period into its Cliff/Recovery
// quarters relative to the SUC Start Date.
function ymDiffMonths(a, b) {
  return (b.year - a.year) * 12 + (b.month - a.month);
}

// All 12 { year, month } points making up the fiscal year that contains
// asOfDate, in order (e.g. Apr 2026 .. Mar 2027 for fyStartMonth=4). Unlike
// fyRemainingMonths, this includes months *before* asOfDate too — used to
// show historical actuals (Apr-Jul) alongside the computed/projected months.
function fyFullMonths(asOfDate, fyStartMonth) {
  fyStartMonth = fyStartMonth || 4;
  const asOfYear = asOfDate.getUTCFullYear();
  const asOfMonth = asOfDate.getUTCMonth() + 1;
  const startYear = asOfMonth >= fyStartMonth ? asOfYear : asOfYear - 1;
  const months = [];
  let y = startYear, m = fyStartMonth;
  for (let i = 0; i < 12; i++) {
    months.push({ year: y, month: m });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}

// Sums recorded actual revenue (from the Historical Actuals store) per
// calendar month, for the "Projected vs Actual" comparison chart. Unlike the
// isPast/currentIndex-gated actuals used inside computeRevenue's monthly
// loop, this looks at every month independently of where "today" sits in
// the FY — so the Actual series simply reflects whatever's been recorded so
// far, however far the FY has progressed since a projection snapshot was
// taken. A month with no historical rows at all is null (no data yet, not
// zero); a month with rows but no usable revenue values sums to 0.
//
// Only rows whose FIU ID matches a real entry in the FIU Metadata config are
// counted — the same scoping computeRevenue's own rows/totalsByMonth use for
// past months (a historical row is only ever looked up by a real FIU ID
// coming out of the metadata join). This isn't just for consistency: the
// Historical Actuals sheet has, in practice, picked up stray
// summary/subtotal rows from whatever spreadsheet it was seeded from (e.g. a
// "fiuId" of "Total Revenue" or "Sub Total" holding that month's grand
// total) — summing every row unfiltered would silently double-count those
// months. Requiring a metadata match filters them out for free, without
// needing to hardcode a blocklist of sentinel labels.
function buildActualsByMonth(monthCols, historicalByKey, metadataById) {
  if (!historicalByKey) return monthCols.map(() => null);
  const totalsByYm = new Map(); // ym -> summed revenue, only for rows with a usable number
  const seenYm = new Set();     // ym -> any (metadata-matched) historical row exists for this month
  for (const [hKey, row] of historicalByKey) {
    const sep = hKey.indexOf('::');
    if (sep === -1) continue;
    const fiuKey = hKey.slice(0, sep);
    if (metadataById && !metadataById.has(fiuKey)) continue;
    const ym = hKey.slice(sep + 2);
    seenYm.add(ym);
    const revenue = toNumber(row.revenue);
    if (isNaN(revenue)) continue;
    totalsByYm.set(ym, (totalsByYm.get(ym) || 0) + revenue);
  }
  return monthCols.map(mc => {
    const ym = ymKey(mc.year, mc.month);
    if (!seenYm.has(ym)) return null;
    return totalsByYm.get(ym) || 0;
  });
}

// ---- One-off manual revenue overrides ----
// Keyed by normalized FIU ID (trimmed, uppercased — matches the `key`
// variable used throughout computeRevenue). Applied as a post-process on an
// otherwise normally-computed `monthly` array, so usage/dfUsage figures (and
// historical/SUC highlighting for months the override doesn't touch) stay
// intact — only revenue and billability are forced for the covered months.
//   'monthly-schedule': revenue = schedule[YYYY-MM] if present, else
//     defaultAmount, for every month of the FY.
//   'flat-until-suc': revenue = amount for every month strictly before the
//     SUC Start Date (or, if no SUC Start Date is set, every month of the
//     FY); months at/after the SUC Start Date fall through to normal
//     computation (including the SUC Data-Fetch switch, if applicable).
const FIXED_REVENUE_OVERRIDES = {
  'FIULIVE@CANARABANK': { type: 'monthly-schedule', schedule: { '2026-11': 350000 }, defaultAmount: 0 },
  'FIULIVE@MONEYCONTROL': { type: 'flat-until-suc', amount: 160000 }
};

// fiulive@axisbank (ask: 2026-08-19) — two independent, non-overlapping
// input overrides (not revenue overrides — revenue still comes from
// usage x yield / dfUsage x sucYield as normal, just with a forced input):
//   1. AU count fixed at 25,000 from Sep 2026 onward, for as long as
//      Unique-User billing is what's actually driving revenue (i.e. any
//      month that isn't SUC-active — SUC, once active, is governed by #2
//      instead).
//   2. DF count during the SUC period fixed at 10% of the recorded July
//      2026 DF count (flat every SUC month, not compounded).
// Revisited 2026-09-02 against a newer reference sheet with a different
// implied Oct'26 DF figure for this FIU — kept as-is on request; this
// 10%-of-July-actual rule remains the source of truth for axisbank.
const AXISBANK_KEY = 'FIULIVE@AXISBANK';
const AXISBANK_AU_OVERRIDE_VALUE = 25000;
const AXISBANK_AU_OVERRIDE_FROM = { year: 2026, month: 9 };
const AXISBANK_DF_SUC_FACTOR = 0.10;
const AXISBANK_DF_SUC_REFERENCE_MONTH = '2026-07';

// fiulive@hdfc and HDFC-FIU (ask: 2026-08-19) — both currently have Billing
// Model "Unbilled", which normally excludes a FIU from SUC entirely (SUC
// only ever applies to an otherwise-billable FIU — see sucApplicable
// below). For just these two, that exclusion is waived from the SUC Start
// Month onward: once SUC is active they compute revenue as DF Count x SUC
// Yield exactly like any other SUC-configured FIU (still gated on having
// both SUC Yield and SUC Cliff CMGR configured, and a usable DF count).
// Before the SUC Start Month, they're still unbilled/excluded as normal.
const FORCE_SUC_DESPITE_UNBILLED = new Set(['FIULIVE@HDFC', 'HDFC-FIU']);

// Same two FIUs (ask: 2026-08-19): once SUC kicks in, their expected Data
// Fetch volume is cut by 43% — the assumption being that this is the share
// of their DF volume that's on-bank data, which they'll stop fetching this
// way to cut costs once SUC pricing applies. Applied once, at the SUC
// switch (same one-time-cut-then-compound-normally pattern as the PFM/
// non-Bank 1/6 rule above), not re-applied every subsequent SUC month.
const HDFC_DF_SUC_REDUCTION_FACTOR = 0.57; // i.e. cut by 43%

// Flat SUC-period revenue overrides for FIUs newly onboarding in H2 with no
// real usage history yet (ask: 2026-09-02) — ICICI (PFM), SBI Cards, and
// KMBL-FIU-PROD (PFM) all have zero actual Data Fetch volume through Aug
// 2026, so the normal DF-baseline-compounding SUC math has nothing to grow
// from and would otherwise show ₹0 straight through the SUC period. The
// September 2026 reference sheet instead assumed flat monthly revenue for
// these three from the SUC Start Month through Mar 2027 (KMBL-FIU-PROD
// (PFM) steps down once, from Jan 2027 onward). Keyed by the normalized FIU
// ID (matches `key` below), each a { 'YYYY-MM': amount } schedule covering
// every month the reference sheet gave a flat figure for; a SUC month not
// in the schedule falls back to ₹0 rather than the normal computation.
//
// This is meant to be a stand-in only until real usage starts appearing:
// applied only to SUC-active months, and only for a FIU whose *current*
// month's uploaded Data Fetch count is still 0/missing. The moment a live
// monthly upload reports a real (nonzero) Data Fetch count for one of these
// FIUs, this override stops applying for that FIU — for good, not just that
// one month — and it computes normally from then on (DF baseline × SUC
// Yield, Cliff/Recovery CMGR) off that real, growing baseline instead. No
// stored state is needed for that switch: it's re-evaluated fresh from
// whatever counts were just uploaded, every time this runs.
const FLAT_SUC_REVENUE_OVERRIDES = {
  'ICICI': { '2026-10': 51000, '2026-11': 51000, '2026-12': 51000, '2027-01': 51000, '2027-02': 51000, '2027-03': 51000 },
  'SBI CARDS': { '2026-10': 80000, '2026-11': 80000, '2026-12': 80000, '2027-01': 80000, '2027-02': 80000, '2027-03': 80000 },
  'KMBL-FIU-PROD (PFM)': { '2026-10': 1379669, '2026-11': 1379669, '2026-12': 1379669, '2027-01': 229945, '2027-02': 229945, '2027-03': 229945 }
};

// ---- What-if revenue scenarios (ask: 2026-09-02) ----
// Opt-in, mix-and-match adjustments layered on top of the normal SUC
// computation above — each one only ever changes behavior for months that
// are already SUC-active (sucActive === true); nothing here touches the
// pre-SUC months or FIUs SUC doesn't apply to. Passed in as a `scenarios`
// object of booleans (e.g. { lendingCmgrWorse: true }); any key left
// out/false behaves exactly as before this feature existed, so the default
// {} (or omitting the argument) is a no-op. Both scenarios can be enabled
// together — they target disjoint Use-case populations (Lending vs
// non-Bank PFM) so there's no ordering to worry about between them.
//
// SCENARIO_DEFINITIONS mirrors the two keys below — kept here (rather than
// only in server.js/the frontend) so the checkbox labels/descriptions shown
// to the user can never drift from what this file actually implements.
const SCENARIO_DEFINITIONS = [
  {
    key: 'lendingCmgrWorse',
    label: 'Lending CMGR 1.5x worse during SUC Cliff',
    description: 'During the SUC Cliff (the first 3 months of the SUC period), every Lending FIU’s SUC Cliff CMGR is multiplied by 1.5 — a conservative measure of de-growth coming in 1.5x worse than anticipated. SUC Recovery is left untouched: recovery is still assumed to happen at the originally-anticipated pace, not accelerated.'
  },
  {
    key: 'nonBankPfmZero',
    label: 'Non-bank PFM FIUs → ₹0 post-SUC',
    description: 'Once SUC kicks in, PFM-use-case FIUs whose License Type isn’t Bank contribute ₹0 revenue for every SUC month (their DF/usage figures are still shown as normal).'
  }
];
// Use-case classification shared with the existing PFM/non-Bank DF cut
// above (dfReductionEligible) — kept as a standalone helper since the
// non-bank-PFM scenario needs the exact same test, independently of
// whether that /6 DF cut also applies.
function isNonBankPfm(meta) {
  return String(meta.useCase || '').trim().toLowerCase() === 'pfm'
    && String(meta.licenseType || '').trim().toLowerCase() !== 'bank';
}
function isLendingUseCase(meta) {
  return String(meta.useCase || '').trim().toLowerCase() === 'lending';
}
const LENDING_CMGR_WORSE_FACTOR = 1.5;

function applyFixedRevenueOverride(key, monthCols, monthly, sucStartDate) {
  const override = FIXED_REVENUE_OVERRIDES[key];
  if (!override) return monthly;
  return monthly.map((m, i) => {
    const mc = monthCols[i];
    let amount = null;
    if (override.type === 'monthly-schedule') {
      const mk = ymKey(mc.year, mc.month);
      amount = Object.prototype.hasOwnProperty.call(override.schedule, mk) ? override.schedule[mk] : override.defaultAmount;
    } else if (override.type === 'flat-until-suc') {
      const beforeSuc = !sucStartDate || ymCompare(mc, sucStartDate) < 0;
      if (beforeSuc) amount = override.amount;
    }
    if (amount === null) return m; // no override for this month — leave the natural computation as-is
    return { ...m, revenue: amount, billable: true, hasActual: true, isActual: false, sucActive: false, sucPhase: null };
  });
}

// counts: array of { fiuId, activeUsers, dataFetches }
// metadataById: Map(normId -> { fiuId, legalName, tspName, licenseType, useCase, billingModel })
// yieldCmgrById: Map(normId -> { fiuId, yield, cmgr, sucYield, sucCliffCmgr, sucRecoveryCmgr })
// asOfDate: JS Date the counts were pulled as of (drives current-month MTD projection and the FY month list)
// sucStartDate: optional { year, month } — the "SUC Start Date". If set, any
// FY month at or after this point switches that FIU's growth rate and yield
// from its regular CMGR/Yield to SUC Yield x expected Data Fetch volume
// (only for FIUs that have both SUC Yield and SUC Cliff CMGR configured —
// otherwise that FIU is left on its regular CMGR/Yield for the whole FY, and
// it's counted in sucSummary so the gap stays visible instead of silently
// defaulting to 0). The growth rate during that SUC period itself switches
// partway through: SUC Cliff CMGR for the first 3 months (SUC Cliff), then
// SUC Recovery CMGR for the rest of the FY (SUC Recovery) — falling back to
// the FIU's regular CMGR for Recovery if SUC Recovery CMGR isn't set.
// historicalByKey: optional Map(`${normId}::YYYY-MM` -> { billingModel,
// revenue, auCount, dfCount, billingYield }) — actual figures for FY months
// before asOfDate, read from the pre-loaded historical-actuals store. Those
// months are shown as-is (never recomputed/compounded); they're independent
// of the CMGR projection chain, which still starts fresh at the current
// month.
// scenarios: optional { lendingCmgrWorse?, nonBankPfmZero? } — see the
// "What-if revenue scenarios" block above. Defaults to {} (no effect on
// anything), and any combination of the two can be turned on together.
function computeRevenue(counts, metadataById, yieldCmgrById, asOfDate, fyStartMonth, sucStartDate, historicalByKey, scenarios) {
  scenarios = scenarios || {};
  const scenarioLendingCmgrWorse = !!scenarios.lendingCmgrWorse;
  const scenarioNonBankPfmZero = !!scenarios.nonBankPfmZero;
  const fullMonths = fyFullMonths(asOfDate, fyStartMonth);
  const asOfYear = asOfDate.getUTCFullYear();
  const asOfMonth = asOfDate.getUTCMonth() + 1;
  const foundIndex = fullMonths.findIndex(m => m.year === asOfYear && m.month === asOfMonth);
  const currentIndex = foundIndex === -1 ? 0 : foundIndex; // defensive fallback, should always be found

  const monthCols = fullMonths.map((m, i) => ({
    ...m,
    label: monthLabel(m.year, m.month),
    isCurrent: i === currentIndex,
    isPast: i < currentIndex,
    isFuture: i > currentIndex
  }));

  const rows = [];
  const unmatchedCounts = []; // FIU IDs present in the upload but missing from FIU Metadata config
  const seenKeys = new Set();

  for (const c of counts) {
    const fiuId = String(c.fiuId || '').trim();
    if (!fiuId) continue;
    const key = fiuId.trim().toUpperCase();
    seenKeys.add(key);
    const meta = metadataById.get(key);
    const yc = yieldCmgrById.get(key);

    if (!meta) {
      unmatchedCounts.push(fiuId);
      continue;
    }

    const billingInfo = classifyBillingModel(meta.billingModel);
    const notBillable = billingInfo === null;
    const yieldValue = yc ? toNumber(yc.yield) : NaN;
    const cmgr = yc ? toNumber(yc.cmgr) : 0;
    const cmgrRate = isNaN(cmgr) ? 0 : cmgr;

    const sucYieldRaw = yc ? toNumber(yc.sucYield) : NaN;
    const sucCliffCmgrRaw = yc ? toNumber(yc.sucCliffCmgr) : NaN;
    const sucCliffCmgrRate = isNaN(sucCliffCmgrRaw) ? 0 : sucCliffCmgrRaw;
    // SUC Recovery CMGR is optional — a FIU that hasn't had it filled in yet
    // just keeps growing at its regular (pre-SUC) CMGR once Recovery starts,
    // same behavior as before this field existed.
    const sucRecoveryCmgrRaw = yc ? toNumber(yc.sucRecoveryCmgr) : NaN;
    const sucRecoveryCmgrRate = isNaN(sucRecoveryCmgrRaw) ? cmgrRate : sucRecoveryCmgrRaw;
    const sucConfigured = !isNaN(sucYieldRaw) && !isNaN(sucCliffCmgrRaw);
    // A FIU with an unrecognized/excluded billing model never bills,
    // SUC-configured or not — SUC only ever applies to a FIU that's
    // otherwise billable. FORCE_SUC_DESPITE_UNBILLED waives that for a
    // couple of specific FIUs that are Unbilled on record but should still
    // switch onto SUC revenue from the SUC Start Month (see comment above).
    const sucApplicable = !!sucStartDate && sucConfigured && (!notBillable || FORCE_SUC_DESPITE_UNBILLED.has(key));

    const auCount = toNumber(c.activeUsers);
    const dfCount = toNumber(c.dataFetches);

    let baselineUsage = NaN;
    if (billingInfo) {
      if (billingInfo.usageType === 'au') baselineUsage = auCount;
      else baselineUsage = isNaN(dfCount) ? NaN : projectMonthToDate(dfCount, asOfDate);
    }

    const hasData = !notBillable && !isNaN(baselineUsage) && !isNaN(yieldValue);

    // Expected Data Fetch volume — projected from this month's raw DF count
    // the same way a Data-Fetch-billed FIU's usage is projected, but tracked
    // for *every* FIU regardless of billing model. This feeds (a) the DF
    // count tables, which now show every FIU's DF volume, and (b) SUC
    // revenue: from the SUC Start Date onward a FIU's revenue is driven by
    // this figure x SUC Yield, not by its regular Unique-User/Data-Fetch
    // classification.
    const dfBaselineUsage = isNaN(dfCount) ? NaN : projectMonthToDate(dfCount, asOfDate);
    const sucBillable = sucApplicable && !isNaN(dfBaselineUsage) && !isNaN(sucYieldRaw);

    // PFM FIUs whose License isn't Bank get their expected Data Fetch
    // volume cut to 1/6 for the SUC period only (ask: 2026-08-19) — applied
    // to the running dfUsage chain right when SUC kicks in, so it carries
    // forward (still compounding at the normal rate) for every subsequent
    // SUC month automatically.
    const dfReductionEligible = String(meta.useCase || '').trim().toLowerCase() === 'pfm'
      && String(meta.licenseType || '').trim().toLowerCase() !== 'bank';

    // What-if scenario eligibility — see SCENARIO_DEFINITIONS above. Both
    // are plain Use-case/License Type tests, independent of whether the
    // scenario is actually turned on for this compute (checked again below,
    // right before each one's effect is applied).
    const lendingCmgrWorseEligible = scenarioLendingCmgrWorse && isLendingUseCase(meta);
    const nonBankPfmZeroEligible = scenarioNonBankPfmZero && isNonBankPfm(meta);

    // Flat SUC-period revenue override eligibility — see
    // FLAT_SUC_REVENUE_OVERRIDES above. Evaluated once per FIU per compute,
    // off this compute's own current-month Data Fetch input: as soon as a
    // real (nonzero) count shows up there, this FIU stops being eligible —
    // not just for the current month, but for every month this compute
    // produces — and falls through to the normal SUC computation instead.
    const flatSucSchedule = FLAT_SUC_REVENUE_OVERRIDES[key];
    const flatSucOverrideEligible = !!flatSucSchedule && (isNaN(dfCount) || dfCount <= 0);

    // fiulive@axisbank input overrides — see FIXED_REVENUE_OVERRIDES comment
    // block above. The July reference DF count comes from the same
    // historical-actuals store the Annual tables already read from.
    const isAxisbank = key === AXISBANK_KEY;
    let axisbankDfSucValue = NaN;
    if (isAxisbank && historicalByKey) {
      const julyActual = historicalByKey.get(key + '::' + AXISBANK_DF_SUC_REFERENCE_MONTH);
      const julyDf = julyActual ? toNumber(julyActual.dfCount) : NaN;
      if (!isNaN(julyDf)) axisbankDfSucValue = julyDf * AXISBANK_DF_SUC_FACTOR;
    }

    // Walk the months in order so the growth rate (and yield) can switch
    // mid-stream at the SUC Start Date — usage for month i always compounds
    // off month i-1's usage, it's never recomputed from the original
    // baseline with a single rate. Months before the current one are actual
    // historical figures (if seeded) and sit outside this compounding chain
    // entirely. dfUsage is a second, parallel chain tracking expected Data
    // Fetch volume for every FIU (independent of its billing model), so it
    // stays available for display even in months/FIUs where it isn't what
    // drives revenue.
    let usage = NaN;
    let dfUsage = NaN;
    let dfReductionApplied = false; // ensures the /6 cut applies once, at the switch, not every SUC month
    let hdfcDfReductionApplied = false; // same guard, for the HDFC 43% cut below
    const monthly = monthCols.map((mc, i) => {
      // Looked up for every month (not just past ones) — a recorded actual
      // for the *current* month (the one this compute would otherwise
      // project from the live upload) needs the same lookup below, once
      // the current month's usage/dfUsage chain has been seeded from that
      // live upload for the months after it to keep compounding from.
      const hKey = historicalByKey ? key + '::' + ymKey(mc.year, mc.month) : null;
      const actual = hKey ? historicalByKey.get(hKey) : null;

      if (mc.isPast) {
        if (!actual) return { usage: NaN, revenue: NaN, sucActive: false, sucPhase: null, isActual: true, hasActual: false, billable: false, dfUsage: NaN };
        const actualRevenue = toNumber(actual.revenue);
        const actualAu = toNumber(actual.auCount);
        const actualDf = toNumber(actual.dfCount);
        const actualUsage = billingInfo && billingInfo.usageType === 'au' ? actualAu
          : billingInfo && billingInfo.usageType === 'df' ? actualDf
          : NaN;
        const hasActual = !isNaN(actualRevenue);
        return { usage: actualUsage, revenue: actualRevenue, sucActive: false, sucPhase: null, isActual: true, hasActual, billable: hasActual, dfUsage: actualDf };
      }

      const sucActive = sucApplicable && ymCompare(mc, sucStartDate) >= 0;
      // The SUC period splits into two quarters (ask: 2026-08-19): SUC
      // Cliff — the first 3 months from the SUC Start Month, a low-traffic
      // dip right after the price increase, driven by SUC Cliff CMGR — and
      // SUC Recovery — every SUC month after that, where traffic is
      // expected to recover, driven by SUC Recovery CMGR (or the FIU's
      // regular pre-SUC CMGR if SUC Recovery CMGR isn't configured). SUC
      // Yield itself doesn't change between the two — only the growth rate
      // does; the price increase is assumed to stick.
      const sucPhase = sucActive ? (ymDiffMonths(sucStartDate, mc) < 3 ? 'cliff' : 'recovery') : null;
      let rate = sucActive ? (sucPhase === 'cliff' ? sucCliffCmgrRate : sucRecoveryCmgrRate) : cmgrRate;
      // Scenario: Lending CMGR 1.5x worse during the SUC Cliff only — a
      // conservative de-growth measure for the initial dip; SUC Recovery is
      // deliberately left untouched (recovery still happens at the
      // originally-anticipated pace, not accelerated). Pre-SUC months are
      // untouched too (this whole branch is inside sucActive).
      if (sucActive && sucPhase === 'cliff' && lendingCmgrWorseEligible) rate = rate * LENDING_CMGR_WORSE_FACTOR;

      // Advance the DF-volume chain every non-past month, for every FIU
      // that reported a DF count — independent of billing model or SUC.
      if (i === currentIndex) {
        dfUsage = dfBaselineUsage;
      } else if (!isNaN(dfUsage)) {
        dfUsage = dfUsage * (1 + rate);
      }
      if (sucActive && dfReductionEligible && !isNaN(dfUsage) && !dfReductionApplied) {
        dfUsage = dfUsage / 6;
        dfReductionApplied = true;
      }
      // fiulive@hdfc / HDFC-FIU: expected Data Fetch volume cut by 43% once,
      // at the SUC switch — see HDFC_DF_SUC_REDUCTION_FACTOR comment above.
      if (sucActive && FORCE_SUC_DESPITE_UNBILLED.has(key) && !isNaN(dfUsage) && !hdfcDfReductionApplied) {
        dfUsage = dfUsage * HDFC_DF_SUC_REDUCTION_FACTOR;
        hdfcDfReductionApplied = true;
      }
      // axisbank: DF count during the SUC period is fixed at 10% of the
      // recorded July 2026 DF count, flat every SUC month (not compounded,
      // and not subject to the PFM/non-Bank /6 rule above — axisbank is
      // License=Bank so that rule doesn't apply to it anyway).
      if (isAxisbank && sucActive && !isNaN(axisbankDfSucValue)) {
        dfUsage = axisbankDfSucValue;
      }

      // Advance the regular (pre-SUC-classification) usage chain — still
      // needed for months before SUC starts, and for FIUs SUC doesn't apply to.
      if (hasData) {
        if (i === currentIndex) usage = baselineUsage;
        else if (!isNaN(usage)) usage = usage * (1 + rate);
      }
      // axisbank: AU count is fixed at 25,000 from Sep 2026 onward, for as
      // long as Unique-User billing is actually driving revenue (i.e. not
      // yet SUC-active — SUC governs its own DF-based figure above).
      if (isAxisbank && !sucActive && ymCompare(mc, AXISBANK_AU_OVERRIDE_FROM) >= 0) {
        usage = AXISBANK_AU_OVERRIDE_VALUE;
      }

      // A recorded actual for the *current* month takes priority over every
      // computed path below (flat overrides, what-if scenarios, SUC, and
      // the regular Yield x usage formula) — same as a past month, just
      // without waiting for the As-of Date to roll past it first. Before
      // this, a month that had genuinely closed and been recorded in
      // Historical Actuals still showed the live-computed figure, not the
      // actual, until someone remembered to advance the As-of Date — that
      // silent gap is what this closes. usage/dfUsage above are still
      // seeded from the live upload (needed so next month keeps compounding
      // off real usage, not off this month's — possibly flat/negotiated —
      // recorded revenue), only the *returned* figures for this month
      // change. sucActive/sucPhase are reported as-if pre-SUC (matching how
      // a past actual is already reported) since a recorded actual isn't a
      // SUC-model output either way.
      if (i === currentIndex && actual) {
        const actualRevenue = toNumber(actual.revenue);
        if (!isNaN(actualRevenue)) {
          const actualAu = toNumber(actual.auCount);
          const actualDf = toNumber(actual.dfCount);
          const actualUsage = billingInfo && billingInfo.usageType === 'au' ? actualAu
            : billingInfo && billingInfo.usageType === 'df' ? actualDf
            : NaN;
          return { usage: actualUsage, revenue: actualRevenue, sucActive: false, sucPhase: null, isActual: true, hasActual: true, billable: true, dfUsage: actualDf };
        }
      }

      if (sucActive) {
        // Flat SUC-period revenue override (ICICI, SBI Cards, KMBL-FIU-PROD
        // (PFM) — see FLAT_SUC_REVENUE_OVERRIDES above) — takes priority
        // over everything else below, for as long as this FIU has no real
        // Data Fetch usage yet. usage/dfUsage still reflect the normal
        // (currently-zero) computation for display consistency; only
        // revenue is replaced.
        if (flatSucOverrideEligible) {
          const mk = ymKey(mc.year, mc.month);
          const amount = Object.prototype.hasOwnProperty.call(flatSucSchedule, mk) ? flatSucSchedule[mk] : 0;
          return { usage: dfUsage, revenue: amount, sucActive: true, sucPhase, isActual: false, hasActual: false, billable: true, dfUsage };
        }
        // Scenario: non-bank PFM FIUs contribute ₹0 revenue once SUC kicks
        // in — usage/dfUsage above are still computed and shown as normal
        // (including the PFM/non-Bank /6 DF cut, if that also applies);
        // only revenue is forced to 0. Takes priority over the normal
        // SUC-billable computation below, but still marks the month
        // billable (an explicit ₹0, not a missing/"—" figure).
        if (nonBankPfmZeroEligible) {
          return { usage: dfUsage, revenue: 0, sucActive: true, sucPhase, isActual: false, hasActual: false, billable: true, dfUsage };
        }
        // From the SUC Start Date onward, revenue for every SUC-configured
        // FIU is SUC Yield x expected Data Fetch volume — its original
        // Unique-User billing no longer applies, even if that's still its
        // billing model on record.
        if (!sucBillable) return { usage: dfUsage, revenue: NaN, sucActive: true, sucPhase, isActual: false, hasActual: false, billable: false, dfUsage };
        const revenue = dfUsage * sucYieldRaw;
        return { usage: dfUsage, revenue, sucActive: true, sucPhase, isActual: false, hasActual: false, billable: true, dfUsage };
      }

      if (!hasData) return { usage: NaN, revenue: NaN, sucActive: false, sucPhase: null, isActual: false, hasActual: false, billable: false, dfUsage };
      const revenue = usage * yieldValue;
      return { usage, revenue, sucActive: false, sucPhase: null, isActual: false, hasActual: false, billable: true, dfUsage };
    });

    const monthlyFinal = applyFixedRevenueOverride(key, monthCols, monthly, sucStartDate);

    rows.push({
      fiuId,
      legalName: meta.legalName || '',
      tspName: meta.tspName || '',
      licenseType: meta.licenseType || '',
      useCase: meta.useCase || '',
      topTen: !!meta.topTen,
      billingModel: meta.billingModel || '—',
      billingPeriod: billingInfo ? billingInfo.periodLabel : null,
      usageType: billingInfo ? billingInfo.usageType : null,
      yieldValue,
      cmgr: cmgrRate,
      sucYieldValue: isNaN(sucYieldRaw) ? null : sucYieldRaw,
      sucCliffCmgr: isNaN(sucCliffCmgrRaw) ? null : sucCliffCmgrRate,
      sucRecoveryCmgr: isNaN(sucRecoveryCmgrRaw) ? null : sucRecoveryCmgrRate,
      sucConfigured,
      sucApplicable,
      sucBillable,
      lendingCmgrWorseApplied: lendingCmgrWorseEligible,
      nonBankPfmZeroApplied: nonBankPfmZeroEligible,
      flatSucOverrideApplied: flatSucOverrideEligible,
      auCount: isNaN(auCount) ? null : auCount,
      dfCount: isNaN(dfCount) ? null : dfCount,
      hasData,
      notBillable,
      missingYieldOrCmgrConfig: !yc,
      monthly: monthlyFinal
    });
  }

  const unmatchedMeta = []; // FIU IDs in config with no counts in this month's upload
  metadataById.forEach((meta, key) => {
    if (!seenKeys.has(key)) unmatchedMeta.push(meta.fiuId);
  });

  const totalsByMonth = monthCols.map((mc, i) => {
    return rows.filter(r => r.monthly[i].billable).reduce((s, r) => s + (r.monthly[i].revenue || 0), 0);
  });

  // Unbilled = a recognized-as-excluded billing model (blank, "Not billed",
  // "Unbilled", or any other unrecognized label) — still shown with their
  // raw AU/DF counts so nothing billable-looking silently disappears.
  const unbilledRows = rows.filter(r => r.notBillable);
  const unbilledSummary = {
    count: unbilledRows.length,
    totalAuCount: unbilledRows.reduce((s, r) => s + (r.auCount || 0), 0),
    totalDfCount: unbilledRows.reduce((s, r) => s + (r.dfCount || 0), 0)
  };

  // sucSummary: whether a SUC Start Date was applied this compute, and how
  // many FIUs actually switched to SUC Yield x Data Fetch volume vs. were
  // left on their regular Yield/CMGR because they don't have both SUC
  // fields configured, or don't have a usable DF count to switch onto
  // (never silently 0). billedRows = FIUs billed under their regular
  // (pre-SUC) config — the pool "missing SUC config" is drawn from.
  const billedRows = rows.filter(r => r.hasData);
  const sucSummary = {
    active: !!sucStartDate,
    startLabel: sucStartDate ? monthLabel(sucStartDate.year, sucStartDate.month) : null,
    switchedCount: sucStartDate ? rows.filter(r => r.sucApplicable && r.monthly.some(m => m.sucActive && m.billable)).length : 0,
    missingCount: sucStartDate ? billedRows.filter(r => !r.sucConfigured).length : 0,
    missingDfCount: sucStartDate ? rows.filter(r => r.sucApplicable && !r.sucBillable).length : 0
  };

  return { months: monthCols, currentIndex, rows, totalsByMonth, unmatchedCounts, unmatchedMeta, unbilledSummary, sucSummary };
}

// Rolls up computed per-FIU rows into per-group totals (e.g. by TSP,
// Use-case, or License Type) across the same month columns, for an
// arbitrary per-month metric. `includeFn(row)` decides whether a row
// belongs to this view at all (e.g. usageType==='au' for the AU view,
// dfCount!=null for the DF view — mirroring the same row filters the
// per-FIU Annual AU/DF tables use); `valueFn(monthEntry)` extracts the
// month's contributing value (or null/NaN to skip it), mirroring the same
// isActual/billable rules the per-FIU Annual tables use so the grouped
// totals reconcile exactly with them. A blank group value is bucketed as
// "(Unspecified)" rather than dropped. currentIndex is only used to pick
// the default sort month below.
function groupByMetric(rows, groupFn, includeFn, valueFn, currentIndex) {
  const numMonths = rows.length && rows[0].monthly ? rows[0].monthly.length : 0;
  const sortIndex = currentIndex || 0;
  const groups = new Map();
  for (const r of rows) {
    if (!includeFn(r)) continue;
    const monthValues = r.monthly.map(valueFn);
    const contributes = monthValues.some(v => v !== null && v !== undefined && !isNaN(v));
    if (!contributes) continue;
    const label = (groupFn(r) || '').trim() || '(Unspecified)';
    if (!groups.has(label)) groups.set(label, { label, fiuCount: 0, monthly: new Array(numMonths).fill(0) });
    const g = groups.get(label);
    g.fiuCount += 1;
    monthValues.forEach((v, i) => {
      if (v !== null && v !== undefined && !isNaN(v)) g.monthly[i] += v;
    });
  }
  return Array.from(groups.values()).sort((a, b) => (b.monthly[sortIndex] || 0) - (a.monthly[sortIndex] || 0));
}

// Revenue: same billable-driven rule used for FY totals — a month
// contributes if monthly[i].billable, which already folds together
// historical actuals (billable = hasActual), regular billing (billable =
// hasData), and SUC-driven Data-Fetch billing (billable = sucBillable).
function groupRevenue(rows, groupFn, currentIndex) {
  return groupByMetric(
    rows, groupFn,
    () => true,
    m => (m.isActual ? (m.hasActual ? m.revenue : null) : (m.billable ? m.revenue : null)),
    currentIndex
  );
}

// AU count: only FIUs actually billed on Active/Unique Users (same filter
// as the per-FIU Annual AU count table), same billable-driven month rule as
// revenue but reading usage instead.
function groupAuUsage(rows, groupFn, currentIndex) {
  return groupByMetric(
    rows, groupFn,
    r => r.usageType === 'au',
    m => (m.isActual ? ((m.hasActual && !isNaN(m.usage)) ? m.usage : null) : (m.billable ? m.usage : null)),
    currentIndex
  );
}

// DF count: every FIU that reported a DF count at all, regardless of
// billing model (same filter as the per-FIU Annual DF count table) — a
// Unique-User-billed FIU's Data Fetch volume still matters once SUC kicks
// in, so it's visible here even before SUC makes it relevant. Future/
// current months use dfUsage whenever it's a number (not gated on
// billable, matching the per-FIU table); historical months still require
// an actual.
// A notBillable FIU is still included here if sucApplicable is true —
// covers the FORCE_SUC_DESPITE_UNBILLED case (e.g. fiulive@hdfc, HDFC-FIU)
// where a FIU stays "Unbilled" on record but genuinely bills DF-driven
// revenue once SUC kicks in, and so needs to be visible in DF-count views
// too, not silently dropped by the same billing-model exclusion.
function groupDfUsage(rows, groupFn, currentIndex) {
  return groupByMetric(
    rows, groupFn,
    r => (!r.notBillable || r.sucApplicable) && r.dfCount !== null,
    m => (m.isActual ? ((m.hasActual && !isNaN(m.dfUsage)) ? m.dfUsage : null) : (!isNaN(m.dfUsage) ? m.dfUsage : null)),
    currentIndex
  );
}

// DF Yield = Total Revenue / Total DF Count, for a single FY month and an
// arbitrary scope (overall, or grouped by an FIU Metadata field). Revenue
// uses the same billable-gated rule as groupRevenue; DF Count uses the same
// broad "every FIU that reported a DF count" rule as groupDfUsage — so a
// group's DF Yield reflects revenue earned across its whole Data Fetch
// footprint, not just the FIUs currently billing on it. A row can
// contribute to one side without the other (e.g. an Active/Unique-User FIU
// that never reports a DF count still counts its revenue, with dfCount
// staying 0 for its group). yield is null (not 0 or Infinity) wherever
// dfCount is 0 for that group, so the frontend can render "—" instead of a
// divide-by-zero artifact.
function dfYieldBreakdown(rows, groupFn, monthIndex) {
  const groups = new Map();
  const ensure = label => {
    if (!groups.has(label)) groups.set(label, { label, revenue: 0, dfCount: 0 });
    return groups.get(label);
  };
  for (const r of rows) {
    const m = r.monthly[monthIndex];
    if (!m) continue;
    const label = (groupFn(r) || '').trim() || '(Unspecified)';
    const revenueVal = m.isActual ? (m.hasActual ? m.revenue : null) : (m.billable ? m.revenue : null);
    if (revenueVal !== null && !isNaN(revenueVal)) ensure(label).revenue += revenueVal;
    const dfEligible = (!r.notBillable || r.sucApplicable) && r.dfCount !== null;
    if (dfEligible) {
      const dfVal = m.isActual ? ((m.hasActual && !isNaN(m.dfUsage)) ? m.dfUsage : null) : (!isNaN(m.dfUsage) ? m.dfUsage : null);
      if (dfVal !== null) ensure(label).dfCount += dfVal;
    }
  }
  return Array.from(groups.values())
    .map(g => ({ ...g, yield: g.dfCount > 0 ? g.revenue / g.dfCount : null }))
    .sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
}

module.exports = {
  normHeader,
  classifyBillingModel,
  toNumber,
  daysInMonth,
  projectMonthToDate,
  fyRemainingMonths,
  fyFullMonths,
  ymKey,
  monthLabel,
  computeRevenue,
  dfYieldBreakdown,
  groupRevenue,
  groupAuUsage,
  groupDfUsage,
  buildActualsByMonth,
  SCENARIO_DEFINITIONS
};
