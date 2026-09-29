import { parseMoney } from './format.js';
import { parseVehicleTitle, normalizeStock, isPlausibleStock, isPlausibleVin } from './vehicle.js';

export function stockSearchUrl(base, stock) {
  return `${base}?stock=${encodeURIComponent(String(stock).trim())}`;
}

export function stockOrVinUrl(searchAllBase, value) {
  const v = encodeURIComponent(String(value).trim());
  return `${searchAllBase}?stockOrVIN=${v}&q=${v}`;
}

// A search that lands on a page without its query (e.g. the old domain
// forwarding to the new homepage) returns a message; otherwise null.
export function searchDropped(askedUrl, landedUrl) {
  try {
    const asked = new URL(askedUrl);
    const landed = new URL(landedUrl || askedUrl);
    if (asked.search && !landed.search && (asked.host !== landed.host || asked.pathname !== landed.pathname)) {
      return `redirected to ${landed.origin}${landed.pathname} — search address needs updating in Settings`;
    }
  } catch {
    /* not a URL we can judge */
  }
  return null;
}

export function modelSearchUrl(base, model) {
  return `${base}?model=${encodeURIComponent(String(model).trim())}`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "SALE PRICE $32,995" -> 32995. Labels are tried in priority order; amounts
// under $1,000 are ignored so a "$399/mo" payment never passes for a price.
export function parsePrice(text, labels) {
  if (!text) return null;
  for (const label of labels) {
    const re = new RegExp(`${escapeRe(label)}\\s*:?\\s*\\$\\s*([\\d,]+)`, 'gi');
    let m;
    while ((m = re.exec(text))) {
      const n = parseMoney(m[1]);
      if (n && n >= 1000) return n;
    }
  }
  return null;
}

function pick(data, keys) {
  for (const k of keys) {
    const hit = Object.keys(data || {}).find((dk) => dk.toLowerCase() === k);
    if (hit && data[hit]) return data[hit];
  }
  return null;
}

// One vehicle card -> { title, year, make, model, stock, vin, price, url }
export function parseVehicleCard(card, labels, baseUrl) {
  const text = card.text || '';
  const data = card.data || {};

  let vin = pick(data, ['vin']);
  if (!isPlausibleVin(vin)) {
    const m = text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/g) || [];
    vin = m.find(isPlausibleVin) || null;
  }

  let stock = pick(data, ['stock', 'stocknum', 'stocknumber', 'stockno']);
  if (!isPlausibleStock(stock)) {
    const m = text.match(/Stock\s*(?:#|No\.?|Number)?\s*:?\s*([A-Z0-9][A-Z0-9-]{2,14})\b/i);
    stock = m && isPlausibleStock(m[1]) ? m[1] : null;
  }

  let miles = parseMoney(pick(data, ['miles', 'mileage', 'odometer']));
  if (!miles) {
    const mm = text.match(/(?:Mileage|Miles|Odometer|Odom)\s*:?\s*([\d,]{2,7})\b|\b([\d,]{2,7})\s*(?:mi\b|miles\b)/i);
    miles = mm ? parseMoney(mm[1] || mm[2]) : null;
  }

  let price = parseMoney(pick(data, ['saleprice', 'price', 'internetprice']));
  if (!price || price < 1000) price = parsePrice(text, labels);

  const dYear = pick(data, ['year']);
  const dMake = pick(data, ['make']);
  const dModel = pick(data, ['model']);
  const t =
    dYear && dMake && dModel
      ? { year: Number(dYear), make: dMake, model: dModel, title: `${dYear} ${dMake} ${dModel} ${pick(data, ['trim']) || ''}`.trim() }
      : parseVehicleTitle(text);

  let url = card.href || '';
  if (url && baseUrl) {
    try {
      url = new URL(url, baseUrl).href;
    } catch {
      url = '';
    }
  }

  return {
    title: t?.title || null,
    year: t?.year || null,
    make: t?.make || null,
    model: t?.model || null,
    stock,
    vin: vin ? vin.toUpperCase() : null,
    price,
    miles,
    url,
  };
}

// schema.org Car/Vehicle/Product blocks, which many dealer sites embed.
export function vehiclesFromJsonLd(jsonStrings) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const types = [].concat(node['@type'] || []).join(' ');
    if (/Car|Vehicle|Product/i.test(types) && (node.vehicleIdentificationNumber || node.offers)) {
      const offers = [].concat(node.offers || [])[0] || {};
      const title = typeof node.name === 'string' ? node.name : null;
      const parsed = parseVehicleTitle(title || '');
      out.push({
        title: parsed?.title || title,
        year: parsed?.year || null,
        make: parsed?.make || null,
        model: parsed?.model || null,
        stock: isPlausibleStock(node.sku || node.productID) ? node.sku || node.productID : null,
        vin: isPlausibleVin(node.vehicleIdentificationNumber) ? node.vehicleIdentificationNumber.toUpperCase() : null,
        price: parseMoney(offers.price),
        miles: parseMoney(node.mileageFromOdometer?.value ?? node.mileageFromOdometer),
        url: offers.url || node.url || '',
      });
    }
    Object.values(node).forEach((v) => typeof v === 'object' && visit(v));
  };
  for (const s of jsonStrings || []) {
    try {
      visit(JSON.parse(s));
    } catch {
      /* malformed JSON-LD is common; skip it */
    }
  }
  return out;
}

// Combine card scraping + JSON-LD into one de-duplicated list.
export function vehiclesFromExtraction(extraction, labels, baseUrl) {
  const fromCards = (extraction.cards || []).map((c) => parseVehicleCard(c, labels, baseUrl));
  const fromLd = vehiclesFromJsonLd(extraction.jsonld);

  const merged = [];
  const keyOf = (v) => v.vin || (v.stock ? `S:${normalizeStock(v.stock)}` : null);
  for (const v of [...fromCards, ...fromLd]) {
    if (!v.vin && !v.stock) continue;
    const k = keyOf(v);
    const existing = merged.find(
      (m) => keyOf(m) === k || (v.vin && m.vin === v.vin) || (v.stock && m.stock && normalizeStock(m.stock) === normalizeStock(v.stock)),
    );
    if (existing) {
      for (const f of Object.keys(v)) if (!existing[f] && v[f]) existing[f] = v[f];
    } else {
      merged.push({ ...v });
    }
  }

  // No cards at all (e.g. a stock search that lands straight on the VDP):
  // treat the whole page as one vehicle if it has a stock # and a price.
  if (!merged.length && extraction.bodyText) {
    const v = parseVehicleCard({ text: extraction.bodyText, data: {} }, labels, baseUrl);
    if ((v.stock || v.vin) && v.price) merged.push(v);
  }
  return merged;
}

export function findVehicle(vehicles, { stock, vin }) {
  const s = normalizeStock(stock);
  const v = String(vin || '').toUpperCase();
  return (
    vehicles.find((x) => s && x.stock && normalizeStock(x.stock) === s) ||
    vehicles.find((x) => v && x.vin === v) ||
    null
  );
}

// Free-text search on the site (the q= box behind searchall.aspx), used when
// the model search comes back empty.
export function keywordSearchUrl(searchAllBase, words) {
  return `${searchAllBase}?q=${encodeURIComponent(String(words).trim())}`;
}

// Best link for a vehicle: its own VDP if we saw one, else the exact
// stock/VIN search that VinSolutions' "View VDP" button uses.
export function vehicleLink(v, searchAllBase) {
  if (v.url) return v.url;
  const key = v.vin || v.stock;
  return key && searchAllBase ? stockOrVinUrl(searchAllBase, key) : '';
}

// Similar units for a sold / unavailable VOI. Closest price first when we know
// the original price; newest first otherwise. Units whose price couldn't be
// read are kept (at the end) rather than silently dropped.
export function pickAlternatives(vehicles, { excludeStock, excludeVin, targetPrice, window, limit }) {
  const ex = normalizeStock(excludeStock);
  const pool = vehicles.filter((v) => !(ex && normalizeStock(v.stock) === ex) && !(excludeVin && v.vin === excludeVin));
  const priced = pool.filter((v) => v.price);
  const unpriced = pool.filter((v) => !v.price).map((v) => ({ ...v, inWindow: null }));
  let ranked;
  if (targetPrice) {
    ranked = priced
      .map((v) => ({ ...v, diff: Math.abs(v.price - targetPrice), inWindow: Math.abs(v.price - targetPrice) <= window }))
      .sort((a, b) => a.diff - b.diff);
  } else {
    ranked = priced.map((v) => ({ ...v, inWindow: true })).sort((a, b) => (b.year || 0) - (a.year || 0) || a.price - b.price);
  }
  return [...ranked, ...unpriced].slice(0, limit);
}
