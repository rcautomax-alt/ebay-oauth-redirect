// vAuto Price Adjuster — planner page
/* global XLSX, PricingEngine, ExportParser */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const money = n => (n == null ? '' : '$' + Math.round(n).toLocaleString());
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const VAUTO_URLS = ['*://*.vauto.com/*', '*://*.coxautoinc.com/*'];

const state = {
  settings: null,
  history: [],
  rows: [],          // { v, rec, selected, manual, status, msg, log }
  fileName: '',
  wholesaleCols: [],
  running: false,
  stopRequested: false,
  paused: null
};

// ---------- Storage ----------

async function loadStorage() {
  const { settings, history } = await chrome.storage.local.get(['settings', 'history']);
  state.settings = { ...PricingEngine.DEFAULT_SETTINGS, delaySec: 2, ...(settings || {}) };
  state.history = history || [];
}
const saveSettings = () => chrome.storage.local.set({ settings: state.settings });
const saveHistory = () => chrome.storage.local.set({ history: state.history });

// ---------- vAuto tab connection ----------

async function findVautoTab() {
  const tabs = await chrome.tabs.query({ url: VAUTO_URLS });
  if (!tabs.length) return null;
  tabs.sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
  return tabs[0];
}

async function sendToVauto(msg) {
  const tab = await findVautoTab();
  if (!tab) throw new Error('No vAuto tab is open. Open your vAuto Pricing page in another tab.');
  try {
    return await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
  } catch (e) {
    // Tab was open before the extension loaded — inject and retry once
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-script.js'] });
    return await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
  }
}

async function refreshVautoStatus() {
  const pill = $('#vautoStatus');
  try {
    const r = await sendToVauto({ action: 'ping' });
    pill.textContent = 'vAuto tab: connected';
    pill.className = 'pill ok';
    pill.title = r.url;
  } catch (e) {
    pill.textContent = 'vAuto tab: not found';
    pill.className = 'pill bad';
    pill.title = e.message;
  }
}

// ---------- File import ----------

async function handleFile(file) {
  state.fileName = file.name;
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  const { vehicles, missingCols, wholesaleCols } = ExportParser.parseRows(rows, new Date());
  state.wholesaleCols = wholesaleCols;

  const recent = recentToolChanges();
  state.rows = vehicles.map(v => {
    const rec = PricingEngine.recommend(v, state.settings);
    const prior = recent[v.stock];
    if (prior) rec.notes.push(`Extension already changed this ${new Date(prior.ts).toLocaleDateString()} (${money(prior.old)} → ${money(prior.new)})`);
    return { v, rec, selected: rec.status === 'ready' && !prior, manual: null, status: 'pending', msg: '', log: [] };
  });

  $('#fileInfo').innerHTML = `Loaded <b>${esc(file.name)}</b> — ${vehicles.length} vehicles` +
    (missingCols.length ? ` <span class="warn">· Missing columns: ${esc(missingCols.join(', '))}</span>` : '');
  $('#planArea').hidden = false;
  updateSyncCheck(vehicles);
  renderAll();
}

function recentToolChanges(days = 7) {
  const cutoff = Date.now() - days * 86400000;
  const out = {};
  for (const h of state.history) if (h.ts >= cutoff) out[h.stock] = h;
  return out;
}

// ---------- Plan helpers ----------

function finalPrice(r) {
  return r.manual != null ? r.manual : (r.rec.status === 'ready' ? r.rec.suggested : null);
}
function isApplicable(r) {
  const p = finalPrice(r);
  return p != null && PricingEngine.validateManualPrice(r.v, p, state.settings).length === 0;
}

// ---------- Rendering ----------

function renderAll() {
  renderSummary();
  renderPlan();
  renderWholesale();
  renderHistory();
}

function renderSummary() {
  const rows = state.rows;
  const ready = rows.filter(isApplicable);
  const sel = ready.filter(r => r.selected);
  const total = sel.reduce((s, r) => s + (r.v.price - finalPrice(r)), 0);
  const flagged = rows.filter(r => r.rec.status === 'flagged' && r.manual == null);
  const under = rows.filter(r => r.v.markup != null && r.v.markup < 0);
  const done = rows.filter(r => r.status === 'done').length;
  $('#summary').innerHTML = `
    <b>${rows.length}</b> vehicles · <b>${sel.length}</b> selected to change ·
    total reductions <b>${money(total)}</b> · <b>${done}</b> applied ·
    <b>${under.length}</b> under cost (see Wholesale Report)<br>
    ${flagged.length ? `<span class="warn">Flagged for review: ${flagged.map(r =>
      `${esc(r.v.stock)} (${esc(r.rec.flags.join(', '))})`).join('; ')}</span>` : 'No vehicles flagged.'}`;
}

function statusCell(r) {
  const label = {
    pending: '', running: '⏳ Working…', paused: '⏸ Waiting for you',
    done: '✅ ' + r.msg, failed: '❌ ' + r.msg, skipped: '⏭ ' + r.msg
  }[r.status] || '';
  if (!r.log.length) return esc(label);
  return `<details><summary>${esc(label)}</summary>${r.log.map(l => `<div>${esc(l)}</div>`).join('')}</details>`;
}

function renderPlan() {
  const q = $('#search').value.trim().toLowerCase();
  const tbody = $('#planTable tbody');
  tbody.innerHTML = '';
  for (const r of state.rows) {
    const { v, rec } = r;
    if (q && !(`${v.stock} ${v.vehicle}`.toLowerCase().includes(q))) continue;
    const p = finalPrice(r);
    const errs = p != null ? PricingEngine.validateManualPrice(v, p, state.settings) : [];
    const tr = document.createElement('tr');
    tr.className = [
      rec.status === 'flagged' && r.manual == null ? 'flagged' : '',
      v.markup != null && v.markup < 0 ? 'undercost' : '',
      { done: 'done', failed: 'failed', running: 'running', paused: 'running' }[r.status] || ''
    ].join(' ');
    tr.innerHTML = `
      <td><input type="checkbox" class="sel" ${r.selected ? 'checked' : ''} ${isApplicable(r) && r.status !== 'done' ? '' : 'disabled'}></td>
      <td>${esc(v.stock)}</td>
      <td>${esc(v.vehicle)}</td>
      <td class="num">${v.age ?? ''}</td>
      <td class="num">${v.daysSupply ?? ''}</td>
      <td class="num">${v.likeMine ?? '—'}</td>
      <td class="num">${v.marketPct != null ? v.marketPct.toFixed(1) + '%' : '—'}</td>
      <td class="num">${v.markup != null ? money(v.markup) : '—'}</td>
      <td class="num">${money(v.price)}</td>
      <td class="num"><input class="sugg ${errs.length ? 'bad' : ''}" value="${p ?? ''}" title="${esc(errs.join(', '))}" ${r.status === 'done' ? 'disabled' : ''}></td>
      <td class="num chg">${p != null ? '-' + money(v.price - p) : ''}</td>
      <td class="reason">${esc(r.manual != null ? 'Manual price' : rec.reason)}${rec.notes.map(n => `<span class="note">${esc(n)}</span>`).join('')}</td>
      <td class="status">${statusCell(r)}</td>`;
    tr.querySelector('.sel').addEventListener('change', e => { r.selected = e.target.checked; renderSummary(); });
    tr.querySelector('.sugg').addEventListener('change', e => {
      const val = parseInt(e.target.value.replace(/[^0-9]/g, ''), 10);
      const auto = rec.status === 'ready' ? rec.suggested : null;
      r.manual = Number.isFinite(val) && val !== auto ? val : null;
      r.selected = isApplicable(r);
      renderSummary(); renderPlan();
    });
    tbody.appendChild(tr);
  }
}

function underCostRows() {
  return state.rows.filter(r => r.v.markup != null && r.v.markup < 0)
    .sort((a, b) => a.v.markup - b.v.markup);
}

function renderWholesale() {
  const rows = underCostRows();
  $('#wsCount').textContent = rows.length || '';
  const extra = state.wholesaleCols;
  $('#wsNote').innerHTML = extra.length
    ? `Auction/MMR columns found in export: <b>${esc(extra.join(', '))}</b>`
    : `<span class="warn">No MMR / auction columns in this export.</span> If your vAuto view has an MMR or auction column, add it to the Pricing view before exporting and it will show up here automatically.`;
  $('#wsTable thead').innerHTML = `<tr><th>Stock</th><th>Vehicle</th><th>VIN</th><th>Age</th><th>Miles</th>
    <th>Cost</th><th>Price</th><th>Under cost by</th><th>Book</th><th>Mkt %</th><th>Days Supply</th>
    <th>Suggested</th>${extra.map(c => `<th>${esc(c)}</th>`).join('')}</tr>`;
  $('#wsTable tbody').innerHTML = rows.map(r => {
    const { v } = r;
    return `<tr><td>${esc(v.stock)}</td><td>${esc(v.vehicle)}</td><td>${esc(v.vin)}</td>
      <td class="num">${v.age}</td><td class="num">${v.odometer != null ? v.odometer.toLocaleString() : ''}</td>
      <td class="num">${money(v.cost)}</td><td class="num">${money(v.price)}</td>
      <td class="num chg">${money(-v.markup)}</td><td class="num">${money(v.book)}</td>
      <td class="num">${v.marketPct != null ? v.marketPct.toFixed(1) + '%' : '—'}</td>
      <td class="num">${v.daysSupply ?? ''}</td><td class="num">${money(finalPrice(r))}</td>
      ${extra.map(c => `<td class="num">${esc(typeof v.wholesale[c] === 'number' ? money(v.wholesale[c]) : v.wholesale[c] ?? '')}</td>`).join('')}</tr>`;
  }).join('') || '<tr><td colspan="12" class="muted">No vehicles under cost in this export.</td></tr>';
}

function renderHistory() {
  const tbody = $('#histTable tbody');
  tbody.innerHTML = [...state.history].reverse().map(h => `
    <tr><td>${new Date(h.ts).toLocaleString()}</td><td>${esc(h.stock)}</td><td>${esc(h.vehicle)}</td>
    <td class="num">${money(h.old)}</td><td class="num">${money(h.new)}</td><td>${esc(h.result)}</td>
    <td>${h.sync ? `<span class="tag ${h.sync.cls}">${esc(h.sync.text)}</span> <span class="muted">${esc(h.sync.when || '')}</span>` : ''}</td></tr>`)
    .join('') || '<tr><td colspan="7" class="muted">No changes saved yet.</td></tr>';
}

// Compare saved changes against a newer export
function updateSyncCheck(vehicles) {
  const byStock = Object.fromEntries(vehicles.map(v => [v.stock, v]));
  const when = `${state.fileName}, ${new Date().toLocaleDateString()}`;
  for (const h of state.history) {
    const v = byStock[h.stock];
    if (!v) continue; // not in this (filtered) export — keep the last check
    if (v.price === h.new) h.sync = { cls: 'ok', text: 'Confirmed: export shows new price', when };
    else if (v.price === h.old) h.sync = { cls: 'pend', text: 'Export still shows OLD price', when };
    else h.sync = { cls: 'bad', text: `Export shows ${money(v.price)} (changed again?)`, when };
  }
  saveHistory();
}

// ---------- Applying changes ----------

function setRunning(on) {
  state.running = on;
  $('#stop').hidden = !on;
  $('#applyAll').disabled = on;
  $('#testOne').disabled = on;
}

function resultMessage(res) {
  if (res.status === 'saved') return 'Saved & verified';
  if (res.status === 'fixed') return 'Saved — disposition/publish was fixed';
  if (res.status === 'already') return 'Already at this price';
  return res.status;
}

function recordHistory(r, res) {
  state.history.push({
    ts: Date.now(), stock: r.v.stock, vin: r.v.vin, vehicle: r.v.vehicle,
    old: r.v.price, new: finalPrice(r), result: resultMessage(res), log: res.log
  });
  if (state.history.length > 2000) state.history = state.history.slice(-2000);
  saveHistory();
}

// Handle one content-script response. Returns true to keep going.
function handleResult(r, res) {
  r.log = res.log || [];
  if (res.status === 'paused') {
    r.status = 'paused';
    state.paused = r;
    $('#pauseText').textContent =
      `${r.v.stock} ${r.v.vehicle}: price typed in as ${money(finalPrice(r))} — check the vAuto tab ` +
      `(field outlined orange, "${res.saveLabel || 'Save'}" button outlined green).`;
    $('#pauseBar').hidden = false;
    renderPlan();
    return false;
  }
  if (['saved', 'fixed', 'already'].includes(res.status)) {
    r.status = 'done'; r.msg = resultMessage(res); r.selected = false;
    recordHistory(r, res);
    renderAll();
    return true;
  }
  // error
  r.log.push(`[${res.step}] ${res.error}`);
  if (res.step === 'find' || res.step === 'check') { r.status = 'skipped'; r.msg = res.error; renderAll(); return true; }
  r.status = 'failed'; r.msg = res.error;
  renderAll();
  return false;
}

async function applyOne(r, pauseBeforeSave) {
  r.status = 'running'; r.msg = ''; renderPlan();
  try {
    const res = await sendToVauto({
      action: 'applyPrice', stock: r.v.stock, expectedOld: r.v.price,
      newPrice: finalPrice(r), pauseBeforeSave
    });
    return handleResult(r, res || { status: 'error', step: 'unknown', error: 'No response from vAuto tab' });
  } catch (e) {
    return handleResult(r, { status: 'error', step: 'connect', error: e.message });
  }
}

async function applySelected() {
  const queue = state.rows.filter(r => r.selected && isApplicable(r) && r.status !== 'done');
  if (!queue.length) return alert('Nothing selected to apply.');
  const total = queue.reduce((s, r) => s + r.v.price - finalPrice(r), 0);
  if (!confirm(`Apply ${queue.length} price changes in vAuto (total ${money(total)} in reductions)?\n\nKeep the vAuto tab open on the Pricing page. You can press Stop at any time.`)) return;

  setRunning(true);
  state.stopRequested = false;
  let i = 0;
  for (const r of queue) {
    if (state.stopRequested) break;
    i++;
    document.title = `(${i}/${queue.length}) vAuto Price Adjuster`;
    const keepGoing = await applyOne(r, false);
    if (!keepGoing) {
      alert(`Stopped on ${r.v.stock} ${r.v.vehicle}:\n\n${r.msg}\n\nFix it in vAuto if needed, then press "Apply selected" again to continue with the rest.`);
      break;
    }
    await sleep((state.settings.delaySec || 0) * 1000);
  }
  document.title = 'vAuto Price Adjuster';
  setRunning(false);
}

async function testFirst() {
  const r = state.rows.find(x => x.selected && isApplicable(x) && x.status !== 'done');
  if (!r) return alert('Nothing selected to test.');
  setRunning(true);
  await applyOne(r, true);
  if (r.status !== 'paused') setRunning(false);
}

async function confirmPaused(save) {
  const r = state.paused;
  if (!r) return;
  $('#pauseBar').hidden = true;
  state.paused = null;
  try {
    if (save) {
      r.status = 'running'; renderPlan();
      const res = await sendToVauto({ action: 'confirmSave', stock: r.v.stock });
      handleResult(r, res);
    } else {
      await sendToVauto({ action: 'cancelPaused' });
      r.status = 'pending'; r.log = []; renderPlan();
    }
  } catch (e) {
    handleResult(r, { status: 'error', step: 'connect', error: e.message });
  }
  setRunning(false);
}

// ---------- Exports ----------

function downloadCsv(name, header, rows) {
  const cell = x => {
    const s = String(x ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map(r => r.map(cell).join(',')).join('\n');
  downloadBlob(name, new Blob([csv], { type: 'text/csv' }));
}
function downloadBlob(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const today = () => new Date().toISOString().slice(0, 10);

function exportPlan() {
  downloadCsv(`price-plan-${today()}.csv`,
    ['Stock', 'Vehicle', 'Age', 'Days Supply', 'Like Mine', 'Mkt %', 'Markup', 'Current Price', 'Suggested Price', 'Change', 'Reason', 'Notes', 'Selected', 'Status'],
    state.rows.map(r => {
      const p = finalPrice(r);
      return [r.v.stock, r.v.vehicle, r.v.age, r.v.daysSupply, r.v.likeMine,
        r.v.marketPct != null ? r.v.marketPct.toFixed(1) : '', r.v.markup, r.v.price, p ?? '',
        p != null ? r.v.price - p : '', r.manual != null ? 'Manual price' : r.rec.reason,
        r.rec.notes.join(' | '), r.selected ? 'Y' : '', r.status === 'pending' ? '' : `${r.status} ${r.msg}`];
    }));
}

function exportWholesale() {
  const extra = state.wholesaleCols;
  downloadCsv(`under-cost-wholesale-${today()}.csv`,
    ['Stock', 'Vehicle', 'VIN', 'Age', 'Miles', 'Cost', 'Price', 'Under Cost By', 'Book', 'Mkt %', 'Days Supply', 'Suggested', ...extra],
    underCostRows().map(({ v, ...r }) => [v.stock, v.vehicle, v.vin, v.age, v.odometer, v.cost, v.price, -v.markup,
      v.book, v.marketPct != null ? v.marketPct.toFixed(1) : '', v.daysSupply, finalPrice({ v, ...r }) ?? '',
      ...extra.map(c => v.wholesale[c] ?? '')]));
}

function exportHistory() {
  downloadCsv(`price-change-log-${today()}.csv`,
    ['Saved', 'Stock', 'VIN', 'Vehicle', 'Old', 'New', 'Result', 'Latest export check'],
    state.history.map(h => [new Date(h.ts).toLocaleString(), h.stock, h.vin, h.vehicle, h.old, h.new, h.result,
      h.sync ? `${h.sync.text} (${h.sync.when})` : '']));
}

// Fallback: hand the approved list to Claude in Chrome for Phase 2
async function copyPrompt() {
  const sel = state.rows.filter(r => r.selected && isApplicable(r));
  const lines = sel.map(r => `| ${r.v.stock} | ${r.v.vehicle} | ${money(r.v.price)} | ${money(finalPrice(r))} |`);
  const text = `APPROVED vAuto PRICE CHANGES — EXECUTE (Phase 2)

The plan below is already approved. For each vehicle, one at a time:
1. Open the vehicle record and go to its Pricing tab.
2. Update the List Price field to the New Price.
3. Save the vehicle.
4. Re-open it and verify (a) List Price shows the new value and (b) Disposition is still "Used - Retail" (or whatever it was) and "Publish this vehicle" is still checked. If Disposition shows "Wholesale", set it back to "Used - Retail", re-check "Publish this vehicle", re-apply the price and save.
5. Use the vehicle's own Pricing screen as the source of truth, not the grid (it lags).

| Stock | Vehicle | Current | New Price |
|---|---|---|---|
${lines.join('\n')}

When done, give me a recap table (Stock, Vehicle, Current, New, Saved?) and call out anything that needed a fix.`;
  await navigator.clipboard.writeText(text);
  alert(`Copied ${sel.length} vehicles as a Claude in Chrome prompt.`);
}

async function snapshot() {
  try {
    const res = await sendToVauto({ action: 'snapshot' });
    downloadBlob(`vauto-snapshot-${today()}.html`, new Blob([res.html], { type: 'text/html' }));
  } catch (e) {
    alert('Could not take snapshot: ' + e.message);
  }
}

// ---------- Settings ----------

function fillSettings() {
  const s = state.settings;
  $('#setUnique').value = s.uniqueBelow;
  $('#setCommodity').value = s.commodityAbove;
  $('#setModels').value = s.commodityModels.join('\n');
  $('#setDelay').value = s.delaySec;
}

function readSettings() {
  state.settings.uniqueBelow = Number($('#setUnique').value) || 0;
  state.settings.commodityAbove = Number($('#setCommodity').value) || 0;
  state.settings.commodityModels = $('#setModels').value.split('\n').map(x => x.trim()).filter(Boolean);
  state.settings.delaySec = Number($('#setDelay').value) || 0;
}

function recalc() {
  for (const r of state.rows) {
    if (r.status === 'done') continue;
    r.rec = PricingEngine.recommend(r.v, state.settings);
    r.selected = isApplicable(r) && r.selected;
  }
  renderAll();
}

// ---------- Wiring ----------

function wire() {
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
  }));

  const drop = $('#drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]).catch(err => alert(err.message));
  });
  $('#file').addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0]).catch(err => alert(err.message));
    e.target.value = '';
  });

  $('#search').addEventListener('input', renderPlan);
  $('#checkAll').addEventListener('change', e => {
    state.rows.forEach(r => { if (isApplicable(r) && r.status !== 'done') r.selected = e.target.checked; });
    renderSummary(); renderPlan();
  });
  $('#applyAll').addEventListener('click', applySelected);
  $('#testOne').addEventListener('click', testFirst);
  $('#stop').addEventListener('click', () => {
    state.stopRequested = true;
    sendToVauto({ action: 'stop' }).catch(() => {});
  });
  $('#confirmSave').addEventListener('click', () => confirmPaused(true));
  $('#cancelSave').addEventListener('click', () => confirmPaused(false));
  $('#exportPlan').addEventListener('click', exportPlan);
  $('#copyPrompt').addEventListener('click', copyPrompt);
  $('#exportWholesale').addEventListener('click', exportWholesale);
  $('#printWholesale').addEventListener('click', () => window.print());
  $('#exportHistory').addEventListener('click', exportHistory);
  $('#clearHistory').addEventListener('click', () => {
    if (confirm('Clear the whole change log?')) { state.history = []; saveHistory(); renderHistory(); }
  });
  $('#saveSettings').addEventListener('click', () => {
    readSettings(); saveSettings(); recalc();
    $('#settingsMsg').textContent = 'Saved — plan recalculated.';
  });
  $('#resetSettings').addEventListener('click', () => {
    state.settings = { ...PricingEngine.DEFAULT_SETTINGS, delaySec: 2 };
    fillSettings(); saveSettings(); recalc();
    $('#settingsMsg').textContent = 'Defaults restored.';
  });
  $('#snapshot').addEventListener('click', snapshot);
}

(async function init() {
  await loadStorage();
  fillSettings();
  wire();
  renderHistory();
  refreshVautoStatus();
  setInterval(refreshVautoStatus, 15000);
})();
