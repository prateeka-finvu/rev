// Loose column-header matching, ported from the earlier single-file tool.
// Used both for parsing a monthly counts upload and for the convenience
// "seed configs from a Master Data file" import.
const { normHeader } = require('./compute');

const ALIASES = {
  fiuId: ['fiu id', 'fiuid', 'fiu_id', 'fiu', 'fiu code', 'fip id', 'fip'],
  legalName: ['legal name', 'fiu name', 'fiu_name', 'name'],
  tspName: ['tsp name', 'tsp'],
  licenseType: ['license type', 'license'],
  useCase: ['use case', 'use-case', 'usecase'],
  billingModel: ['billing model', 'billing_model', 'model', 'billing type', 'billingtype'],
  // "Billing Yield" is authoritative when present — listed first so it wins
  // over "DF Yield"/generic "Yield" if a sheet has more than one.
  yieldValue: ['billing yield', 'historical yield', 'yield', 'historical_yield', 'yield value', 'yield %', 'yield%', 'df yield'],
  cmgr: ['cmgr', 'q2 cmgr forecast', 'cmgr forecast', 'expected cmgr', 'growth rate'],
  revenue: ['revenue', 'actual revenue', 'billed revenue', 'total revenue'],
  activeUsers: ['active users', 'active_users', 'au count', 'unique users', 'unique_users', 'au'],
  dataFetches: ['successful_data_fetches', 'successful data fetches', 'data fetch count', 'data fetches', 'df count', 'df']
};

function buildColumnMap(row, keys) {
  const headers = Object.keys(row);
  const normHeaders = headers.map(normHeader);
  const map = {};
  const wanted = keys || Object.keys(ALIASES);
  for (const key of wanted) {
    const aliasList = (ALIASES[key] || []).map(normHeader);
    let found = null;
    for (const alias of aliasList) {
      const i = normHeaders.indexOf(alias);
      if (i !== -1) { found = headers[i]; break; }
    }
    if (!found) {
      const safeAliases = aliasList.filter(a => a.length >= 3);
      found = headers.find(h => safeAliases.some(a => normHeader(h).includes(a)));
    }
    if (found) map[key] = found;
  }
  return map;
}

module.exports = { ALIASES, buildColumnMap };
