import { DEFAULT_SETTINGS, feeTotal } from '../config/defaults.js';
import { money, parseMoney, escapeHtml, todayKey, firstNameOf, nameKey } from '../lib/format.js';
import { computePricing } from '../lib/pricing.js';
import { parseCustomer, parseTaskList, tasksFromDom, pickTask, detectSessionProblem, splitPanes } from '../lib/vin-parser.js';
import { parseVehicleTitle, normalizeStock } from '../lib/vehicle.js';
import { probeFrame, probeTaskList, clickTaskCustomer, captureFrame, extractVehicleCards } from '../lib/probes.js';
import {
  stockSearchUrl, modelSearchUrl, stockOrVinUrl, vehiclesFromExtraction, findVehicle, pickAlternatives,
} from '../lib/inventory.js';
import { evaluate, canDraft, unacknowledged } from '../lib/rules.js';
import { buildDrafts } from '../lib/templates.js';
import { sharedVoi, upsert, toCsv } from '../lib/queue.js';
import { withRetry, sleep, SessionError } from '../lib/retry.js';
import { scrubPii } from '../lib/scrub.js';
import { STARTERS, buildFreestylePrompt, parseClaudeReply, emailTextToHtml } from '../lib/freestyle.js';

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- state ---

const state = {
  settings: { ...DEFAULT_SETTINGS },
  tasks: [],
  pqOnly: true, // task list filter: only customers with a Send Out Price task
  expectedCustomer: null,
  pickedTask: null, // the task you clicked in the list
  record: null, // flat, editable copy of the parsed customer
  notesExcerpt: '',
  view: '',
  userSaysSold: false,
  lang: 'en',
  channels: { sms: true, email: true },
  acks: {},
  inventory: null, // { found, vehicle, source, modelResults, tried }
  alternatives: [],
  asking: null,
  discount: null,
  pricing: null,
  drafts: null,
  draftKind: null, // 'template' | 'freestyle'
  queue: [],
};

const storage = {
  async loadSettings() {
    const { settings } = await chrome.storage.sync.get('settings');
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  },
  saveSettings: (s) => chrome.storage.sync.set({ settings: s }),
  async loadQueue() {
    const key = `queue:${todayKey()}`;
    const got = await chrome.storage.local.get(key);
    return got[key] || [];
  },
  saveQueue: (q) => chrome.storage.local.set({ [`queue:${todayKey()}`]: q }),
  saveWorking() {
    const { settings, queue, ...rest } = state;
    return chrome.storage.local.set({ working: rest });
  },
  async loadWorking() {
    const { working } = await chrome.storage.local.get('working');
    return working || null;
  },
};

// --------------------------------------------------------------- status ---

let retryAction = null;
function setStatus(msg, kind = '', retry = null) {
  const el = $('#status');
  retryAction = retry;
  if (!msg) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = escapeHtml(msg) + (retry ? ' <button id="btn-retry">Retry</button>' : '');
  if (retry) $('#btn-retry').onclick = () => retryAction?.();
}

async function busy(label, fn) {
  const buttons = document.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  setStatus(label);
  try {
    return await fn();
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    renderDraftGate();
  }
}

// ------------------------------------------------------ VinSolutions I/O ---

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab.');
  return tab;
}

async function probeAllFrames(tabId) {
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: probeFrame });
  return results.filter((r) => r.result).map((r) => ({ frameId: r.frameId, ...r.result }));
}

// Read every frame, retrying while frames are still loading. Session
// problems stop immediately so you can log back in and hit Retry.
// expectName: after clicking a customer in My Tasks, keep polling until their
// dashboard has actually loaded (the old customer can linger for a second).
async function readVinSolutions({ needRight, expectName = null }) {
  const tab = await activeTab();
  return withRetry(
    async () => {
      let frames;
      try {
        frames = await probeAllFrames(tab.id);
      } catch (err) {
        throw new Error(`Couldn't read this tab (${err.message}). Is VinSolutions the active tab?`);
      }
      const problem = detectSessionProblem(frames);
      if (problem) throw new SessionError(problem);
      if (needRight) {
        const { right } = splitPanes(frames);
        const len = right.reduce((n, f) => n + (f.text || '').length, 0);
        if (len < 80) throw new Error('Customer panel is empty or still loading.');
      }
      if (expectName) {
        const shown = parseCustomer(frames).customerName;
        if (nameKey(shown) !== nameKey(expectName)) throw new Error(`Waiting for ${expectName}'s dashboard to load…`);
      }
      return frames;
    },
    {
      tries: expectName ? 10 : 4,
      baseMs: 800,
      maxMs: 1500,
      onRetry: (err, n) => setStatus(`${err.message} (${n})`),
    },
  );
}

// ------------------------------------------------------------ inventory ---

async function extractViaFetch(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return vehiclesFromExtraction(extractVehicleCards(doc), state.settings.priceLabels, url);
}

// Some dealer sites build the results with JavaScript, so a plain fetch sees
// nothing. Fallback: open the page in a background tab and read it live.
async function extractViaTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await new Promise((resolve) => {
      const done = (id, info) => {
        if (id === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(done);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(done);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }, 15000);
    });
    for (let i = 0; i < 5; i++) {
      await sleep(1500);
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractVehicleCards });
      const vehicles = vehiclesFromExtraction(r.result || {}, state.settings.priceLabels, url);
      if (vehicles.length) return vehicles;
    }
    return [];
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function loadResults(url, tried) {
  tried.push(url);
  let vehicles = [];
  try {
    vehicles = await withRetry(() => extractViaFetch(url), { tries: 2 });
  } catch (err) {
    console.warn('fetch failed, trying tab', err);
  }
  if (!vehicles.length) vehicles = await extractViaTab(url);
  return vehicles;
}

async function lookupInventory({ stock, vin, model }) {
  const base = state.settings.inventoryBase;
  const tried = [];
  // 1. The exact VIN / stock search VinSolutions' "View VDP" button uses.
  const exact = vin || stock;
  if (exact && state.settings.inventorySearchAll) {
    const url = stockOrVinUrl(state.settings.inventorySearchAll, exact);
    const hit = findVehicle(await loadResults(url, tried), { stock, vin });
    if (hit) return { found: true, vehicle: hit, source: url, modelResults: null, tried };
  }
  // 2. Used-inventory search by stock #.
  if (stock) {
    const url = stockSearchUrl(base, stock);
    const hit = findVehicle(await loadResults(url, tried), { stock, vin });
    if (hit) return { found: true, vehicle: hit, source: url, modelResults: null, tried };
  }
  // Stock search sometimes comes up empty for units that ARE in stock —
  // always double-check with a model search before calling it gone.
  if (model) {
    const url = modelSearchUrl(base, model);
    const results = await loadResults(url, tried);
    const hit = findVehicle(results, { stock, vin });
    return { found: !!hit, vehicle: hit, source: hit ? url : null, modelResults: results, tried };
  }
  return { found: false, vehicle: null, source: null, modelResults: null, tried };
}

// --------------------------------------------------------------- flows ---

async function readTasks() {
  await busy('Reading task list…', async () => {
    try {
      const tab = await activeTab();
      const frames = await readVinSolutions({ needRight: false });
      // Preferred: the real task table (icon = task type). Fallback: text.
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: probeTaskList });
      const rows = results.flatMap((r) => r.result || []);
      state.tasks = rows.length ? tasksFromDom(rows) : parseTaskList(frames);
      state.pickedTask = null;
      renderTasks();
      const n = (type) => state.tasks.filter((t) => t.type === type).length;
      if (state.tasks.length) {
        const pq = groupCustomers(state.tasks).filter((c) => c.pqTasks.length).length;
        setStatus(`${pq} customers need a Send Out Price. (${state.tasks.length} tasks: ${n('email') + n('text')} email/text, ${n('call')} calls for you, ${n('other')} internal.)`, 'ok');
      } else {
        setStatus("Couldn't find tasks on this screen. Open My Tasks, or use Capture Page and send it over so the reader can be tuned.", 'error');
      }
    } catch (err) {
      setStatus(err.message, 'error', readTasks);
    }
  });
}

function recordFromParsed(p) {
  const picked = state.pickedTask;
  // The Customer Dashboard doesn't always show a Vehicle Info section; fall
  // back to the vehicle + stock # from the task you clicked.
  if (picked && !p.voi.stock && !p.voi.title && picked.vehicle) {
    const t = parseVehicleTitle(picked.vehicle);
    p.voi.title = t?.title || picked.vehicle;
    p.voi.model = t?.model || '';
    p.voi.stock = picked.stock;
  }
  return {
    customerName: p.customerName || state.expectedCustomer || '',
    firstName: p.firstName || firstNameOf(state.expectedCustomer),
    email: p.email || '',
    phone: p.phone || '',
    taskType: p.task.type,
    manager: p.manager || '',
    assignedTo: p.assignedTo || '',
    vehicleTitle: p.voi.title || '',
    model: p.voi.model || '',
    stock: p.voi.stock || '',
    vin: p.voi.vin || '',
    crmStatus: p.voi.status,
    notesCount: p.notes.count,
  };
}

async function readCustomer({ expectName = null } = {}) {
  await busy('Reading customer…', async () => {
    try {
      const frames = await readVinSolutions({ needRight: true, expectName });
      const parsed = parseCustomer(frames);
      // The task you clicked in the list is the one you're working, so its
      // type and assignment beat whatever the detail screen shows first.
      const picked = state.pickedTask;
      if (picked && nameKey(picked.customer) === nameKey(parsed.customerName || picked.customer)) {
        parsed.task.type = picked.type;
        parsed.assignedTo = picked.assignedTo || parsed.assignedTo;
      }

      Object.assign(state, {
        record: recordFromParsed(parsed),
        notesExcerpt: parsed.notes.excerpt,
        view: parsed.view,
        acks: {},
        inventory: null,
        alternatives: [],
        asking: null,
        discount: null,
        pricing: null,
        drafts: null,
        userSaysSold: false,
      });
      $('#user-sold').checked = false;
      // Don't let a freestyle message meant for the last customer carry over.
      state.draftKind = null;
      $('#fs-instruction').value = '';
      $('#fs-reply').value = '';
      $('#fs-prompt').textContent = '';
      renderCustomer();
      const result = reevaluate();
      setStatus('Customer read. Review the fields — anything wrong, just fix it.', 'ok');

      if (result.mode === 'quote' && (state.record.stock || state.record.model)) await runLookup();
      else if (result.mode === 'alternatives' && state.record.model) await runAlternatives();
      $('#discount').focus();
    } catch (err) {
      setStatus(err.message, 'error', () => readCustomer());
    }
  });
}

// One entry per customer, with all of their tasks.
function groupCustomers(tasks) {
  const map = new Map();
  for (const t of tasks) {
    const key = t.rowKey || nameKey(t.customer);
    if (!map.has(key)) {
      map.set(key, { key, customer: t.customer, vehicle: t.vehicle, stock: t.stock, rowKey: t.rowKey, section: t.section, vehicleStruck: t.vehicleStruck, sharedWith: t.sharedWith || [], tasks: [] });
    }
    map.get(key).tasks.push(t);
  }
  return [...map.values()].map((c) => {
    const pqTasks = c.tasks.filter((t) => t.isPriceQuote && (t.type === 'email' || t.type === 'text'));
    return { ...c, pqTasks, channels: [...new Set(pqTasks.map((t) => t.type))] };
  });
}

// Click the customer in My Tasks, wait for their dashboard, read it.
async function workCustomer(c) {
  const best = pickTask(c.tasks);
  state.pickedTask = { ...best, customer: c.customer };
  state.expectedCustomer = c.customer;
  // The VinSolutions tasks say which channels to use (email and/or text);
  // with no price-quote task, default to both.
  const ch = c.channels.length ? c.channels : ['email', 'text'];
  state.channels = { email: ch.includes('email'), sms: ch.includes('text') };
  $('#ch-email').checked = state.channels.email;
  $('#ch-sms').checked = state.channels.sms;
  renderTasks();

  let clicked = false;
  try {
    const tab = await activeTab();
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: clickTaskCustomer,
      args: [c.rowKey || '', c.customer],
    });
    clicked = res.some((r) => r.result === true);
  } catch (err) {
    console.warn('click failed', err);
  }
  if (clicked) {
    await readCustomer({ expectName: c.customer });
  } else {
    await navigator.clipboard.writeText(c.customer).catch(() => {});
    setStatus(`Couldn't open ${c.customer} automatically — name copied. Open them in VinSolutions, then Read Customer.`, 'error');
  }
}

async function runLookup() {
  const r = state.record;
  setStatus(`Checking ritcheybuickgmc.com for stock #${r.stock || '—'}…`);
  try {
    state.inventory = await lookupInventory({ stock: r.stock, vin: r.vin, model: r.model });
    if (state.inventory.vehicle?.price) state.asking = state.inventory.vehicle.price;
    setStatus(state.inventory.found ? 'Found on the website.' : 'Not found on the website (stock and model search).', state.inventory.found ? 'ok' : 'error');
  } catch (err) {
    state.inventory = null;
    setStatus(`Website lookup failed: ${err.message}`, 'error', () => busy('Retrying…', runLookup));
  }
  renderInventory();
  renderPricing();
  reevaluate();
}

async function runAlternatives() {
  const r = state.record;
  if (!r.model) {
    setStatus('Type a model to search for alternatives.', 'error');
    return;
  }
  setStatus(`Searching the website for other ${r.model}s…`);
  try {
    let results = state.inventory?.modelResults;
    if (!results) {
      state.inventory = await lookupInventory({ stock: r.stock, vin: r.vin, model: r.model });
      results = state.inventory.modelResults || [];
    }
    state.alternatives = pickAlternatives(results, {
      excludeStock: r.stock,
      excludeVin: r.vin,
      targetPrice: state.asking || state.inventory?.vehicle?.price || null,
      window: Number(state.settings.altPriceWindow) || 5000,
      limit: state.settings.altLimit || 3,
    }).map((a) => ({ ...a, selected: true }));
    setStatus(state.alternatives.length ? `Found ${state.alternatives.length} alternatives.` : 'No alternatives found for that model — your call on this one.', state.alternatives.length ? 'ok' : 'error');
  } catch (err) {
    setStatus(`Alternatives search failed: ${err.message}`, 'error', () => busy('Retrying…', runAlternatives));
  }
  renderInventory();
  renderAlternatives();
  reevaluate();
}

function sharedListFor(r) {
  const fromList = state.tasks
    .filter((t) => normalizeStock(t.stock) && normalizeStock(t.stock) === normalizeStock(r.stock) && nameKey(t.customer) !== nameKey(r.customerName))
    .map((t) => t.customer);
  return [...new Set([...sharedVoi(state.queue, r), ...fromList])];
}

function currentEvaluation() {
  const r = state.record;
  const shared = sharedListFor(r);
  const record = {
    customerName: r.customerName,
    manager: r.manager,
    assignedTo: r.assignedTo,
    task: { type: r.taskType, template: state.pickedTask?.template || null, isPriceQuote: state.pickedTask ? !!state.pickedTask.isPriceQuote : null },
    voi: { stock: r.stock, vin: r.vin, status: r.crmStatus },
    notes: { count: r.notesCount === '' || r.notesCount === null ? null : Number(r.notesCount) },
  };
  return evaluate(record, {
    settings: state.settings,
    userSaysSold: state.userSaysSold,
    sharedWith: shared,
    inventory: state.inventory,
    expectedCustomer: state.expectedCustomer,
  });
}

function reevaluate() {
  if (!state.record) return null;
  const result = currentEvaluation();
  state.evaluation = result;
  renderFlags(result);
  $('#pricing-section').hidden = result.mode !== 'quote';
  $('#alts-section').hidden = result.mode !== 'alternatives';
  $('#inventory-section').hidden = result.mode === 'skip';
  $('#draft-section').hidden = result.mode === 'skip';
  renderDraftGate();
  storage.saveWorking();
  return result;
}

function generateDrafts() {
  const result = state.evaluation;
  const r = state.record;
  try {
    let pricing = null;
    if (result.mode === 'quote') {
      pricing = computePricing({ asking: state.asking, discount: state.discount, fees: state.settings.fees });
      state.pricing = pricing;
    }
    const alts = state.alternatives.filter((a) => a.selected);
    state.drafts = buildDrafts({
      mode: result.mode,
      lang: state.lang,
      customer: { firstName: r.firstName },
      vehicleTitle: r.vehicleTitle,
      stock: r.stock,
      pricing,
      alternatives: alts,
      settings: state.settings,
      followUp: Number(r.notesCount) > 0,
    });
    state.draftKind = 'template';
    renderDrafts();
    setStatus('Drafts ready. Review, tweak, copy — nothing gets sent from here.', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

function freestylePrompt() {
  return buildFreestylePrompt({
    instruction: $('#fs-instruction').value,
    record: state.record,
    settings: state.settings,
    lang: state.lang,
    channels: state.channels,
    pricing: $('#fs-pricing').checked ? state.pricing : null,
    notesExcerpt: state.notesExcerpt,
  });
}

async function copyFreestyle() {
  if (!$('#fs-instruction').value.trim()) {
    setStatus('Type what you want to say first.', 'error');
    return;
  }
  const prompt = freestylePrompt();
  $('#fs-prompt').textContent = prompt;
  try {
    await navigator.clipboard.writeText(prompt);
    setStatus('Request copied. Paste it into Claude, then paste the reply back here.', 'ok');
  } catch (err) {
    setStatus(`Copy failed (${err.message}) — copy it from the preview instead.`, 'error');
  }
}

function useFreestyleReply() {
  const reply = parseClaudeReply($('#fs-reply').value);
  if (!reply.sms && !reply.email) {
    setStatus("Couldn't find a text or email in that reply.", 'error');
    return;
  }
  state.drafts = {
    sms: reply.sms,
    subject: reply.subject,
    emailHtml: emailTextToHtml(reply.email),
  };
  state.draftKind = 'freestyle';
  // Freestyle is your call, so it isn't held back by the task checks — the
  // flags above are still there to read.
  $('#draft-section').hidden = false;
  renderDrafts();
  setStatus('Freestyle drafts loaded below. Review, tweak, copy — nothing gets sent from here.', 'ok');
}

async function saveToQueue() {
  const r = state.record || {};
  const p = state.pricing || {};
  const entry = {
    savedAt: new Date().toLocaleTimeString(),
    customerName: r.customerName,
    phone: r.phone,
    email: r.email,
    taskType: r.taskType,
    manager: r.manager,
    assignedTo: r.assignedTo,
    vehicle: r.vehicleTitle,
    stock: r.stock,
    vin: r.vin,
    crmStatus: r.crmStatus,
    mode: state.draftKind === 'freestyle' ? 'freestyle' : state.evaluation?.mode || '',
    asking: p.asking ?? '',
    discount: p.discount ?? '',
    special: p.special ?? '',
    withFees: p.withFees ?? '',
    sharedWith: sharedListFor(r),
    flags: (state.evaluation?.flags || []).filter((f) => f.level !== 'info').map((f) => f.code),
    freestyleAsk: state.draftKind === 'freestyle' ? $('#fs-instruction').value.trim() : '',
    status: 'drafted',
    sms: $('#sms-out').value,
    emailSubject: $('#email-subject').value,
    emailHtml: $('#email-out').innerHTML,
  };
  state.queue = upsert(state.queue, entry);
  await storage.saveQueue(state.queue);
  renderQueue();
  renderTasks();
  setStatus(`Saved ${r.customerName} to today's queue.`, 'ok');
}

async function capturePage() {
  await busy('Capturing page…', async () => {
    try {
      const tab = await activeTab();
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: captureFrame });
      const names = [state.record?.customerName, state.expectedCustomer].filter(Boolean);
      const frames = results
        .filter((r) => r.result)
        .map((r) => ({
          frameId: r.frameId,
          name: r.result.name,
          url: scrubPii(r.result.url.replace(/\?.*$/, '?[QUERY]'), names),
          title: r.result.title,
          isTop: r.result.isTop,
          text: scrubPii(r.result.text, names),
          html: scrubPii(r.result.html, names),
        }));
      const blob = new Blob([JSON.stringify({ capturedAt: new Date().toISOString(), frames }, null, 1)], { type: 'application/json' });
      download(blob, `vinsolutions-capture-${Date.now()}.json`);
      setStatus(`Captured ${frames.length} frames (emails/phones/addresses scrubbed). Skim it before sending.`, 'ok');
    } catch (err) {
      setStatus(`Capture failed: ${err.message}`, 'error');
    }
  });
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ------------------------------------------------------------- render ---

function renderTasks() {
  const sec = $('#tasks-section');
  sec.hidden = !state.tasks.length;
  const all = groupCustomers(state.tasks);
  const pqCount = all.filter((c) => c.pqTasks.length).length;
  // Price-quote customers first, then anything else with an email/text task.
  const rank = (c) => (c.pqTasks.length ? 0 : c.tasks.some((t) => t.type === 'email' || t.type === 'text') ? 1 : 2);
  const shown = all.filter((c) => !state.pqOnly || c.pqTasks.length).sort((a, b) => rank(a) - rank(b));
  $('#tasks-count').textContent = `(${pqCount} Send Out Price of ${all.length} customers)`;
  $('#pq-only').checked = state.pqOnly;
  const icon = { call: '📞', email: '✉️', text: '💬', other: '⚙️', unknown: '?' };
  const picked = state.pickedTask && nameKey(state.pickedTask.customer);
  $('#tasks-list').innerHTML = shown.length
    ? shown
        .map((c) => {
          const i = all.indexOf(c);
          const saved = state.queue.some((q) => nameKey(q.customerName) === nameKey(c.customer));
          const taskIcons = c.tasks
            .map((t) => `<span class="tag ${t.type}" title="${escapeHtml(`${t.description || ''} ${t.template ? `· ${t.template}` : ''}`)}">${icon[t.type] || '?'}${t.isPriceQuote ? '💲' : ''}</span>`)
            .join('');
          const other = c.tasks.filter((t) => !t.isPriceQuote && (t.type === 'email' || t.type === 'text'));
          return `<li class="${rank(c) === 2 ? 'call' : ''} ${picked === nameKey(c.customer) ? 'picked' : ''}">
            <span class="task-main">
              <span class="name" data-cust="${i}">${escapeHtml(c.customer || '(no name)')}</span>
              ${saved ? '<span class="tag ok">✓ drafted</span>' : ''}
              ${c.sharedWith.length ? `<span class="tag" title="Also VOI for ${escapeHtml(c.sharedWith.join(', '))}">🔥 shared: ${escapeHtml(c.sharedWith.join(', '))}</span>` : ''}
              ${c.vehicleStruck ? '<span class="tag call">sold?</span>' : ''}
              <br><span class="hint">${escapeHtml(c.vehicle || 'no vehicle')} ${c.stock ? `[${escapeHtml(c.stock)}]` : '— no stock #'} · ${escapeHtml(c.section)}</span>
              <br>${taskIcons}
              ${c.pqTasks.length ? `<span class="hint">Send Out Price by ${c.channels.join(' + ')}</span>` : ''}
              ${other.length ? `<span class="hint">· other template: ${escapeHtml(other.map((t) => t.template || t.description).join('; '))}</span>` : ''}
            </span>
          </li>`;
        })
        .join('')
    : '<li class="hint">No Send Out Price tasks. Uncheck the filter to see everything.</li>';
}

function renderCustomer() {
  $('#customer-section').hidden = !state.record;
  if (!state.record) return;
  for (const input of document.querySelectorAll('[data-field]')) {
    const v = state.record[input.dataset.field];
    input.value = v === null || v === undefined ? '' : v;
  }
  $('#view-badge').textContent = state.view;
  $('#notes-excerpt').textContent = state.notesExcerpt || '(nothing found)';
  $('#lang').value = state.lang;
}

function renderFlags(result) {
  $('#flags').innerHTML = result.flags
    .map((f) => {
      const ack =
        f.level === 'confirm'
          ? `<label><input type="checkbox" data-ack="${f.code}" ${state.acks[f.code] ? 'checked' : ''}> Got it — continue</label>`
          : '';
      return `<li class="${f.level}">${escapeHtml(f.message)}${ack}</li>`;
    })
    .join('');
}

function renderInventory() {
  const inv = state.inventory;
  const el = $('#inventory-result');
  if (!inv) {
    el.innerHTML = '<p class="hint">Not checked yet.</p>';
    return;
  }
  const v = inv.vehicle;
  const tried = inv.tried.map((u) => `<a href="${escapeHtml(u)}" target="_blank">${escapeHtml(u.replace(/^https?:\/\/[^/]+/, ''))}</a>`).join('<br>');
  el.innerHTML = v
    ? `<p class="ok">✓ ${escapeHtml(v.title || 'Vehicle')} — Stock # ${escapeHtml(v.stock || '?')} — SALE PRICE <b>${money(v.price) || 'not readable'}</b></p>
       ${v.url ? `<p><a href="${escapeHtml(v.url)}" target="_blank">Open VDP</a></p>` : ''}
       <p class="hint">Checked: ${tried}</p>`
    : `<p class="hint warn">Not found by stock # or model search.</p><p class="hint">Checked: ${tried || '—'}</p>`;
}

function renderPricing() {
  $('#asking').value = state.asking ? money(state.asking) : '';
  $('#discount').value = state.discount !== null && state.discount !== undefined ? money(state.discount) : '';
  updatePricingOut();
}

function updatePricingOut() {
  const out = $('#pricing-out');
  try {
    const p = computePricing({ asking: state.asking, discount: state.discount, fees: state.settings.fees });
    state.pricing = p;
    out.innerHTML = `
      <div><span>Stock #</span><b>${escapeHtml(state.record?.stock || '')}</b></div>
      <div><span>MSRP / Asking</span><b>${money(p.asking)}</b></div>
      <div><span>Manager Discount</span><b>-${money(p.discount)}</b></div>
      <div><span>Manager Special Price</span><b>${money(p.special)}</b></div>
      <div class="total"><span>Price with Fees (+${money(p.fees)})</span><b>${money(p.withFees)}</b></div>`;
  } catch (err) {
    state.pricing = null;
    out.innerHTML = `<span class="hint">${escapeHtml(state.asking ? err.message : 'Need an asking price.')}</span>`;
  }
}

function renderAlternatives() {
  $('#alts-list').innerHTML = state.alternatives.length
    ? state.alternatives
        .map(
          (a, i) => `<li><input type="checkbox" data-alt="${i}" ${a.selected ? 'checked' : ''}>
            <span>${escapeHtml(a.title || 'Vehicle')} — #${escapeHtml(a.stock || '?')} — <b>${money(a.price)}</b>
            ${a.inWindow ? '' : '<span class="tag">outside price window</span>'}
            ${a.url ? ` <a href="${escapeHtml(a.url)}" target="_blank">VDP</a>` : ''}</span></li>`,
        )
        .join('')
    : '<li class="hint">None yet.</li>';
}

function renderDraftGate() {
  const btn = $('#btn-draft');
  const msg = $('#draft-blocked');
  if (!state.evaluation) return;
  const result = state.evaluation;
  const pending = unacknowledged(result.flags, state.acks);
  let reason = '';
  if (result.mode === 'ask') reason = "Not enough to draft on — fix the fields above or handle this one yourself.";
  else if (pending.length) reason = `Tick the ${pending.length} "Got it" box(es) above first.`;
  else if (result.mode === 'quote' && !state.pricing) reason = 'Enter the asking price and your discount.';
  else if (!state.channels.sms && !state.channels.email) reason = 'Pick text, email, or both.';
  btn.disabled = !!reason || !canDraft(result, state.acks);
  msg.hidden = !reason;
  msg.textContent = reason;
}

function renderDrafts() {
  const d = state.drafts;
  $('#drafts').hidden = !d;
  if (!d) return;
  $('#sms-box').hidden = !state.channels.sms;
  $('#email-box').hidden = !state.channels.email;
  $('#sms-out').value = d.sms;
  $('#sms-len').textContent = `${d.sms.length} chars`;
  $('#email-subject').value = d.subject;
  $('#email-out').innerHTML = d.emailHtml;
}

function renderQueue() {
  $('#queue-count').textContent = `(${state.queue.length})`;
  $('#queue-list').innerHTML = state.queue.length
    ? state.queue
        .map(
          (q, i) => `<li><span class="who">${q.mode === 'freestyle' ? '✍️ ' : ''}<b>${escapeHtml(q.customerName || '(no customer read)')}</b> — ${escapeHtml(q.vehicle || '')} ${q.stock ? `#${escapeHtml(q.stock)}` : ''}
            ${q.withFees ? ` — ${money(q.withFees)}` : ''} ${q.sharedWith?.length ? '🔥' : ''}</span>
            <button data-reopen="${i}">Open</button></li>`,
        )
        .join('')
    : '<li class="hint">Nothing saved yet today.</li>';
}

function renderSettings() {
  for (const input of document.querySelectorAll('[data-setting]')) {
    const v = state.settings[input.dataset.setting];
    if (input.type === 'checkbox') input.checked = !!v;
    else input.value = Array.isArray(v) ? v.join(', ') : v ?? '';
  }
  const f = state.settings.fees;
  $('#fees-line').textContent = `Fees added to every deal: ${f.map((x) => `${x.label} ${money(x.amount)}`).join(' + ')} = ${money(feeTotal(f))}`;
}

// ------------------------------------------------------------- events ---

async function copyRich(html, text) {
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    }),
  ]);
}

function wire() {
  $('#btn-tasks').onclick = readTasks;
  $('#btn-customer').onclick = readCustomer;
  $('#btn-capture').onclick = capturePage;
  $('#btn-lookup').onclick = () => busy('Checking website…', runLookup);
  $('#btn-alts').onclick = () => busy('Searching…', runAlternatives);
  $('#btn-draft').onclick = generateDrafts;
  $('#btn-save').onclick = saveToQueue;
  $('#btn-fs-copy').onclick = copyFreestyle;
  $('#btn-fs-use').onclick = useFreestyleReply;
  $('#fs-starters').innerHTML = STARTERS.map((s, i) => `<button data-starter="${i}">${escapeHtml(s.label)}</button>`).join('');
  $('#fs-starters').onclick = (e) => {
    const i = e.target.dataset.starter;
    if (i === undefined) return;
    const box = $('#fs-instruction');
    box.value = (box.value ? `${box.value.trimEnd()} ` : '') + STARTERS[Number(i)].text;
    box.focus();
  };

  $('#tasks-list').onclick = async (e) => {
    const i = e.target.dataset.cust;
    if (i === undefined) return;
    const c = groupCustomers(state.tasks)[Number(i)];
    const contact = c.tasks.some((t) => t.type === 'email' || t.type === 'text');
    if (!contact) {
      setStatus(
        c.tasks.some((t) => t.type === 'call')
          ? `${c.customer}: call task only — that one's yours.`
          : `${c.customer}: internal tasks only, nothing to send.`,
        'error',
      );
      return;
    }
    await workCustomer(c);
  };
  $('#pq-only').onchange = (e) => {
    state.pqOnly = e.target.checked;
    renderTasks();
  };

  $('#record-form').oninput = (e) => {
    const field = e.target.dataset.field;
    if (!field || !state.record) return;
    state.record[field] = e.target.value;
    if (field === 'customerName' && !state.record.firstName) state.record.firstName = firstNameOf(e.target.value);
    if (field === 'stock' || field === 'vin' || field === 'model') state.inventory = null;
    reevaluate();
  };

  $('#flags').onchange = (e) => {
    const code = e.target.dataset.ack;
    if (!code) return;
    state.acks[code] = e.target.checked;
    renderDraftGate();
  };

  $('#user-sold').onchange = (e) => {
    state.userSaysSold = e.target.checked;
    const result = reevaluate();
    if (result?.mode === 'alternatives' && !state.alternatives.length && state.record.model) busy('Searching…', runAlternatives);
  };
  $('#lang').onchange = (e) => (state.lang = e.target.value);
  $('#ch-sms').onchange = (e) => {
    state.channels.sms = e.target.checked;
    renderDraftGate();
    renderDrafts();
  };
  $('#ch-email').onchange = (e) => {
    state.channels.email = e.target.checked;
    renderDraftGate();
    renderDrafts();
  };

  const onMoney = (key) => (e) => {
    state[key] = parseMoney(e.target.value);
    updatePricingOut();
    renderDraftGate();
  };
  $('#asking').oninput = onMoney('asking');
  $('#discount').oninput = onMoney('discount');
  for (const id of ['#asking', '#discount']) {
    $(id).onblur = (e) => {
      const n = parseMoney(e.target.value);
      e.target.value = n === null ? '' : money(n);
    };
  }

  $('#alts-list').onchange = (e) => {
    const i = e.target.dataset.alt;
    if (i !== undefined) state.alternatives[Number(i)].selected = e.target.checked;
  };

  document.body.addEventListener('click', async (e) => {
    const kind = e.target.dataset?.copy;
    if (!kind) return;
    try {
      if (kind === 'sms') await navigator.clipboard.writeText($('#sms-out').value);
      if (kind === 'email-rich') await copyRich($('#email-out').innerHTML, $('#email-out').innerText);
      if (kind === 'email-plain') await navigator.clipboard.writeText($('#email-out').innerText);
      setStatus('Copied.', 'ok');
    } catch (err) {
      setStatus(`Copy failed: ${err.message}`, 'error');
    }
  });

  $('#queue-list').onclick = (e) => {
    const i = e.target.dataset.reopen;
    if (i === undefined) return;
    const q = state.queue[Number(i)];
    state.drafts = { sms: q.sms, subject: q.emailSubject, emailHtml: q.emailHtml };
    $('#draft-section').hidden = false;
    renderDrafts();
    setStatus(`Showing saved drafts for ${q.customerName}.`, 'ok');
  };
  $('#btn-csv').onclick = () => {
    download(new Blob([toCsv(state.queue)], { type: 'text/csv' }), `followups-${todayKey()}.csv`);
  };
  $('#btn-clear').onclick = async () => {
    if (!confirm("Clear today's queue?")) return;
    state.queue = [];
    await storage.saveQueue([]);
    renderQueue();
  };

  $('#btn-save-settings').onclick = async () => {
    const next = { ...state.settings };
    for (const input of document.querySelectorAll('[data-setting]')) {
      const k = input.dataset.setting;
      if (input.type === 'checkbox') next[k] = input.checked;
      else if ('list' in input.dataset) next[k] = input.value.split(',').map((s) => s.trim()).filter(Boolean);
      else if (input.type === 'number') next[k] = Number(input.value);
      else next[k] = input.value;
    }
    state.settings = next;
    await storage.saveSettings(next);
    renderSettings();
    reevaluate();
    setStatus('Settings saved.', 'ok');
  };
}

// --------------------------------------------------------------- boot ---

async function boot() {
  wire();
  state.settings = await storage.loadSettings();
  state.queue = await storage.loadQueue();
  const working = await storage.loadWorking();
  if (working?.record) Object.assign(state, working, { drafts: null });
  renderSettings();
  renderQueue();
  renderTasks();
  if (state.record) {
    renderCustomer();
    renderInventory();
    renderPricing();
    renderAlternatives();
    $('#user-sold').checked = state.userSaysSold;
    reevaluate();
  }
}

boot().catch((err) => setStatus(`Startup error: ${err.message}`, 'error'));
