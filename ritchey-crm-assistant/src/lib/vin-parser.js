import { VIN_MAP } from '../config/vinsolutions-map.js';
import { firstNameOf } from './format.js';
import { parseVehicleTitle, isPlausibleStock, isPlausibleVin } from './vehicle.js';

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
  if (/(signin|login|logon|auth)/i.test(top.url || '') && !/vinsolutions|vinmanager/i.test(top.title || '')) {
    return 'Looks like the login page — sign back in, then hit Retry.';
  }
  if (frames.some((f) => map.markers.sessionExpired.test(f.text || ''))) {
    return 'VinSolutions says the session expired — sign back in, then hit Retry.';
  }
  return null;
}

export function classifyTaskType(str, map = VIN_MAP) {
  const s = String(str || '');
  if (!s.trim()) return 'unknown';
  // Call wins ties on purpose: calls are never automated.
  if (map.taskTypes.call.test(s)) return 'call';
  if (map.taskTypes.text.test(s)) return 'text';
  if (map.taskTypes.email.test(s)) return 'email';
  return 'unknown';
}

function firstMatch(text, re) {
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

// Text starting at the Vehicle Info / VOI section, stopping at a trade-in
// section so we don't grab the trade's stock number by mistake.
function vehicleSectionText(text, map) {
  const start = text.search(map.fields.vehicleSection);
  if (start < 0) return null;
  let section = text.slice(start, start + 2500);
  const trade = section.slice(20).search(map.fields.tradeSection);
  if (trade >= 0) section = section.slice(0, trade + 20);
  return section;
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

  const view = map.markers.dashboardView.test(text)
    ? 'customer-dashboard'
    : map.markers.leadInfoView.test(text)
      ? 'lead-info'
      : 'unknown';

  const vSection = vehicleSectionText(text, map);
  const vText = vSection || text;

  let stock = firstMatch(vText, f.stock);
  if (!isPlausibleStock(stock)) stock = null;
  let vin = firstMatch(vText, f.vin);
  if (!isPlausibleVin(vin)) vin = null;
  const parsedTitle = parseVehicleTitle(vText);

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

  const taskRaw = firstMatch(text, f.taskType);

  return {
    view,
    customerName,
    firstName: firstNameOf(customerName),
    email: firstMatch(text, new RegExp(`(${f.email.source})`, 'i')),
    phone: firstMatch(text, new RegExp(`(${f.phone.source})`)),
    manager: firstMatch(text, f.manager),
    task: { raw: taskRaw, type: classifyTaskType(taskRaw, map) },
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

// Task grid (My Tasks / Follow Ups): find the table whose header row looks
// like a task list and map its columns by header name.
export function parseTaskGrid(frames, map = VIN_MAP) {
  const { left } = splitPanes(frames, map);
  const sources = left.length ? left : frames;
  const h = map.taskGridHeaders;
  for (const frame of sources) {
    for (const table of frame.tables || []) {
      const headerIdx = table.findIndex(
        (row) => row.some((c) => h.customer.test(c)) && row.some((c) => h.type.test(c)),
      );
      if (headerIdx < 0) continue;
      const header = table[headerIdx];
      const col = (re) => header.findIndex((c) => re.test(c));
      const idx = {
        customer: col(h.customer),
        type: col(h.type),
        manager: col(h.manager),
        due: col(h.due),
        vehicle: col(h.vehicle),
        subject: col(h.subject),
      };
      const get = (row, k) => (idx[k] >= 0 ? (row[idx[k]] || '').trim() : '');
      const rows = table
        .slice(headerIdx + 1)
        .filter((row) => row.some((c) => c && c.trim()))
        .map((row) => {
          const typeText = `${get(row, 'type')} ${get(row, 'subject')}`;
          return {
            customer: get(row, 'customer'),
            typeRaw: get(row, 'type'),
            type: classifyTaskType(typeText, map),
            manager: get(row, 'manager'),
            due: get(row, 'due'),
            vehicle: get(row, 'vehicle'),
            subject: get(row, 'subject'),
          };
        })
        .filter((r) => r.customer);
      if (rows.length) return rows;
    }
  }
  return [];
}
