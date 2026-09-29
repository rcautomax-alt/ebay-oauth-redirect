import { VIN_MAP } from '../config/vinsolutions-map.js';
import { firstNameOf, nameKey } from './format.js';
import { parseVehicleTitle, isPlausibleStock, isPlausibleVin, normalizeStock } from './vehicle.js';

// Frames come from probeFrame() (see probes.js): one snapshot per frame, with
// `path` = the chain of frame names from the top window down to this frame.

function inPane(frame, re) {
  return re.test(frame.name || '') || (frame.path || []).some((n) => re.test(n || ''));
}

export function splitPanes(frames, map = VIN_MAP) {
  const left = frames.filter((f) => inPane(f, map.frames.left));
  let right = frames.filter((f) => inPane(f, map.frames.right));
  if (!right.length) {
    // Unknown layout (e.g. a popped-out customer window): use everything that
    // isn't the task list.
    right = frames.filter((f) => !inPane(f, map.frames.left));
  }
  return { left, right };
}

export function detectSessionProblem(frames, map = VIN_MAP) {
  const top = frames.find((f) => f.isTop) || frames[0];
  if (!top) return 'No VinSolutions tab found.';
  if (/(signin|login|logon|auth)/i.test(top.url || '') && !/vinsolutions|vinmanager|vinconnect/i.test(top.title || '')) {
    return 'Looks like the login page — sign back in, then hit Retry.';
  }
  if (frames.some((f) => map.markers.sessionExpired.test(f.text || ''))) {
    return 'VinSolutions says the session expired — sign back in, then hit Retry.';
  }
  return null;
}

// email | text | call | other (internal/notification task) | unknown (empty)
export function classifyTaskType(str, map = VIN_MAP) {
  const s = String(str || '');
  if (!s.trim()) return 'unknown';
  const t = map.taskTypes;
  // A reply's own text is the customer's words ("can you call me") — classify
  // by the channel it came in on, not its contents.
  if (t.textReply.test(s)) return 'text';
  if (t.emailReply.test(s)) return 'email';
  if (t.call.test(s)) return 'call';
  if (t.text.test(s)) return 'text';
  if (t.email.test(s)) return 'email';
  return 'other';
}

function firstMatch(text, re) {
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

// Text starting at the Vehicle Info section, stopping at the trade-in /
// buyer sections so we don't grab the trade's numbers by mistake.
function vehicleSectionText(text, map) {
  const start = text.search(map.fields.vehicleSection);
  if (start < 0) return null;
  let section = text.slice(start, start + 2500);
  const end = section.slice(12).search(map.fields.tradeSection);
  if (end >= 0) section = section.slice(0, end + 12);
  return section;
}

// Tasks as they appear in a block of text: each one ends with "Assigned To:".
// Used for both the My Tasks list and the tasks shown on a customer.
function makeTask({ lines, before, assignedTo, section, lead }, map) {
  const tl = map.taskList;
  // Only keep lines after the last date/time line (the Updated/Age columns).
  let start = 0;
  lines.forEach((l, i) => {
    if (tl.dateLike.test(l)) start = i + 1;
  });
  const descLines = [...lines.slice(start), before].map((l) => (l || '').trim()).filter((l) => l && !tl.noise.test(l));
  let template = null;
  const desc = [];
  for (const l of descLines) {
    const m = l.match(tl.template);
    if (m) {
      template = m[2].trim();
      if (m[1].trim()) desc.push(m[1].trim());
    } else {
      desc.push(l);
    }
  }
  const description = desc.join(' ').replace(/\s+/g, ' ').trim();
  const full = `${description} ${template ? `Template: ${template}` : ''}`;
  let type = classifyTaskType(full, map);
  if (section && tl.callSection.test(section)) type = 'call';
  return {
    customer: lead?.customer || '',
    vehicle: lead?.vehicle || '',
    stock: lead?.stock || '',
    section: section || '',
    description,
    template,
    assignedTo: assignedTo.trim(),
    type,
    isPriceQuote: tl.priceQuote.test(full),
  };
}

function looksLikeName(s) {
  return /^[A-Z][A-Za-z.'-]+(?:\s+[A-Za-z][A-Za-z.'-]+){1,3}$/.test(s || '') && !/\d|:/.test(s);
}

export function parseTaskText(text, map = VIN_MAP) {
  const tl = map.taskList;
  const tasks = [];
  let section = '';
  let lead = null;
  let prevFirstCell = '';
  let buf = [];

  for (const raw of String(text || '').split(/\r?\n/)) {
    const cells = raw.split('\t').map((c) => c.trim()).filter(Boolean);
    if (!cells.length) continue;
    const line = cells.join(' ');

    const sh = cells.length === 1 ? line.match(tl.sectionHeader) : null;
    if (sh && !tl.vehicleWithStock.test(line)) {
      section = sh[1].trim();
      lead = null;
      buf = [];
      prevFirstCell = '';
      continue;
    }

    // "(Used)" also sits in parens, so the bracketed part must look like a stock #.
    const vehCellIdx = cells.findIndex((c) => {
      const m = c.match(tl.vehicleWithStock);
      return m && isPlausibleStock(m[2]);
    });
    if (vehCellIdx >= 0) {
      const m = cells[vehCellIdx].match(tl.vehicleWithStock);
      // The customer name sits right above the vehicle (same cell, next line),
      // or in an earlier cell of this same line.
      const sameLineName = cells.slice(0, vehCellIdx).reverse().find(looksLikeName);
      lead = { customer: sameLineName || (looksLikeName(prevFirstCell) ? prevFirstCell : ''), vehicle: m[1].trim(), stock: m[2] };
      buf = [];
      prevFirstCell = cells[0];
      continue;
    }

    const aIdx = cells.findIndex((c) => map.fields.assignedTo.test(c));
    if (aIdx >= 0 && lead) {
      const cell = cells[aIdx];
      const at = cell.search(/Assigned To\s*:/i);
      tasks.push(
        makeTask(
          {
            lines: [...buf, ...cells.slice(0, aIdx)],
            before: cell.slice(0, at),
            assignedTo: cell.slice(at).replace(/Assigned To\s*:\s*/i, ''),
            section,
            lead,
          },
          map,
        ),
      );
      buf = [];
    } else if (lead) {
      buf.push(line);
    }
    prevFirstCell = cells[0];
  }
  return tasks;
}

export function markSharedVoi(tasks) {
  const byStock = new Map();
  for (const t of tasks) {
    const k = normalizeStock(t.stock);
    if (!k) continue;
    if (!byStock.has(k)) byStock.set(k, new Set());
    byStock.get(k).add(t.customer);
  }
  return tasks.map((t) => {
    const names = [...(byStock.get(normalizeStock(t.stock)) || [])].filter((n) => nameKey(n) !== nameKey(t.customer));
    return { ...t, sharedWith: names };
  });
}

export function parseTaskList(frames, map = VIN_MAP) {
  const { left } = splitPanes(frames, map);
  const sources = left.length ? left : frames;
  const tasks = sources.flatMap((f) => parseTaskText(f.text, map));
  return markSharedVoi(tasks);
}

// Tasks shown on a customer detail screen don't carry a vehicle line; just
// split on "Assigned To:" and classify the text in front of each one.
function detailTasks(text, map) {
  const out = [];
  const re = /Assigned To\s*:[ \t]*([^\n\r\t]+)/gi;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const chunk = text.slice(Math.max(last, m.index - 400), m.index);
    const lines = chunk.split(/\r?\n/).map((l) => l.replace(/\t+/g, ' ').trim()).filter(Boolean).slice(-3);
    out.push(makeTask({ lines, before: '', assignedTo: m[1], section: '', lead: null }, map));
    last = m.index + m[0].length;
  }
  return out;
}

// The price-quote task wins; then any email/text task; a lone call is a call.
export function pickTask(tasks) {
  if (!tasks.length) return null;
  return (
    tasks.find((t) => t.isPriceQuote && t.type !== 'call') ||
    tasks.find((t) => t.type === 'email' || t.type === 'text') ||
    tasks.find((t) => t.type === 'call') ||
    tasks[0]
  );
}

export function parseCustomer(frames, map = VIN_MAP) {
  const { right } = splitPanes(frames, map);
  const text = right.map((f) => f.text || '').join('\n\n');
  const f = map.fields;

  let customerName = null;
  for (const re of f.customerName) {
    customerName = firstMatch(text, re);
    if (customerName) break;
  }

  const view = map.markers.leadInfoView.test(text)
    ? 'lead-info'
    : map.markers.dashboardView.test(text)
      ? 'customer-dashboard'
      : 'unknown';

  // Only trust vehicle details from the Vehicle Info section — elsewhere on
  // the dashboard are sold-deal and equity vehicles that aren't the VOI.
  const vSection = vehicleSectionText(text, map);
  let stock = null;
  let vin = null;
  let parsedTitle = null;
  if (vSection) {
    stock = firstMatch(vSection, f.stock);
    if (!isPlausibleStock(stock)) stock = null;
    vin = firstMatch(vSection, f.vin);
    if (!isPlausibleVin(vin)) vin = (vSection.match(f.bareVin) || []).find(isPlausibleVin) || null;
    parsedTitle = parseVehicleTitle(vSection);
  }

  const isActive = map.markers.active.test(text);
  const isSold = map.markers.sold.test(text);
  const needsVin = map.markers.notInventory.test(text);

  let status = 'unknown';
  if (isSold) status = 'sold';
  else if (needsVin && !stock) status = 'not-inventory';
  else if (isActive) status = 'active';

  const countStr = firstMatch(text, f.notesCount);
  const notesCount = countStr === null ? null : Number(countStr);
  const notesStart = text.search(f.notesHeader);
  const notesExcerpt = notesStart >= 0 ? text.slice(notesStart, notesStart + 1500).trim() : '';

  const tasks = detailTasks(text, map);
  const task = pickTask(tasks);

  return {
    view,
    customerName,
    firstName: firstNameOf(customerName),
    email: firstMatch(text, new RegExp(`(${f.email.source})`, 'i')),
    phone: firstMatch(text, new RegExp(`(${f.phone.source})`)),
    manager: firstMatch(text, f.manager),
    assignedTo: task?.assignedTo || null,
    tasks,
    task: { raw: task ? task.description : null, type: task ? task.type : 'unknown', isPriceQuote: !!task?.isPriceQuote },
    voi: {
      title: parsedTitle?.title || null,
      year: parsedTitle?.year || null,
      make: parsedTitle?.make || null,
      model: parsedTitle?.model || null,
      stock,
      vin,
      status,
      markers: { isActive, isSold, needsVin },
    },
    notes: { count: notesCount, excerpt: notesExcerpt },
    textLength: text.length,
  };
}
