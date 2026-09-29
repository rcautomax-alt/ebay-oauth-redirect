import { nameKey } from './format.js';
import { normalizeStock } from './vehicle.js';

// Other customers (already in today's queue) with the same VOI.
export function sharedVoi(queue, { stock, vin, customerName }) {
  const s = normalizeStock(stock);
  const me = nameKey(customerName);
  const names = queue
    .filter((q) => nameKey(q.customerName) !== me)
    .filter((q) => (s && normalizeStock(q.stock) === s) || (vin && q.vin && q.vin === vin))
    .map((q) => q.customerName);
  return [...new Set(names)];
}

// Replace an entry for the same customer + stock, else append.
export function upsert(queue, entry) {
  const i = queue.findIndex(
    (q) => nameKey(q.customerName) === nameKey(entry.customerName) && normalizeStock(q.stock) === normalizeStock(entry.stock),
  );
  const next = queue.slice();
  if (i >= 0) next[i] = entry;
  else next.push(entry);
  return next;
}

const CSV_COLS = [
  ['savedAt', 'Saved'],
  ['customerName', 'Customer'],
  ['phone', 'Phone'],
  ['email', 'Email'],
  ['taskType', 'Task'],
  ['manager', 'Manager'],
  ['vehicle', 'Vehicle'],
  ['stock', 'Stock #'],
  ['vin', 'VIN'],
  ['crmStatus', 'CRM Status'],
  ['mode', 'Mode'],
  ['asking', 'Asking'],
  ['discount', 'Discount'],
  ['special', 'Special Price'],
  ['withFees', 'Price w/ Fees'],
  ['sharedWith', 'Shared VOI With'],
  ['flags', 'Flags'],
  ['freestyleAsk', 'Freestyle Ask'],
  ['status', 'Status'],
];

function cell(v) {
  const s = Array.isArray(v) ? v.join('; ') : v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(queue) {
  const head = CSV_COLS.map(([, h]) => h).join(',');
  const rows = queue.map((q) => CSV_COLS.map(([k]) => cell(q[k])).join(','));
  return [head, ...rows].join('\n');
}
