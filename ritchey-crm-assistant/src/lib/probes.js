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
  return {
    name: window.name || '',
    path,
    url: location.href,
    title: document.title,
    isTop: window === window.top,
    text: body ? (body.innerText || '').slice(0, 200000) : '',
    tables,
  };
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
