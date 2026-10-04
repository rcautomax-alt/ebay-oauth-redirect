// vAuto Price Adjuster — reads the vAuto Pricing export (.xls/.xlsx/.csv)
// Columns are matched by header name, so column order in vAuto doesn't matter.

(function (root) {
  const COLUMNS = {
    stock: [/^stock\s*#?$/],
    vehicle: [/^vehicle$/],
    vin: [/^vin$/],
    age: [/^age$/],
    disposition: [/^disp(osition)?$/],
    price: [/^price$/, /^list price$/],
    marketPct: [/^default\s*%\s*of\s*market$/, /%\s*of\s*market/],
    lastChange: [/^last\s*\$\s*change$/],
    book: [/^book$/],
    cost: [/^cost$/],
    markup: [/^markup$/],
    odometer: [/^odometer$/, /^miles$/],
    daysSupply: [/^overall$/, /days\s*supply/],
    likeMine: [/^like\s*mine$/, /vehicles like mine/],
    color: [/^color$/],
    status: [/^status$/]
  };
  // Optional wholesale columns, if Rick adds them to his vAuto view
  const WHOLESALE_PATTERN = /mmr|auction|manheim|wholesale|acv|trade\s*value|black\s*book|kbb/i;

  const norm = h => String(h || '').replace(/\s+/g, ' ').trim().toLowerCase();

  function toNumber(x) {
    if (x == null || x === '') return null;
    if (typeof x === 'number') return Number.isFinite(x) ? x : null;
    const s = String(x).trim();
    if (!s || /^(n\/?a|-+|—)$/i.test(s)) return null;
    const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[$\s]/g, ''));
    const n = parseFloat(s.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? (neg ? -n : n) : null;
  }

  // Market % comes as 1.0417 (fraction) in .xls, or "104%" in CSV
  function toMarketPct(x) {
    const n = toNumber(x);
    if (n == null) return null;
    return n < 3 ? n * 100 : n;
  }

  // Excel serial date or date string -> whole days before `today`
  function daysSince(x, today) {
    if (x == null || x === '') return null;
    let d;
    if (typeof x === 'number') d = new Date(Math.round((x - 25569) * 86400000));
    else if (x instanceof Date) d = x;
    else { d = new Date(x); if (isNaN(d)) return null; }
    const ms = today.getTime() - d.getTime();
    return Math.max(0, Math.floor(ms / 86400000));
  }

  // rows: array of arrays (first row = headers), e.g. from XLSX sheet_to_json(header:1)
  function parseRows(rows, today = new Date()) {
    if (!rows || !rows.length) throw new Error('The file is empty.');
    // Header row = first row that has a "Stock #" style cell
    let h = rows.findIndex(r => r.some(c => COLUMNS.stock.some(re => re.test(norm(c)))));
    if (h < 0) throw new Error('Could not find a "Stock #" column. Is this the vAuto Pricing export?');
    const headers = rows[h].map(norm);

    const idx = {};
    for (const [key, patterns] of Object.entries(COLUMNS)) {
      idx[key] = headers.findIndex(hd => patterns.some(re => re.test(hd)));
    }
    const wholesaleCols = headers
      .map((hd, i) => ({ name: String(rows[h][i]).replace(/\s+/g, ' ').trim(), i }))
      .filter(c => WHOLESALE_PATTERN.test(c.name));

    const missingCols = ['stock', 'vehicle', 'age', 'price', 'marketPct', 'book', 'markup', 'daysSupply', 'likeMine']
      .filter(k => idx[k] < 0);

    const get = (r, k) => (idx[k] >= 0 ? r[idx[k]] : null);
    const vehicles = [];
    for (const r of rows.slice(h + 1)) {
      const stock = String(get(r, 'stock') ?? '').trim();
      if (!stock) continue;
      const wholesale = {};
      wholesaleCols.forEach(c => { if (r[c.i] !== '' && r[c.i] != null) wholesale[c.name] = r[c.i]; });
      vehicles.push({
        stock,
        vehicle: String(get(r, 'vehicle') ?? '').trim(),
        vin: String(get(r, 'vin') ?? '').trim(),
        age: toNumber(get(r, 'age')) ?? 0,
        disposition: String(get(r, 'disposition') ?? '').trim(),
        price: toNumber(get(r, 'price')),
        marketPct: toMarketPct(get(r, 'marketPct')),
        lastChangeDays: daysSince(get(r, 'lastChange'), today),
        book: toNumber(get(r, 'book')),
        cost: toNumber(get(r, 'cost')),
        markup: toNumber(get(r, 'markup')),
        odometer: toNumber(get(r, 'odometer')),
        daysSupply: toNumber(get(r, 'daysSupply')),
        likeMine: toNumber(get(r, 'likeMine')),
        color: String(get(r, 'color') ?? '').trim(),
        wholesale
      });
    }
    return { vehicles, missingCols, wholesaleCols: wholesaleCols.map(c => c.name) };
  }

  const api = { parseRows, toNumber, toMarketPct, daysSince };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ExportParser = api;
})(typeof self !== 'undefined' ? self : this);
