// Chat-with-your-data feature. Two responsibilities:
//   1. buildChatContext(computeResult) — condense a /api/compute response
//      (which can be 1MB+ for the full ~500-FIU dataset) into a much smaller
//      JSON block that still contains every number a question could need,
//      so it's cheap enough to send as context to the Anthropic API on
//      every question (with prompt caching so repeat questions in the same
//      session don't re-pay the input-token cost).
//   2. askChat(...) — actually call the Anthropic API (Messages API) with a
//      system prompt describing the app's domain + the condensed context,
//      plus the running chat history, and return the assistant's reply.
//
// Requires the ANTHROPIC_API_KEY environment variable — this module never
// hardcodes or stores a key. If it's missing, askChat throws a clear error
// that the server route turns into a 400 without leaking anything sensitive.

// Positional per-month array for a single FIU: [revenue, auUsage, dfUsage, billable]
// - revenue / auUsage / dfUsage are rounded to whole numbers (this is a
//   revenue *estimate* tool — sub-rupee / sub-unit precision isn't
//   meaningful here and dropping decimals meaningfully shrinks the context).
// - billable is 1/0 instead of true/false to save a few bytes per cell at
//   this scale (thousands of cells).
// - null is used for "no value" (NaN in the source data) rather than 0, so
//   the model can tell "zero revenue" apart from "not billable / no data".
function round0(v) {
  if (v === null || v === undefined || isNaN(v)) return null;
  return Math.round(v);
}

function condenseMonthly(monthly) {
  return monthly.map(m => [
    round0(m.revenue),
    round0(m.usage),
    round0(m.dfUsage),
    m.billable ? 1 : 0
  ]);
}

// Condense one grouped-by-* block (groupedByTsp / groupedByUseCase /
// groupedByLicense), each of which is already fairly compact
// ({ revenue, au, df }, each an array of { label, fiuCount, monthly } ).
function condenseGroupMetric(groups) {
  return groups.map(g => ({
    label: g.label,
    fiuCount: g.fiuCount,
    monthly: g.monthly.map(round0)
  }));
}

function condenseGrouped(grouped) {
  if (!grouped) return null;
  return {
    revenue: condenseGroupMetric(grouped.revenue),
    au: condenseGroupMetric(grouped.au),
    df: condenseGroupMetric(grouped.df)
  };
}

// groupedByUseCaseLicense (added 2026-10-26) — same shape as the groups
// above but keyed by a (useCase, licenseType) pair instead of a single
// label, and with no `au` metric (server.js only builds revenue/df for
// this one — see server.js). Powers the DF Yield tab's "By Use-case"
// table, which groups by Use-case x License Type since 2026-10-26 (ask:
// "add a license type column to both these table so we can look at DF
// yields basis a combination of use-case and license type").
function condenseUseCaseLicenseMetric(groups) {
  return (groups || []).map(g => ({
    useCase: g.useCase,
    licenseType: g.licenseType,
    fiuCount: g.fiuCount,
    monthly: g.monthly.map(round0)
  }));
}
function condenseUseCaseLicenseGrouped(grouped) {
  if (!grouped) return null;
  return {
    revenue: condenseUseCaseLicenseMetric(grouped.revenue),
    df: condenseUseCaseLicenseMetric(grouped.df)
  };
}

function round2(v) {
  if (v === null || v === undefined || isNaN(v)) return null;
  return Math.round(v * 100) / 100;
}

// purposeCodeYield (added 2026-10-26, extended 2026-10-27 with
// dpuSlabPct) — the data behind the DF Yield tab's "By Purpose Code" and
// "By FIU x Purpose Code" tables. See lib/compute.js's
// purposeCodeYieldBreakdown() for why this only has a defined answer
// during the DPI Pricing period (pre-DPI revenue has no purpose-code
// attribution at all) and why dpuSlabPct values sum to a row's Deposit
// share of DF, not to 100% (only Deposit-type volume has a DPU-slab
// breakdown).
function condensePurposeCodeYield(pcy) {
  if (!pcy) return null;
  return {
    licenseTypes: pcy.licenseTypes,
    purposeCodes: pcy.purposeCodes,
    totalsDpiLabel: pcy.totalsDpiLabel,
    dpuSlabs: pcy.dpuSlabs,
    totals: (pcy.totals || []).map(t => ({
      purposeCode: t.purposeCode,
      licenseType: t.licenseType,
      revenue: round0(t.revenue),
      dfCount: round0(t.dfCount),
      yield: round2(t.yield),
      dpuSlabPct: t.dpuSlabPct
        ? Object.fromEntries(Object.entries(t.dpuSlabPct).map(([k, v]) => [k, round2(v)]))
        : null
    })),
    byFiu: (pcy.byFiu || []).map(f => ({
      fiuId: f.fiuId,
      legalName: f.legalName,
      licenseType: f.licenseType,
      purposeCode: f.purposeCode,
      revenue: round0(f.revenue),
      yield: round2(f.yield)
    }))
  };
}

function condenseDfYieldRows(rows) {
  return (rows || []).map(r => ({
    label: r.label,
    revenue: round0(r.revenue),
    dfCount: round0(r.dfCount),
    yield: r.yield === null || r.yield === undefined ? null : Math.round(r.yield * 100) / 100
  }));
}

function condenseDfYieldPeriod(p) {
  if (!p) return null;
  return {
    label: p.label,
    index: p.index,
    overall: p.overall ? condenseDfYieldRows([p.overall])[0] : null,
    byUseCase: condenseDfYieldRows(p.byUseCase),
    byTsp: condenseDfYieldRows(p.byTsp)
  };
}

function condenseDfYieldAnalysis(dfYieldAnalysis) {
  if (!dfYieldAnalysis) return null;
  return {
    // current/oct2026/mar2027/tspByPeriod: an older overall/by-TSP/
    // by-use-case cut for three single months (today, Oct 2026, Mar
    // 2027). The DF Yield Analysis tab stopped rendering this 2026-10-26
    // in favor of the full-FY-period tables below, but it's still part of
    // the raw /api/compute response so it's kept here too — see
    // purposeCodeYield for what the UI actually shows today.
    periods: dfYieldAnalysis.periods,
    current: condenseDfYieldPeriod(dfYieldAnalysis.current),
    oct2026: condenseDfYieldPeriod(dfYieldAnalysis.oct2026),
    mar2027: condenseDfYieldPeriod(dfYieldAnalysis.mar2027),
    tspByPeriod: (dfYieldAnalysis.tspByPeriod || []).map(t => ({
      label: t.label,
      current: t.current === null || t.current === undefined ? null : Math.round(t.current * 100) / 100,
      oct2026: t.oct2026 === null || t.oct2026 === undefined ? null : Math.round(t.oct2026 * 100) / 100,
      mar2027: t.mar2027 === null || t.mar2027 === undefined ? null : Math.round(t.mar2027 * 100) / 100
    })),
    // purposeCodeYield: what the DF Yield Analysis tab's "By Purpose Code"
    // and "By FIU x Purpose Code" tables actually show today — see
    // condensePurposeCodeYield above.
    purposeCodeYield: condensePurposeCodeYield(dfYieldAnalysis.purposeCodeYield)
  };
}

// Build the condensed context block sent to the model. `computeResult` is
// the exact JSON object /api/compute returns (the frontend's `lastResult`).
function buildChatContext(computeResult) {
  if (!computeResult || !Array.isArray(computeResult.rows)) {
    throw new Error('buildChatContext requires a /api/compute result with a rows array');
  }
  const months = (computeResult.months || []).map(m => m.label);
  const currentIndex = computeResult.currentIndex;

  const fius = computeResult.rows.map(r => ({
    fiuId: r.fiuId,
    legalName: r.legalName,
    tsp: r.tspName,
    license: r.licenseType,
    useCase: r.useCase,
    billingModel: r.billingModel,
    usageType: r.usageType,
    yield: r.yieldValue === null || r.yieldValue === undefined || isNaN(r.yieldValue) ? null : r.yieldValue,
    cmgr: r.cmgr,
    sucYield: r.sucYieldValue,
    sucCliffCmgr: r.sucCliffCmgr,
    sucRecoveryCmgr: r.sucRecoveryCmgr,
    sucApplicable: !!r.sucApplicable,
    sucBillable: !!r.sucBillable,
    notBillable: !!r.notBillable,
    // months: array of [revenue, auUsage, dfUsage, billable(1/0)] per month,
    // in the same order as the top-level `months` array.
    months: condenseMonthly(r.monthly)
  }));

  return {
    asOfDate: computeResult.asOfDate,
    months,
    currentMonthIndex: currentIndex,
    currentMonthLabel: months[currentIndex] || null,
    totalsByMonth: (computeResult.totalsByMonth || []).map(round0),
    unbilledSummary: computeResult.unbilledSummary || null,
    sucSummary: computeResult.sucSummary || null,
    fius,
    groupedByTsp: condenseGrouped(computeResult.groupedByTsp),
    groupedByUseCase: condenseGrouped(computeResult.groupedByUseCase),
    groupedByLicense: condenseGrouped(computeResult.groupedByLicense),
    groupedByUseCaseLicense: condenseUseCaseLicenseGrouped(computeResult.groupedByUseCaseLicense),
    dfYieldAnalysis: condenseDfYieldAnalysis(computeResult.dfYieldAnalysis)
  };
}

const SYSTEM_PROMPT = `You are a data analyst assistant embedded in the "FIU Revenue Estimator" internal tool. You answer questions about the currently computed revenue data for Financial Information Users (FIUs) under India's Account Aggregator ecosystem.

Domain glossary:
- FIU = Financial Information User (a bank/NBFC/fintech consuming account aggregator data).
- TSP = Technology Service Provider that integrates the FIU to the AA network.
- AU = Active Users (a usage metric some FIUs are billed on).
- DF / Data Fetch = successful data-fetch count (the other usage metric FIUs are billed on).
- DPI Pricing (Digital Public Infrastructure Pricing) = a new flat per-data-fetch billing scheme some FIUs switch to from a configured "DPI Pricing Start Month" onward. DPI Pricing Cliff CMGR is the compounding monthly growth rate for the first 3 months after switching; DPI Pricing Recovery CMGR is the compounding monthly growth rate after that (falls back to the FIU's regular CMGR if not separately set). In the JSON data block below, these fields still use their original internal key names — sucYield, sucCliffCmgr, sucRecoveryCmgr, sucApplicable, sucBillable, sucSummary — always refer to them as "DPI Pricing" in your answers (DPI Pricing Yield, DPI Pricing Cliff CMGR, etc.), never as "SUC".
- CMGR = Compounding Monthly Growth Rate used to project a FIU's usage/revenue forward in future (non-actual) months.
- "billable" (1) vs not (0) on a given month means that month's revenue is actually counted in totals — e.g. a FIU with missing yield/CMGR config, or an unrecognized/excluded billing model, is not billable and contributes null/0 even where usage exists.
- "Top 10 - Lending" / "Top 10 - PFM" in the app are the 10 FIUs with the highest FY Total revenue within that Use-case — computed dynamically from the revenue figures, not a flag in this data. If asked about "top 10" FIUs, work it out yourself by ranking the FIUs in this JSON block by their summed revenue across all months.
- DF Yield = Total Revenue / Total DF Count for a given scope and period. This shows up in several places in the data, matching the app's DF Yield Analysis tab: groupedByUseCaseLicense (Annual/Pre-DPI/Post-DPI DF Yield by Use-case x License Type, full FY — the tab's "By Use-case" table); dfYieldAnalysis.purposeCodeYield.totals (DF Yield by Purpose Code x License Type, the "By Purpose Code" table) and .byFiu (DF Yield by individual FIU x Purpose Code, the "By FIU x Purpose Code" table) — both of these are summed across the DPI Pricing Start Date through the end of the FY ONLY (purposeCodeYield.totalsDpiLabel says which months), because purpose-code attribution has no meaning before DPI Pricing starts — never answer a pre-DPI purpose-code question from this data, say plainly that it isn't attributable instead; and dfYieldAnalysis.current/oct2026/mar2027/tspByPeriod, an older overall/by-TSP/by-use-case cut for three single months that the app's UI no longer shows but is still present here if asked about specifically.
- DPU = one of the 8 data-pull-duration slabs on the DPI Pricing rate card (13 Months, 7 Months, 4 Months, 1 Month, 1 Week, 5 Days, 1 Day, Profile & Summary — see dfYieldAnalysis.purposeCodeYield.dpuSlabs for the exact key/label pairs). Each row in purposeCodeYield.totals has a dpuSlabPct giving that DPU's share of the row's own DF volume. Only Deposit-type DF volume has a DPU-slab breakdown at all (non-Deposit bills at a flat rate with no DPU concept), so a row's dpuSlabPct values sum to its Deposit share of DF, not to 100% — don't describe them as summing to 100% or treat a missing/low slab as an error.
- Values of null in the monthly arrays mean "no data / not applicable" (e.g. not billable, or no data-fetch count reported) — treat this as different from 0.

You will be given a JSON data block containing the full condensed dataset: one entry per FIU with its monthly [revenue, auUsage, dfUsage, billable] arrays (indices align with the top-level "months" array), plus pre-computed groupings by TSP/Use-case/License/Use-case x License and a DF Yield Analysis block (full-FY and DPI-period purpose-code/DPU breakdowns included). All monetary and usage figures are rounded to whole numbers to save space; treat them as estimates, not exact accounting figures.

Answer questions using ONLY the data in this JSON block — do not invent numbers. When you give a figure, briefly say what it's based on (e.g. which month(s)/FIUs/grouping). If the data needed to answer isn't present in the block, say so plainly instead of guessing. Keep answers concise and to the point — this is a working tool for an internal team, not a report. Use INR (₹) for currency figures when the underlying numbers are money.`;

async function askChat({ apiKey, model, messages, computeResult }) {
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set on the server. Set it as an environment variable and restart the server to enable chat.');
  }
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('messages must be a non-empty array');
  }

  // Loaded lazily so the rest of the app works even if the dependency is
  // somehow missing (e.g. a partial install) — only the chat route fails.
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const context = buildChatContext(computeResult);
  const contextJson = JSON.stringify(context);

  const resolvedModel = model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

  const response = await client.messages.create({
    model: resolvedModel,
    max_tokens: 1024,
    system: [
      { type: 'text', text: SYSTEM_PROMPT },
      {
        type: 'text',
        text: 'Current dataset (condensed JSON):\n' + contextJson,
        // Cached so repeated questions against the same computed dataset
        // within a chat session don't re-pay full input-token cost for this
        // (potentially large) block on every turn.
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: messages.map(m => ({ role: m.role, content: m.content }))
  });

  const reply = (response.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();

  return { reply, model: resolvedModel, usage: response.usage || null };
}

module.exports = { buildChatContext, askChat, SYSTEM_PROMPT };
