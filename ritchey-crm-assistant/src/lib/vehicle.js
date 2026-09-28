const MULTI_WORD_MAKES = /^(Land|Alfa|Aston|Mercedes)$/i;
const MAKE_SECOND_WORDS = /^(Rover|Romeo|Martin|Benz)$/i;
const STOP_TOKENS =
  /^(stock|vin|mileage|miles|mi\.?|price|color|exterior|interior|view|photos|vdp|msrp|sale|new|used|certified|odometer)$/i;

// "Used 2011 Chrysler 300 Limited  Stock #: 12345A" ->
//   { year: 2011, make: 'Chrysler', model: '300', trim: 'Limited', title: '2011 Chrysler 300 Limited' }
export function parseVehicleTitle(str) {
  if (!str) return null;
  const maxYear = new Date().getFullYear() + 2;
  const re = /\b((?:19|20)\d{2})[ \t]+([A-Za-z][A-Za-z-]*)[ \t]+([^\n\r]+)/g;
  let m;
  while ((m = re.exec(str))) {
    const year = Number(m[1]);
    if (year < 1980 || year > maxYear) continue;
    let make = m[2];
    let rest = m[3].trim().split(/[ \t]+/);
    if (MULTI_WORD_MAKES.test(make) && rest[0] && MAKE_SECOND_WORDS.test(rest[0])) {
      make = `${make} ${rest.shift()}`;
    }
    if (STOP_TOKENS.test(make)) continue;
    const tokens = [];
    for (const t of rest) {
      if (STOP_TOKENS.test(t) || /[:$#|]/.test(t)) break;
      tokens.push(t);
      if (tokens.length >= 4) break;
    }
    if (!tokens.length) continue;
    return {
      year,
      make,
      model: tokens[0],
      trim: tokens.slice(1).join(' '),
      title: `${year} ${make} ${tokens.join(' ')}`,
    };
  }
  return null;
}

export function normalizeStock(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Stock numbers always carry at least one digit — rejects "VIN", "N/A", etc.
export function isPlausibleStock(s) {
  const n = normalizeStock(s);
  return n.length >= 3 && /\d/.test(n) && !/^(VIN|NA|NONE|TBD)$/.test(n);
}

export function isPlausibleVin(v) {
  const s = String(v || '').toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(s) && /\d/.test(s) && /[A-Z]/.test(s);
}
