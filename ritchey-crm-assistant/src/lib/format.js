export function money(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '';
  const v = Math.round(Number(n));
  const s = Math.abs(v).toLocaleString('en-US');
  return v < 0 ? `-$${s}` : `$${s}`;
}

export function parseMoney(str) {
  if (typeof str === 'number') return str;
  if (!str) return null;
  const cleaned = String(str).replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = Math.round(parseFloat(cleaned));
  return Number.isFinite(n) ? n : null;
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Name comparison that ignores case, punctuation and "Last, First" order.
export function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

export function firstNameOf(fullName) {
  const n = String(fullName || '').trim();
  if (!n) return '';
  if (n.includes(',')) {
    const after = n.split(',')[1].trim();
    return titleCase(after.split(/\s+/)[0] || '');
  }
  return titleCase(n.split(/\s+/)[0]);
}

function titleCase(w) {
  if (!w) return '';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}
