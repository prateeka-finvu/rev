const XLSX = require('xlsx');

// Parses an uploaded file buffer (xlsx/xls/csv) into { sheetNames, sheets }
// where sheets[name] is an array of row objects (defval: '').
function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetNames = wb.SheetNames;
  const sheets = {};
  sheetNames.forEach(name => {
    sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
  });
  return { sheetNames, sheets };
}

// Finds a sheet literally named "Master Data" (loose match on case/spacing).
// CSV uploads produce a single sheet named "Sheet1" by SheetJS — treated as
// Master Data automatically since a CSV has no sheet name of its own.
function findMasterDataSheet(sheetNames) {
  const { normHeader } = require('./compute');
  if (sheetNames.length === 1) return sheetNames[0];
  return sheetNames.find(n => normHeader(n) === 'master data') || null;
}

module.exports = { parseWorkbook, findMasterDataSheet };
