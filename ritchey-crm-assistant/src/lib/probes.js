// Functions injected into pages with chrome.scripting.executeScript.
// Chrome serializes them, so each one MUST be self-contained: no imports, no
// references to anything outside its own body.

// Snapshot of one VinSolutions frame: visible text + table cells.
export function probeFrame() {
  const path = [];
  try {
    let w = window;
    while (w) {
      path.unshift(w.name || '');
      if (w === w.parent) break;
      w = w.parent;
    }
  } catch (e) {
    // Cross-origin parent: we keep whatever we collected so far.
  }
  const body = document.body;
  const tables = Array.from(document.querySelectorAll('table'))
    .slice(0, 40)
    .map((t) =>
      Array.from(t.rows)
        .slice(0, 250)
        .map((r) => Array.from(r.cells).map((c) => (c.innerText || '').trim())),
    )
    .filter((t) => t.length > 1);

  // The lead panel carries the vehicle of interest as data: a "PageData" JSON
  // blob (price, miles, status…) and a small data island (VIN, stock #).
  let leadVehicle = null;
  try {
    const pdEl = document.querySelector('[data-pagedata]');
    const pd = pdEl ? JSON.parse(pdEl.getAttribute('data-pagedata')) : null;
    const v = pd && pd.LeadVehicle;
    if (v) {
      leadVehicle = {
        year: v.YearName || null,
        make: v.Make || null,
        model: v.Model || null,
        trim: v.TrimName || v.ModelTrim || null,
        stock: v.DealerStockNum || v.StockNumber || null,
        vin: v.VIN || null,
        internetPrice: v.InternetPrice || null,
        price: v.Price || null,
        miles: v.Mileage || null,
        status: v.Status || null,
        inventoryType: v.InventoryType || null,
        vdp: pd.VdpLink || null,
      };
    }
  } catch (e) {
    /* no PageData on this frame, or it isn't JSON */
  }
  if (!leadVehicle) {
    const island = document.querySelector('[id$="_dataIsland"][data-stocknumber], [data-inventoryid][data-vin]');
    if (island) {
      leadVehicle = { stock: island.getAttribute('data-stocknumber') || null, vin: island.getAttribute('data-vin') || null };
    }
  }

  return {
    name: window.name || '',
    path,
    url: location.href,
    title: document.title,
    isTop: window === window.top,
    text: body ? (body.innerText || '').slice(0, 200000) : '',
    tables,
    leadVehicle,
  };
}

// My Tasks list, read from the page structure (VinSolutions' React task
// table): one entry per customer row, with every task under it. The icon
// button's title ("Phone" / "Email" / "Text" / "Generic" / "Alert") is the
// task type VinSolutions itself assigns. Returns [] on frames without it.
export function probeTaskList() {
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const headers = Array.from(document.querySelectorAll('h3, [data-testid$="-title"]')).filter((h) => /\(\d+\)\s*$/.test(textOf(h)));
  const sectionFor = (row) => {
    let found = '';
    for (const h of headers) {
      // DOCUMENT_POSITION_FOLLOWING (4): the row comes after this header.
      if (h.compareDocumentPosition(row) & 4) found = textOf(h);
    }
    return found.replace(/\s*\(\d+\)\s*$/, '');
  };

  const out = [];
  const rows = Array.from(document.querySelectorAll('tr')).filter((tr) => tr.querySelector('[data-testid^="customer-name-"]'));
  for (const row of rows) {
    const nameCell = row.querySelector('[data-testid^="customer-name-"]');
    const link = nameCell.querySelector('a');
    const vehEl = nameCell.querySelector('[class*="VehicleText"]');
    let vehicleStruck = false;
    if (vehEl) {
      try {
        vehicleStruck = /line-through/.test(getComputedStyle(vehEl).textDecorationLine || getComputedStyle(vehEl).textDecoration || '');
      } catch (e) {
        /* no computed style (detached / parsed doc) */
      }
    }
    const cells = Array.from(row.cells).map(textOf);
    const detail = row.nextElementSibling && /expanded-row/.test(row.nextElementSibling.className) ? row.nextElementSibling : null;
    const tasks = [];
    if (detail) {
      for (const btn of detail.querySelectorAll('button[data-action="icon"]')) {
        const box = btn.parentElement;
        const meta = {};
        for (const s of box.querySelectorAll('[class*="DetailMeta"] > span')) {
          const label = textOf(s.querySelector('[class*="DetailLabel"]')).replace(/:$/, '');
          if (label) meta[label.toLowerCase()] = textOf(s).slice(textOf(s.querySelector('[class*="DetailLabel"]')).length).trim();
        }
        tasks.push({
          taskId: btn.getAttribute('data-task-id') || '',
          icon: btn.getAttribute('title') || btn.getAttribute('aria-label') || '',
          note: textOf(box.querySelector('[class*="DetailNote"]')),
          template: meta.template || '',
          assignedTo: meta['assigned to'] || '',
        });
      }
    }
    out.push({
      rowKey: row.getAttribute('data-row-key') || '',
      customer: textOf(link) || textOf(nameCell),
      vehicle: textOf(vehEl),
      vehicleStruck,
      status: cells[4] || '',
      section: sectionFor(row),
      tasks,
    });
  }
  return out;
}

// Which My Tasks tab is selected (All / Follow Ups / Overdue …) and what each
// section header says it holds, e.g. { "Overdue Tasks": 7 }.
export function probeTaskView() {
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const tab = document.querySelector('[role="tab"][aria-selected="true"][data-testid*="task-header-view-tabs"]');
  if (!tab && !document.querySelector('[data-testid^="task-page"]')) return null;
  const sections = {};
  for (const h of document.querySelectorAll('h3, [data-testid$="-title"]')) {
    const m = textOf(h).match(/^(.+?)\s*\((\d+)\)$/);
    if (m) sections[m[1]] = Number(m[2]);
  }
  return { activeTab: textOf(tab), sections };
}

// VinSolutions Inventory → Browse Inventory grid (Stock #, Yr, Make, Model,
// Trim, VIN, Miles, Age, Web $, Lot $). Returns null when not on that screen.
export function probeInventoryGrid() {
  const grid = document.querySelector('table.searchgrid, table[id$="SearchGrid"]');
  if (!grid || !/Inventory/i.test(location.href + (document.forms[0] ? document.forms[0].action : ''))) return null;
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const rows = Array.from(grid.rows);
  const headerIdx = rows.findIndex((r) => /stock/i.test(textOf(r)) && /vin/i.test(textOf(r)));
  if (headerIdx < 0) return { rows: [] };
  const header = Array.from(rows[headerIdx].cells).map((c) => textOf(c).toLowerCase());
  const col = (re) => header.findIndex((h) => re.test(h));
  const idx = {
    stock: col(/stock/), year: col(/^yr$|year/), make: col(/make/), model: col(/model/), trim: col(/trim/),
    vin: col(/^vin$/), miles: col(/miles|odom/), age: col(/^age$/), web: col(/web/), lot: col(/lot/),
  };
  const out = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const cells = Array.from(r.cells).map(textOf);
    if (cells.length < header.length - 2) continue;
    const get = (k) => (idx[k] >= 0 ? cells[idx[k]] || '' : '');
    if (!get('stock') && !get('vin')) continue;
    const details = r.querySelector('a[href*="VehicleDetails"]');
    out.push({
      stock: get('stock'), year: get('year'), make: get('make'), model: get('model'), trim: get('trim'),
      vin: get('vin'), miles: get('miles'), age: get('age'), web: get('web'), lot: get('lot'),
      detailsUrl: details ? details.href : '',
    });
  }
  const search = document.querySelector('input[id$="SearchData"]');
  const filter = document.querySelector('select[id$="LeftDropDown"]');
  return {
    rows: out,
    search: search ? search.value : '',
    filter: filter && filter.selectedIndex >= 0 ? textOf(filter.options[filter.selectedIndex]) : '',
  };
}

// Type a search into Browse Inventory (Pre-Owned – All, 100 per page) and
// submit it, exactly like pressing Enter in the search box. Read-only.
export function runInventorySearch(term) {
  const search = document.querySelector('input[id$="SearchData"]');
  if (!search || !document.forms[0]) return false;
  search.value = term;
  const filter = document.querySelector('select[id$="LeftDropDown"]');
  if (filter) {
    const opt = Array.from(filter.options).find((o) => /pre-owned\s*-\s*all/i.test(o.textContent));
    if (opt) filter.value = opt.value;
  }
  const size = document.querySelector('select[id$="PageSize"]');
  if (size) {
    const opt = Array.from(size.options).find((o) => o.textContent.trim() === '100');
    if (opt) size.value = opt.value;
  }
  const pd = document.getElementById('__PageData');
  if (pd) pd.value = '';
  if (typeof window.SetPageData === 'function') window.SetPageData('ResetSearchPanel', 'Y');
  document.forms[0].submit();
  return true;
}

// Click a customer's name in the My Tasks list so VinSolutions opens their
// dashboard. Navigation only — never touches Edit / Dismiss / send.
export function clickTaskCustomer(rowKey, customer) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const cells = Array.from(document.querySelectorAll('[data-testid^="customer-name-"]'));
  const hit =
    // Row ID and name must both match; fall back to the name alone.
    cells.find((c) => rowKey && c.closest('tr') && c.closest('tr').getAttribute('data-row-key') === rowKey && norm((c.querySelector('a') || c).textContent) === norm(customer)) ||
    cells.find((c) => norm((c.querySelector('a') || c).textContent) === norm(customer));
  const link = hit && hit.querySelector('a');
  if (!link) return false;
  link.click();
  return true;
}

// Full-page capture for building/fixing the VinSolutions adapters. Scripts
// and styles are dropped; PII scrubbing happens in the side panel afterward.
export function captureFrame() {
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('script, style, link, noscript, svg, img').forEach((n) => n.remove());
  return {
    name: window.name || '',
    url: location.href,
    title: document.title,
    isTop: window === window.top,
    html: clone.outerHTML.slice(0, 1500000),
    text: document.body ? (document.body.innerText || '').slice(0, 200000) : '',
  };
}

// Vehicle cards from an inventory results page. Works on the live page (via
// executeScript) and on a DOMParser document (pass it in as `root`).
export function extractVehicleCards(root) {
  const doc = root || document;
  // Join text nodes with spaces: dealer markup often has no whitespace between
  // elements ("24123A</span><span>SALE PRICE"), and DOMParser documents have
  // no layout for innerText to lean on.
  const textOf = (n) => {
    const parts = [];
    const walker = (n.ownerDocument || doc).createTreeWalker(n, 4 /* SHOW_TEXT */);
    let t;
    while ((t = walker.nextNode())) {
      const p = t.parentNode && t.parentNode.nodeName;
      if (p === 'SCRIPT' || p === 'STYLE' || p === 'NOSCRIPT') continue;
      const s = t.nodeValue.trim();
      if (s) parts.push(s);
    }
    return parts.join(' ').replace(/\s+/g, ' ');
  };
  const hrefOf = (n) => {
    const a = n.querySelector('a[href*="vdp" i], a[href*="/used" i], a[href*="detail" i], a[href]');
    return a ? a.getAttribute('href') : '';
  };

  let nodes = Array.from(doc.querySelectorAll('[data-vin]'));
  if (nodes.length) {
    // Same VIN can appear on nested elements; keep the outermost per VIN.
    nodes = nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n) && o.getAttribute('data-vin') === n.getAttribute('data-vin')));
  } else {
    const sels = [
      '.vehicle-card', '.srp-vehicle', '.srpVehicle', '.vehicle-item', '.vehicleCard',
      '.inventory-item', '.hproduct', '[itemtype*="Car"]', '[itemtype*="Vehicle"]',
    ];
    for (const s of sels) {
      try {
        nodes = nodes.concat(Array.from(doc.querySelectorAll(s)));
      } catch (e) {
        /* invalid selector in this engine */
      }
    }
    nodes = nodes.filter((n, i) => nodes.indexOf(n) === i);
    // Keep the innermost candidates so a list wrapper doesn't swallow cards.
    nodes = nodes.filter((n) => !nodes.some((o) => o !== n && n.contains(o)));
  }

  const cards = nodes.slice(0, 200).map((n) => ({
    text: textOf(n).slice(0, 6000),
    data: Object.assign({}, n.dataset),
    href: hrefOf(n),
  }));
  const jsonld = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))
    .slice(0, 60)
    .map((s) => s.textContent || '');
  const body = doc.body;
  return {
    cards,
    jsonld,
    bodyText: body ? textOf(body).slice(0, 100000) : '',
  };
}
