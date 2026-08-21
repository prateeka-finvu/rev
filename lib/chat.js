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
    periods: dfYieldAnalysis.periods,
    current: condenseDfYieldPeriod(dfYieldAnalysis.current),
    oct2026: condenseDfYieldPeriod(dfYieldAnalysis.oct2026),
    mar2027: condenseDfYieldPeriod(dfYieldAnalysis.mar2027),
    tspByPeriod: (dfYieldAnalysis.tspByPeriod || []).map(t => ({
      label: t.label,
      current: t.current === null || t.current === undefined ? null : Math.round(t.current * 100) / 100,
      oct2026: t.oct2026 === null || t.oct2026 === undefined ? null : Math.round(t.oct2026 * 100) / 100,
      mar2027: t.mar2027 === null || t.mar2027 === undefined ? null : Math.round(t.mar2027 * 100) / 100
    }))
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
    topTen: !!r.topTen,
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
    dfYieldAnalysis: condenseDfYieldAnalysis(computeResult.dfYieldAnalysis)
  };
}

const SYSTEM_PROMPT = `You are a data analyst assistant embedded in the "FIU Revenue Estimator" internal tool. You answer questions about the currently computed revenue data for Financial Information Users (FIUs) under India's Account Aggregator ecosystem.

Domain glossary:
- FIU = Financial Information User (a bank/NBFC/fintech consuming account aggregator data).
- TSP = Technology Service Provider that integrates the FIU to the AA network.
- AU = Active Users (a usage metric some FIUs are billed on).
- DF / Data Fetch = successful data-fetch count (the other usage metric FIUs are billed on).
- SUC = "Standard Usage Charge" — a new flat per-data-fetch billing scheme some FIUs switch to from a configured "SUC Start Month" onward. SUC Cliff CMGR is the compounding monthly growth rate for the first 3 months after switching; SUC Recovery CMGR is the compounding monthly growth rate after that (falls back to the FIU's regular CMGR if not separately set).
- CMGR = Compounding Monthly Growth Rate used to project a FIU's usage/revenue forward in future (non-actual) months.
- "billable" (1) vs not (0) on a given month means that month's revenue is actually counted in totals — e.g. a FIU with missing yield/CMGR config, or an unrecognized/excluded billing model, is not billable and contributes null/0 even where usage exists.
- "Top 10" is a manually-flagged subset of FIUs the business tracks separately.
- DF Yield = Total Revenue / Total DF Count for a given scope (overall / by TSP / by use-case) and month — see the dfYieldAnalysis block.
- Values of null in the monthly arrays mean "no data / not applicable" (e.g. not billable, or no data-fetch count reported) — treat this as different from 0.

You will be given a JSON data block containing the full condensed dataset: one entry per FIU with its monthly [revenue, auUsage, dfUsage, billable] arrays (indices align with the top-level "months" array), plus pre-computed groupings by TSP/Use-case/License and a DF Yield Analysis block. All monetary and usage figures are rounded to whole numbers to save space; treat them as estimates, not exact accounting figures.

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
