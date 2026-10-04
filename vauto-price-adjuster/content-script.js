// vAuto Price Adjuster — content script (runs inside the vAuto tab)
// Applies ONE price change at a time and verifies it, following the Phase 2
// steps from Rick's prompt:
//   open vehicle -> Pricing tab -> set List Price -> Save -> re-open ->
//   verify price + Disposition + "Publish this vehicle" -> fix if flipped.
//
// Safety rules baked in:
//   * Rows are matched on the EXACT stock number (no partial matches).
//   * Buttons are matched on EXACT text. Anything containing Delete, Cancel,
//     Wholesale or Remove is never clicked while saving.
//   * If anything looks off, it stops and reports instead of guessing.

if (!window.__vautoPriceAdjusterLoaded) {
  window.__vautoPriceAdjusterLoaded = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const money = n => '$' + Number(n).toLocaleString();
  const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const FORBIDDEN = /delete|cancel|wholesale|remove|unpublish/i;

  let stopRequested = false;
  let paused = null; // { stock, newPrice, saveBtn, field, original } while waiting for Rick

  class StepError extends Error {
    constructor(step, message) { super(message); this.step = step; }
  }

  // ---------- DOM helpers ----------

  // Top document plus any same-origin iframes (vAuto uses frames on some screens)
  function allDocs(doc = document, out = []) {
    out.push(doc);
    for (const f of doc.querySelectorAll('iframe, frame')) {
      try { if (f.contentDocument) allDocs(f.contentDocument, out); } catch (e) { /* cross-origin */ }
    }
    return out;
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const win = el.ownerDocument.defaultView;
    const st = win.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  async function waitFor(fn, timeout = 10000, every = 250) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (stopRequested) throw new StepError('stopped', 'Stopped by user');
      const v = fn();
      if (v) return v;
      await sleep(every);
    }
    return null;
  }

  function parseMoney(s) {
    const m = String(s || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? Math.round(parseFloat(m[0])) : null;
  }

  // ---------- Finding the vehicle row ----------

  function findStockRows(stock) {
    const re = new RegExp(`(^|[\\s#:])${escapeRegex(stock)}(?=$|\\s)`, 'i');
    const rows = new Set();
    for (const doc of allDocs()) {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!re.test(clean(node.nodeValue))) continue;
        const row = rowFor(node.parentElement);
        if (row && visible(row)) rows.add(row);
      }
    }
    return [...rows];
  }

  // Smallest ancestor that holds exactly ONE vehicle (fixes the old bug where
  // the whole page container was treated as a row).
  function rowFor(el) {
    let cur = el;
    while (cur && cur !== cur.ownerDocument.body) {
      const ymm = cur.querySelectorAll('.YearMakeModel').length;
      if (ymm === 1) return cur;
      if (ymm > 1) return null;
      if (cur.matches('tr, [role="row"]') && cur.querySelector('a')) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function findRow(stock) {
    const rows = findStockRows(stock);
    if (rows.length === 0) throw new StepError('find', `Stock ${stock} is not on the current vAuto page (check filters/paging)`);
    if (rows.length > 1) throw new StepError('find', `Stock ${stock} matched ${rows.length} rows — stopping to be safe`);
    return rows[0];
  }

  function readGridPrice(row) {
    for (const f of row.querySelectorAll('.ColumnField, td, [role="gridcell"]')) {
      const t = clean(f.textContent);
      if (/\$\s?[\d,]{4,}/.test(t) && /%/.test(t)) return parseMoney(t.match(/\$\s?[\d,]+/)[0]);
    }
    return null;
  }

  // ---------- Opening the vehicle / Pricing tab ----------

  function clickEl(el) {
    el.scrollIntoView({ block: 'center' });
    const opts = { bubbles: true, cancelable: true, view: el.ownerDocument.defaultView };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  async function openVehicle(stock) {
    const row = findRow(stock);
    const link = row.querySelector('.YearMakeModel a, a.YearMakeModel') ||
      row.querySelector('.YearMakeModel') || row.querySelector('a');
    if (!link) throw new StepError('open', `No clickable vehicle link in the row for ${stock}`);
    clickEl(link);

    // Pricing tab (if the vehicle opens on a different tab)
    const tab = await waitFor(() => findPricingTab(), 6000);
    if (tab && !isActiveTab(tab)) { clickEl(tab); await sleep(800); }

    const field = await waitFor(() => findListPriceField(), 12000);
    if (!field) throw new StepError('open', 'Opened the vehicle but could not find the "List Price" field');
    return field;
  }

  function findPricingTab() {
    for (const doc of allDocs()) {
      const cands = doc.querySelectorAll('[role="tab"], .x-tab, .tab, li a, li, a, span, button');
      for (const el of cands) {
        if (clean(el.textContent).toLowerCase() === 'pricing' && visible(el)) return el;
      }
    }
    return null;
  }

  function isActiveTab(el) {
    const tab = el.closest('[role="tab"], li, .x-tab') || el;
    return tab.getAttribute('aria-selected') === 'true' ||
      /active|selected|x-tab-active/.test(tab.className || '');
  }

  // Find the input/select that belongs to a visible label like "List Price"
  function findFieldByLabel(labelRe, selector) {
    for (const doc of allDocs()) {
      for (const lab of doc.querySelectorAll('label, td, th, span, div, dt')) {
        if (lab.children.length > 3) continue;
        if (!labelRe.test(clean(lab.textContent)) || !visible(lab)) continue;
        if (lab.htmlFor) {
          const byFor = doc.getElementById(lab.htmlFor);
          if (byFor && byFor.matches(selector) && visible(byFor)) return byFor;
        }
        let scope = lab;
        for (let i = 0; i < 4 && scope; i++) {
          const f = [...scope.querySelectorAll(selector)].find(visible);
          if (f) return f;
          // also look at following siblings (label | input layouts)
          let sib = scope.nextElementSibling;
          for (let j = 0; j < 3 && sib; j++, sib = sib.nextElementSibling) {
            const s = sib.matches(selector) ? sib : [...sib.querySelectorAll(selector)].find(visible);
            if (s && visible(s)) return s;
          }
          scope = scope.parentElement;
        }
      }
    }
    return null;
  }

  const findListPriceField = () =>
    findFieldByLabel(/^list price\s*:?$/i, 'input:not([type=hidden]):not([type=checkbox]):not([type=radio])');
  const findDispositionField = () =>
    findFieldByLabel(/^disposition\s*:?$/i, 'select, input:not([type=hidden]):not([type=checkbox])');
  const findPublishBox = () => findFieldByLabel(/^publish this vehicle\s*:?$/i, 'input[type=checkbox]');

  function fieldText(el) {
    if (!el) return null;
    if (el.tagName === 'SELECT') return clean(el.options[el.selectedIndex]?.text);
    return clean(el.value);
  }

  function readState() {
    const priceEl = findListPriceField();
    const dispEl = findDispositionField();
    const pubEl = findPublishBox();
    return {
      price: priceEl ? parseMoney(priceEl.value) : null,
      disposition: fieldText(dispEl),
      publish: pubEl ? pubEl.checked : null,
      found: { price: !!priceEl, disposition: !!dispEl, publish: !!pubEl }
    };
  }

  // ---------- Editing ----------

  // Works with React/Angular/ExtJS inputs that ignore a plain .value = x
  function setInputValue(input, value) {
    const proto = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    input.focus();
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    if (input.select) input.select();
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '8' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    input.blur();
  }

  function setCheckbox(box, checked) {
    if (box.checked !== checked) clickEl(box);
  }

  // The modal that holds the price field = nearest ancestor with a Save button
  function findSaveButton(field) {
    const exact = ['save & close', 'save and close', 'save'];
    let scope = field.parentElement;
    while (scope) {
      const btns = [...scope.querySelectorAll(
        'button, a, input[type=button], input[type=submit], [role="button"], .x-btn')]
        .filter(visible);
      for (const want of exact) {
        const hit = btns.find(b => {
          const t = clean(b.value || b.textContent).toLowerCase();
          return t === want && !FORBIDDEN.test(t);
        });
        if (hit) return hit;
      }
      if (scope === scope.ownerDocument.body) break;
      scope = scope.parentElement;
    }
    return null;
  }

  function findCloseButton(field) {
    let scope = field && field.parentElement;
    while (scope) {
      const btns = [...scope.querySelectorAll('button, a, [role="button"], .x-btn, .x-tool-close')].filter(visible);
      const hit = btns.find(b => /^(close|cancel|×|x)$/i.test(clean(b.textContent || b.getAttribute('aria-label') || '')) ||
        /close/i.test(b.getAttribute('aria-label') || '') || b.classList.contains('x-tool-close'));
      if (hit && !/delete|wholesale|remove/i.test(clean(hit.textContent))) return hit;
      if (scope === scope.ownerDocument.body) break;
      scope = scope.parentElement;
    }
    return null;
  }

  function highlight(el, color) {
    if (!el) return;
    el.style.outline = `3px solid ${color}`;
    el.style.outlineOffset = '2px';
  }

  async function clickSave(field) {
    const btn = findSaveButton(field);
    if (!btn) throw new StepError('save', 'Could not find a "Save" / "Save & Close" button next to List Price');
    const label = clean(btn.value || btn.textContent);
    if (FORBIDDEN.test(label)) throw new StepError('save', `Refusing to click "${label}"`);
    clickEl(btn);
    // Wait for the modal to close (or the field to go away / be re-rendered)
    await waitFor(() => !field.isConnected || !visible(field), 10000);
    await sleep(1200);
    return label;
  }

  async function closeVehicle() {
    const field = findListPriceField();
    if (!field) return;
    const btn = findCloseButton(field);
    if (btn) { clickEl(btn); await waitFor(() => !visible(field), 5000); await sleep(500); }
  }

  // ---------- Main operation ----------

  async function applyPrice({ stock, expectedOld, newPrice, pauseBeforeSave }) {
    const log = [];
    const note = m => log.push(m);
    stopRequested = false;

    const row = findRow(stock);
    const gridPrice = readGridPrice(row);
    if (gridPrice != null) note(`Grid shows ${money(gridPrice)}`);

    // 1. Open vehicle + Pricing tab
    const field = await openVehicle(stock);
    const original = readState();
    note(`Opened: List Price ${money(original.price)}, Disposition "${original.disposition ?? '?'}", Publish ${original.publish}`);

    if (original.price === newPrice) {
      await closeVehicle();
      return { status: 'already', log, original, final: original };
    }
    if (original.price !== expectedOld) {
      await closeVehicle();
      throw new StepError('check', `List Price is ${money(original.price)}, not ${money(expectedOld)} from the export — someone may have changed it. Skipped.`);
    }
    if (original.disposition && /wholesale/i.test(original.disposition)) {
      await closeVehicle();
      throw new StepError('check', `Disposition is already "${original.disposition}" — not touching it.`);
    }

    // 2. Set the price
    setInputValue(field, newPrice);
    await sleep(400);
    if (parseMoney(field.value) !== newPrice) {
      throw new StepError('edit', `Typed ${newPrice} but the field shows "${field.value}"`);
    }
    note(`Entered ${money(newPrice)}`);

    // Test mode: stop here so Rick can eyeball it before saving
    if (pauseBeforeSave) {
      const btn = findSaveButton(field);
      highlight(field, '#ff7a00');
      highlight(btn, '#16a34a');
      paused = { stock, newPrice, field, original, log };
      return { status: 'paused', log, saveLabel: btn ? clean(btn.value || btn.textContent) : null };
    }
    return finishSave({ stock, newPrice, field, original, log });
  }

  async function finishSave({ stock, newPrice, field, original, log }) {
    const note = m => log.push(m);
    paused = null;

    // 3. Save
    const label = await clickSave(field);
    note(`Clicked "${label}"`);

    // 4. Re-open and verify (detail screen is the source of truth, not the grid)
    await sleep(1500);
    await openVehicle(stock);
    let final = readState();
    note(`Re-opened: List Price ${money(final.price)}, Disposition "${final.disposition ?? '?'}", Publish ${final.publish}`);

    const problems = verify(final, newPrice, original);
    let fixed = false;
    if (problems.length) {
      note('Problem: ' + problems.join('; ') + ' — attempting fix');
      await fixVehicle(original, newPrice, note);
      fixed = true;
      await sleep(1500);
      await openVehicle(stock);
      final = readState();
      note(`Re-checked: List Price ${money(final.price)}, Disposition "${final.disposition ?? '?'}", Publish ${final.publish}`);
      const still = verify(final, newPrice, original);
      if (still.length) {
        await closeVehicle();
        throw new StepError('verify', 'STILL WRONG after fix: ' + still.join('; ') + ' — needs your attention');
      }
    }
    await closeVehicle();
    return { status: fixed ? 'fixed' : 'saved', log, original, final };
  }

  function verify(state, newPrice, original) {
    const p = [];
    if (state.price !== newPrice) p.push(`List Price is ${money(state.price)} (expected ${money(newPrice)})`);
    if (original.disposition && state.disposition !== original.disposition) {
      p.push(`Disposition changed to "${state.disposition}" (was "${original.disposition}")`);
    }
    if (original.publish === true && state.publish !== true) p.push('"Publish this vehicle" got unchecked');
    return p;
  }

  async function fixVehicle(original, newPrice, note) {
    const field = findListPriceField();
    if (!field) throw new StepError('fix', 'Could not find List Price to fix');
    const disp = findDispositionField();
    if (original.disposition && disp && fieldText(disp) !== original.disposition) {
      if (disp.tagName !== 'SELECT') {
        throw new StepError('fix', `Disposition flipped to "${fieldText(disp)}" and it's not a normal dropdown — fix it by hand (set back to "${original.disposition}", check Publish).`);
      }
      const opt = [...disp.options].find(o => clean(o.text) === original.disposition);
      if (!opt) throw new StepError('fix', `Can't find "${original.disposition}" in the Disposition list`);
      setInputValue(disp, opt.value);
      note(`Set Disposition back to "${original.disposition}"`);
      await sleep(600);
    }
    const pub = findPublishBox();
    if (original.publish === true && pub && !pub.checked) {
      setCheckbox(pub, true);
      note('Re-checked "Publish this vehicle"');
      await sleep(300);
    }
    const f2 = findListPriceField();
    setInputValue(f2, newPrice);
    await sleep(400);
    const label = await clickSave(f2);
    note(`Clicked "${label}" (fix)`);
  }

  // ---------- Diagnostics: snapshot of the page for troubleshooting ----------

  function snapshot() {
    const parts = allDocs().map((d, i) => {
      const clone = d.documentElement.cloneNode(true);
      clone.querySelectorAll('script, style, link, svg, img, noscript').forEach(n => n.remove());
      clone.querySelectorAll('input').forEach(n => n.setAttribute('data-value', n.value));
      return `<!-- frame ${i}: ${d.location.href} -->\n` + clone.outerHTML;
    });
    return parts.join('\n\n').slice(0, 5_000_000);
  }

  // ---------- Messaging ----------

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    const run = async () => {
      switch (req.action) {
        case 'ping': return { ok: true, url: location.href };
        case 'stop': stopRequested = true; return { ok: true };
        case 'locate': {
          const found = {};
          for (const s of req.stocks) found[s] = findStockRows(s).length;
          return { found };
        }
        case 'applyPrice': return await applyPrice(req);
        case 'confirmSave': {
          if (!paused || paused.stock !== req.stock) throw new StepError('save', 'Nothing is waiting to be saved');
          return await finishSave(paused);
        }
        case 'cancelPaused': {
          paused = null;
          await closeVehicle();
          return { ok: true };
        }
        case 'snapshot': return { html: snapshot() };
        default: return { error: 'unknown action' };
      }
    };
    run().then(sendResponse).catch(e =>
      sendResponse({ status: 'error', step: e.step || 'unknown', error: e.message }));
    return true; // async response
  });
}
