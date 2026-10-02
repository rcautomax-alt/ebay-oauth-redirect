import { DEFAULT_SETTINGS, feeTotal } from '../config/defaults.js';
import { money, parseMoney, escapeHtml, todayKey, firstNameOf, nameKey } from '../lib/format.js';
import { computePricing } from '../lib/pricing.js';
import { parseCustomer, parseTaskList, tasksFromDom, pickTask, detectSessionProblem, splitPanes } from '../lib/vin-parser.js';
import { parseVehicleTitle, normalizeStock, isPlausibleVin } from '../lib/vehicle.js';
import { probeFrame, probeTaskList, probeTaskView, probeInventoryGrid, runInventorySearch, clickTaskCustomer, captureFrame, extractVehicleCards } from '../lib/probes.js';
import {
  stockSearchUrl, modelSearchUrl, stockOrVinUrl, searchDropped, storeOf, vehiclesFromInventoryRows, keywordSearchUrl, vehicleLink, vehiclesFromExtraction, findVehicle, pickAlternatives,
} from '../lib/inventory.js';
import { evaluate, canDraft, unacknowledged } from '../lib/rules.js';
import { buildDrafts } from '../lib/templates.js';
import { sharedVoi, upsert, toCsv } from '../lib/queue.js';
import { withRetry, sleep, SessionError } from '../lib/retry.js';
import { scrubPii } from '../lib/scrub.js';
import { STARTERS, buildFreestylePrompt, bestDealInstruction, parseClaudeReply, emailTextToHtml } from '../lib/freestyle.js';

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- state ---

const state = {
  settings: { ...DEFAULT_SETTINGS },
  tasks: [],
  taskFilter: 'contact', // task list: 'pq' (Send Out Price) | 'contact' (any email/text) | 'all'
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
  fsVehicles: [], // vehicles to mention in a freestyle message
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
    const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    // Saved settings from before the site moved still point at the old domain.
    // Old guesses at the website's search pages (they don't exist on it).
    for (const k of ['inventoryBase', 'inventorySearchAll']) {
      if (/ritcheybuickgmc\.com|searchused\.aspx|searchall\.aspx/i.test(merged[k] || '')) merged[k] = DEFAULT_SETTINGS[k];
    }
    // The site labels your store "Ritchey Cadillac"; older saved settings
    // only knew "Daytona".
    if (Array.isArray(merged.storesAllowed) && merged.storesAllowed.join() === 'Daytona') merged.storesAllowed = DEFAULT_SETTINGS.storesAllowed;
    return merged;
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

// The VinSolutions tab — even when you're looking at another tab (Claude, the
// website). Prefers the tab in front if it's VinSolutions, else the most
// recently used VinSolutions tab.
const VIN_TAB_URLS = ['https://*.coxautoinc.com/*', 'https://*.vinsolutions.com/*', 'https://*.vinmanager.com/*'];
const isVinUrl = (u) => /coxautoinc\.com|vinsolutions\.com|vinmanager\.com/i.test(u || '');

async function vinTab() {
  const front = await activeTab().catch(() => null);
  if (front && isVinUrl(front.url)) return front;
  const tabs = await chrome.tabs.query({ url: VIN_TAB_URLS });
  if (!tabs.length) throw new Error('No VinSolutions tab is open — open VinSolutions and try again.');
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return tabs[0];
}

async function bringToFront(tab) {
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
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
  const tab = await vinTab();
  return withRetry(
    async () => {
      let frames;
      try {
        frames = await probeAllFrames(tab.id);
      } catch (err) {
        throw new Error(`Couldn't read VinSolutions (${err.message}). Try clicking into the VinSolutions tab, then Retry.`);
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

// The site moved once already (ritcheybuickgmc.com -> ritcheyautos.com, search
// dropped). If a search lands somewhere without its query, say so plainly
// instead of reading the homepage as "no vehicles".
class RedirectError extends Error {}

async function extractViaFetch(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (res.status === 404) throw new RedirectError('that search page doesn’t exist on the site — update the search address in Settings');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const dropped = searchDropped(url, res.url);
  if (dropped) throw new RedirectError(dropped);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return vehiclesFromExtraction(extractVehicleCards(doc), state.settings.priceLabels, res.url || url);
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
      }, 10000);
    });
    const landed = (await chrome.tabs.get(tab.id)).url;
    const dropped = searchDropped(url, landed);
    if (dropped) throw new RedirectError(dropped);
    for (let i = 0; i < 4; i++) {
      await sleep(1200);
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractVehicleCards });
      const vehicles = vehiclesFromExtraction(r.result || {}, state.settings.priceLabels, url);
      if (vehicles.length) return vehicles;
    }
    return [];
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ---- Website access ------------------------------------------------------
// Chrome can withhold the extension's access to ritcheyautos.com (Details →
// Site access → "On click"). VinSolutions still works then — clicking the
// icon grants the tab you're on — but background price lookups get blocked
// with a CORS error. Check for it, and offer a button to ask Chrome for it.
function siteOrigins() {
  const origins = new Set(['https://*.ritcheyautos.com/*', 'https://ritcheyautos.com/*']);
  for (const k of ['inventoryBase', 'inventorySearchAll']) {
    try {
      origins.add(`${new URL(state.settings[k]).origin}/*`);
    } catch {
      /* not a URL */
    }
  }
  return [...origins];
}

async function hasSiteAccess() {
  try {
    return await chrome.permissions.contains({ origins: siteOrigins() });
  } catch {
    return false;
  }
}

async function refreshSiteAccessBanner() {
  $('#site-access').hidden = await hasSiteAccess();
}

async function requestSiteAccess() {
  try {
    const ok = await chrome.permissions.request({ origins: siteOrigins() });
    setStatus(ok ? 'Website access allowed — price and alternatives lookups will work now.' : 'Website access not allowed — lookups will stay blocked.', ok ? 'ok' : 'error');
  } catch (err) {
    setStatus(`Couldn't ask Chrome for access (${err.message}). Use chrome://extensions → Details → Site access → On all sites.`, 'error');
  }
  refreshSiteAccessBanner();
}

class NoAccessError extends Error {}

// Once a plain download of the site has returned vehicles, we know the site
// doesn't need JavaScript to list them — so an empty result really means
// "not there" and the slow hidden-tab fallback can be skipped.
let siteFetchWorks = false;

async function loadResults(url, tried) {
  if (!(await hasSiteAccess())) {
    $('#site-access').hidden = false;
    tried.push({ url, count: 0, note: 'Chrome is blocking website access — click "Allow website access" at the top' });
    throw new NoAccessError('Chrome is blocking the extension from reading ritcheyautos.com. Click "Allow website access" at the top of the panel.');
  }
  let vehicles = [];
  try {
    vehicles = await withRetry(() => extractViaFetch(url), { tries: 2 });
    if (vehicles.length) siteFetchWorks = true;
  } catch (err) {
    if (err instanceof RedirectError) {
      tried.push({ url, count: 0, note: err.message });
      return [];
    }
    console.warn('fetch failed, trying tab', err);
  }
  if (!vehicles.length && !siteFetchWorks) {
    try {
      vehicles = await extractViaTab(url);
    } catch (err) {
      // Log it and move on to the next search instead of stopping everything.
      tried.push({ url, count: 0, note: err instanceof RedirectError ? err.message : `couldn't open page (${err.message})` });
      return [];
    }
  }
  // Logged with a count so "the site returned nothing" is visible in the panel.
  tried.push({ url, count: vehicles.length });
  return vehicles;
}

function withStore(v) {
  return { ...v, store: storeOf(v, state.settings.storesAllowed || [], state.settings.storesExcluded || []) };
}

// ---- VinSolutions inventory ---------------------------------------------
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let sawLoading = false;
    const done = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) finish();
    };
    const finish = () => {
      chrome.tabs.onUpdated.removeListener(done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(done);
  });
}

// Search Browse Inventory in a hidden tab (Pre-Owned – All), read the grid,
// close the tab. Uses your logged-in VinSolutions session; changes nothing.
async function searchVinInventory(term) {
  const tab = await chrome.tabs.create({ url: state.settings.vinInventoryUrl, active: false });
  try {
    await waitForTabLoad(tab.id);
    const [first] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probeInventoryGrid });
    if (!first?.result) throw new Error("couldn't open VinSolutions Browse Inventory (logged out?)");
    const navigated = waitForTabLoad(tab.id);
    const [sub] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: runInventorySearch, args: [term] });
    if (!sub?.result) throw new Error("couldn't type into the Browse Inventory search box");
    await navigated;
    for (let i = 0; i < 6; i++) {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probeInventoryGrid });
      if (r?.result && String(r.result.search || '').toLowerCase() === term.toLowerCase()) {
        return vehiclesFromInventoryRows(r.result.rows).map(withStore);
      }
      await sleep(800);
    }
    throw new Error('the inventory search didn’t finish');
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Manual fallback: read the Browse Inventory grid you have open yourself.
async function readInventoryScreen() {
  await busy('Reading the Browse Inventory screen…', async () => {
    try {
      const tab = await vinTab();
      const res = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: probeInventoryGrid });
      const grid = res.map((r) => r.result).find((g) => g && g.rows);
      if (!grid) {
        setStatus('Open VinSolutions → Inventory → Browse Inventory, search the model, then click this again.', 'error');
        return;
      }
      const r = state.record || {};
      const add = vehiclesFromInventoryRows(grid.rows)
        .map(withStore)
        .filter((v) => !(r.stock && normalizeStock(v.stock) === normalizeStock(r.stock)))
        .filter((v) => !state.alternatives.some((a) => (a.vin && a.vin === v.vin) || (a.stock && a.stock === v.stock)))
        .map((v) => ({ ...v, selected: false, manual: true, found: true, link: '' }));
      state.alternatives.push(...add);
      renderVehicleLists();
      setStatus(`Added ${add.length} vehicle${add.length === 1 ? '' : 's'} from Browse Inventory${grid.search ? ` ("${grid.search}")` : ''} — tick the ones to offer.`, add.length ? 'ok' : 'error');
    } catch (err) {
      setStatus(`Couldn't read Browse Inventory: ${err.message}`, 'error');
    }
  });
}

const websiteSearchOn = () => !!(state.settings.inventoryBase || state.settings.inventorySearchAll);

const blankVehicle = () => ({ title: '', stock: '', vin: null, miles: null, price: null, link: '', url: '', selected: true, manual: true });

// Add a vehicle by stock #, VIN or website link. A fresh trade usually isn't
// on the website yet — then you get a blank row to fill in by hand.
async function findVehicleByQuery(query) {
  const q = query.trim();
  const { inventoryBase, inventorySearchAll } = state.settings;
  const tried = [];
  if (/^https?:\/\//i.test(q)) {
    let found = null;
    try {
      const vs = await loadResults(q, tried);
      // A VDP page can also show "similar vehicles"; only trust an exact match.
      found = vs.find((v) => v.url && v.url.split('?')[0] === q.split('?')[0]) || (vs.length === 1 ? vs[0] : null);
    } catch (err) {
      console.warn('link lookup failed', err);
    }
    return withStore({ ...blankVehicle(), ...(found || {}), link: q, found: !!found });
  }
  const isVin = isPlausibleVin(q);
  const key = isVin ? { vin: q.toUpperCase() } : { stock: q };
  // VinSolutions inventory first: it has fresh trades and the Web $ price.
  let hit = null;
  try {
    hit = findVehicle(await searchVinInventory(q), key);
  } catch (err) {
    console.warn('VinSolutions inventory search failed', err);
  }
  if (hit) return { ...blankVehicle(), ...hit, link: '', found: true };
  if (!websiteSearchOn()) return { ...blankVehicle(), ...(isVin ? { vin: q.toUpperCase() } : { stock: q }), found: false };
  if (inventorySearchAll) hit = findVehicle(await loadResults(stockOrVinUrl(inventorySearchAll, q), tried), key);
  if (!hit && !isVin && inventoryBase) hit = findVehicle(await loadResults(stockSearchUrl(inventoryBase, q), tried), key);
  if (hit) {
    const v = withStore({ ...blankVehicle(), ...hit, link: vehicleLink(hit, inventorySearchAll), found: true });
    if (v.store.status === 'excluded') v.selected = false; // other store: added unchecked
    return v;
  }
  return { ...blankVehicle(), ...(isVin ? { vin: q.toUpperCase() } : { stock: q }), found: false };
}

async function addVehicle(listKey, inputSel) {
  const q = $(inputSel).value.trim();
  if (!q) {
    state[listKey].push(blankVehicle());
  } else {
    setStatus(`Looking up ${q} on the website…`);
    let v;
    try {
      v = await findVehicleByQuery(q);
    } catch (err) {
      // Website blocked: still add a row to fill in by hand.
      v = { ...blankVehicle(), [isPlausibleVin(q) ? 'vin' : 'stock']: q, found: false };
      state[listKey].push(v);
      setStatus(err.message, 'error');
      $(inputSel).value = '';
      renderVehicleLists();
      return;
    }
    state[listKey].push(v);
    const otherStore = v.store?.status === 'excluded';
    setStatus(
      otherStore
        ? `${v.title || q} is listed at the ${v.store.where} store — added unchecked, since you can't sell it from here.`
        : v.found
          ? `Added ${v.title || q}${v.source === 'vinsolutions' ? ' from VinSolutions inventory' : ' from the website'}${v.price ? ` (${money(v.price)})` : ''}.${v.link ? '' : ' Paste its website link if you want one in the message.'}`
          : `${q} wasn't found in VinSolutions inventory${websiteSearchOn() ? ' or on the website' : ''}. Fill in the details by hand.`,
      v.found && !otherStore ? 'ok' : 'error',
    );
  }
  $(inputSel).value = '';
  renderVehicleLists();
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
      const tab = await vinTab();
      const frames = await readVinSolutions({ needRight: false });
      // Preferred: the real task table (icon = task type). Fallback: text.
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: probeTaskList });
      const rows = results.flatMap((r) => r.result || []);
      state.tasks = rows.length ? tasksFromDom(rows) : parseTaskList(frames);
      state.pickedTask = null;
      const views = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: probeTaskView });
      const view = views.map((r) => r.result).find(Boolean);
      renderTasks();
      const n = (type) => state.tasks.filter((t) => t.type === type).length;
      if (state.tasks.length) {
        const groups = groupCustomers(state.tasks);
        const pq = groups.filter((c) => c.pqTasks.length).length;
        const od = groups.filter((c) => c.overdue).length;
        const warnings = taskListWarnings(view, groups);
        setStatus(
          `${od ? `⏰ ${od} overdue customer${od === 1 ? '' : 's'}. ` : ''}${pq} need a Send Out Price. (${state.tasks.length} tasks: ${n('email') + n('text')} email/text, ${n('call')} calls for you, ${n('other')} internal.)${warnings.length ? ` ⚠️ ${warnings.join(' ')}` : ''}`,
          warnings.length ? 'error' : 'ok',
        );
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
    leadSource: p.leadSource || '',
    vehicleTitle: p.voi.title || '',
    model: p.voi.model || '',
    stock: p.voi.stock || '',
    vin: p.voi.vin || '',
    crmStatus: p.voi.status,
    crmPrice: p.voi.crmPrice || null,
    miles: p.voi.miles || null,
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
        fsVehicles: [],
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
      $('#fs-deal-discount').value = '';
      $('#fs-deal-through').value = '';
      $('#fs-deal-on').checked = false;
      renderVehicleLists(); // clear the old customer's vehicle rows off screen
      // VinSolutions' own Internet Price is the asking price; the website
      // lookup below only cross-checks it.
      if (state.record.crmPrice) state.asking = state.record.crmPrice;
      renderPricing();
      renderInventory();
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

// Things that mean the panel may not be seeing every task on My Tasks.
function taskListWarnings(view, groups) {
  const out = [];
  if (!view) return out;
  if (view.activeTab && !/^all$/i.test(view.activeTab)) {
    out.push(`My Tasks is on the "${view.activeTab}" tab — switch to All to include every section (overdue included).`);
  }
  // Compare each section's header count with the customers actually read.
  for (const [name, count] of Object.entries(view.sections || {})) {
    if (!count || /my tasks|lead bucket|new leads|vinessa/i.test(name)) continue;
    const read = new Set(state.tasks.filter((t) => t.section === name).map((t) => `${t.rowKey}|${nameKey(t.customer)}`)).size;
    if (read < count) out.push(`VinSolutions shows ${name} (${count}) but the panel read ${read} — scroll that section into view and Read Task List again.`);
  }
  return out;
}

// One entry per customer, with all of their tasks.
function groupCustomers(tasks) {
  const map = new Map();
  for (const t of tasks) {
    // ID + name: never merge two different people even if an ID repeats.
    const key = `${t.rowKey}|${nameKey(t.customer)}`;
    if (!map.has(key)) {
      map.set(key, { key, customer: t.customer, vehicle: t.vehicle, stock: t.stock, rowKey: t.rowKey, sections: [], overdue: false, vehicleStruck: t.vehicleStruck, sharedWith: t.sharedWith || [], tasks: [] });
    }
    const g = map.get(key);
    g.tasks.push(t);
    if (t.section && !g.sections.includes(t.section)) g.sections.push(t.section);
    if (t.overdue) g.overdue = true;
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
    const tab = await vinTab();
    // Show VinSolutions so you see the customer open (you may be on Claude).
    await bringToFront(tab);
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
    await copyText(c.customer).catch(() => {});
    setStatus(`Couldn't open ${c.customer} automatically — name copied. Open them in VinSolutions, then Read Customer.`, 'error');
  }
}

async function runLookup() {
  const r = state.record;
  if (!websiteSearchOn()) {
    // Price comes from VinSolutions; no website search to cross-check with.
    state.inventory = null;
    setStatus(
      r.crmPrice ? `Asking price from VinSolutions: ${money(r.crmPrice)}.` : "No price on this lead in VinSolutions — type the asking price.",
      r.crmPrice ? 'ok' : 'error',
    );
    renderInventory();
    renderPricing();
    reevaluate();
    return;
  }
  setStatus(`Checking the website for stock #${r.stock || '—'}…`);
  try {
    state.inventory = await lookupInventory({ stock: r.stock, vin: r.vin, model: r.model });
    if (state.inventory.vehicle) state.inventory.vehicle = withStore(state.inventory.vehicle);
    const sitePrice = state.inventory.vehicle?.price;
    if (!state.asking && sitePrice) state.asking = sitePrice;
    const crm = state.record.crmPrice;
    setStatus(
      state.inventory.found
        ? `Found on the website.${crm ? ` Asking price from VinSolutions: ${money(crm)}.` : ''}`
        : crm
          ? `Website didn't confirm it, but VinSolutions has it at ${money(crm)} — using that.`
          : 'Not found on the website (stock and model search).',
      state.inventory.found || crm ? 'ok' : 'error',
    );
  } catch (err) {
    state.inventory = null;
    const crm = state.record.crmPrice;
    setStatus(
      crm ? `Website lookup failed (${err.message}) — using the VinSolutions Internet Price, ${money(crm)}.` : `Website lookup failed: ${err.message}`,
      crm ? 'ok' : 'error',
      () => busy('Retrying…', runLookup),
    );
  }
  renderInventory();
  renderPricing();
  reevaluate();
}

async function runAlternatives() {
  const r = state.record;
  if (!r.model) {
    setStatus('Type a model to search for alternatives (or add a vehicle by hand below).', 'error');
    return;
  }
  setStatus(`Searching VinSolutions inventory for other ${r.model}s…`);
  try {
    const { inventoryBase, inventorySearchAll } = state.settings;
    const tried = [...(state.inventory?.tried || [])];
    let results = [];
    // 1. VinSolutions Browse Inventory (your store, fresh trades included).
    const make = parseVehicleTitle(r.vehicleTitle || '')?.make;
    try {
      const inv = (await searchVinInventory(r.model)).filter((v) => !make || !v.make || v.make.toLowerCase() === make.toLowerCase());
      tried.push({ url: state.settings.vinInventoryUrl, label: `VinSolutions inventory: "${r.model}"`, count: inv.length });
      results = inv;
    } catch (err) {
      tried.push({ url: state.settings.vinInventoryUrl, label: `VinSolutions inventory: "${r.model}"`, count: 0, note: `${err.message} — try "Read Inventory screen"` });
    }
    // 2. Website model search, only if its search address is set in Settings.
    if (websiteSearchOn() && inventoryBase) {
      let site = await loadResults(modelSearchUrl(inventoryBase, r.model), tried);
      if (!site.length && inventorySearchAll) {
        const words = (r.vehicleTitle || r.model).replace(/^\d{4}\s+/, '').split(/\s+/).slice(0, 2).join(' ');
        site = await loadResults(keywordSearchUrl(inventorySearchAll, words), tried);
      }
      // Same unit on both: keep the VinSolutions row, borrow the website link.
      for (const w of site) {
        const same = results.find((v) => (v.vin && v.vin === w.vin) || (v.stock && w.stock && normalizeStock(v.stock) === normalizeStock(w.stock)));
        if (same) same.url = same.url || w.url;
        else results.push(w);
      }
    }
    state.inventory = { found: false, vehicle: null, source: null, ...(state.inventory || {}), modelResults: results, tried };
    const manual = state.alternatives.filter((a) => a.manual);
    // The group site lists every Ritchey store; only offer the ones you sell from.
    const tagged = results.map(withStore);
    const usable = tagged.filter((v) => v.store.status !== 'excluded');
    const hidden = tagged.filter((v) => v.store.status === 'excluded');
    const hiddenNote = hidden.length
      ? ` (${hidden.length} at ${[...new Set(hidden.map((v) => v.store.where))].join('/')} hidden)`
      : '';
    const picked = pickAlternatives(usable, {
      excludeStock: r.stock,
      excludeVin: r.vin,
      targetPrice: state.asking || state.inventory?.vehicle?.price || null,
      window: Number(state.settings.altPriceWindow) || 5000,
      limit: state.settings.altLimit || 3,
    }).map((a) => ({ ...a, link: vehicleLink(a, inventorySearchAll), selected: true }));
    // A rerun shouldn't duplicate what's already listed.
    for (const m of manual) {
      const i = picked.findIndex((p) => (p.vin && p.vin === m.vin) || (p.stock && m.stock && normalizeStock(p.stock) === normalizeStock(m.stock)));
      if (i >= 0) picked.splice(i, 1);
    }
    state.alternatives = [...manual, ...picked];
    setStatus(
      picked.length
        ? `Found ${picked.length} alternative${picked.length === 1 ? '' : 's'}${hiddenNote}.`
        : `No alternatives at your stores for that model${hiddenNote} — add one by hand, or your call.`,
      picked.length ? 'ok' : 'error',
    );
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
    leadSource: r.leadSource,
    task: { type: r.taskType, template: state.pickedTask?.template || null, isPriceQuote: state.pickedTask ? !!state.pickedTask.isPriceQuote : null },
    voi: { stock: r.stock, vin: r.vin, status: r.crmStatus, crmPrice: r.crmPrice ? Number(r.crmPrice) : null },
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
    const alts = state.alternatives.filter((a) => a.selected).map((a) => ({ ...a, link: a.link ?? vehicleLink(a, state.settings.inventorySearchAll) }));
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
    vehicles: state.fsVehicles.filter((v) => v.selected !== false),
    deal: $('#fs-deal-on').checked ? { goodThrough: $('#fs-deal-through').value.trim() } : null,
  });
}

// 🏷️ Best-deal message: VinSolutions price − your discount, framed as
// special online pricing, then straight into Claude.
function dealPricing() {
  const asking = state.asking || state.record?.crmPrice || null;
  const discount = parseMoney($('#fs-deal-discount').value);
  if (!asking || discount === null) return null;
  try {
    return computePricing({ asking, discount, fees: state.settings.fees });
  } catch {
    return null;
  }
}

function renderDealBox() {
  const src = state.record?.leadSource || '';
  const hot = /autoweb/i.test(src);
  $('#fs-deal').classList.toggle('hot', hot);
  $('#fs-source').hidden = !src;
  $('#fs-source').textContent = src ? `Source: ${src}` : '';
  const asking = state.asking || state.record?.crmPrice;
  const p = dealPricing();
  $('#fs-deal-numbers').textContent = p
    ? `${money(p.asking)} − ${money(p.discount)} = ${money(p.special)} (${money(p.withFees)} with fees)`
    : asking
      ? `Price ${money(asking)} — enter your discount.`
      : 'No price yet — read the customer (VinSolutions price) or type one in Pricing.';
}

async function buildBestDeal(e) {
  const btn = e?.currentTarget;
  const p = dealPricing();
  if (!p) {
    flashButton(btn, false, state.asking || state.record?.crmPrice ? 'Enter a discount first' : 'Need a price first');
    $('#fs-deal-discount').focus();
    return;
  }
  // Keep the panel's pricing in step so the drafts and the queue match.
  state.asking = p.asking;
  state.discount = p.discount;
  state.pricing = p;
  renderPricing();
  $('#fs-instruction').value = bestDealInstruction({ goodThrough: $('#fs-deal-through').value });
  $('#fs-pricing').checked = true;
  $('#fs-deal-on').checked = true;
  await copyFreestyle({ currentTarget: btn }, { openClaude: true });
}

// Copies the request and (openClaude) opens Claude with it already typed in.
// The copy is the backup if Claude opens with an empty box.
async function copyFreestyle(e, { openClaude = false } = {}) {
  const btn = e?.currentTarget;
  if (!$('#fs-instruction').value.trim()) {
    flashButton(btn, false, 'Type what to say first');
    setStatus('Type what you want to say first.', 'error');
    $('#fs-instruction').focus();
    return;
  }
  const prompt = freestylePrompt();
  $('#fs-prompt').textContent = prompt;
  $('#fs-preview').open = true;
  let copied = true;
  try {
    await copyText(prompt);
  } catch (err) {
    copied = false;
    console.warn('copy failed', err);
  }
  if (openClaude) {
    chrome.tabs.create({ url: `https://claude.ai/new?q=${encodeURIComponent(prompt)}` });
  }
  if (copied) {
    flashButton(btn, true, openClaude ? '✓ Copied — opening Claude' : '✓ Copied!');
    setStatus(
      openClaude
        ? 'Claude opened with your request typed in — hit send. (If the box is empty, paste: it is on your clipboard.)'
        : 'Request copied. Paste it into Claude, then paste the reply back here.',
      'ok',
    );
  } else {
    flashButton(btn, false, '✗ Copy blocked');
    setStatus(
      openClaude
        ? 'Claude opened with your request typed in — hit send. (Copy was blocked, so if the box is empty, select the preview below and copy it.)'
        : 'Copy was blocked — select the request in the preview below and copy it (Ctrl+A, Ctrl+C).',
      openClaude ? 'ok' : 'error',
    );
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
          // VinSolutions URLs carry customer IDs; website search URLs are fine to keep.
          url: /vinsolutions|coxautoinc|vinmanager/i.test(r.result.url) ? scrubPii(r.result.url.replace(/\?.*$/, '?[QUERY]'), names) : r.result.url,
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
  const hasContact = (c) => c.tasks.some((t) => t.type === 'email' || t.type === 'text');
  const rank = (c) => (c.pqTasks.length ? 0 : hasContact(c) ? 1 : 2);
  const keep = { pq: (c) => c.pqTasks.length > 0, contact: hasContact, all: () => true }[state.taskFilter] || hasContact;
  // Overdue first (clean-up), then Send Out Price, then other email/text.
  const shown = all.filter(keep).sort((a, b) => Number(b.overdue) - Number(a.overdue) || rank(a) - rank(b));
  const odCount = all.filter((c) => c.overdue).length;
  $('#tasks-count').textContent = `(${odCount ? `⏰ ${odCount} overdue · ` : ''}${pqCount} Send Out Price · ${all.length} customers)`;
  $('#task-filter').value = state.taskFilter;
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
              ${c.overdue ? '<span class="tag overdue">⏰ Overdue</span>' : ''}
              ${saved ? '<span class="tag ok">✓ drafted</span>' : ''}
              ${c.sharedWith.length ? `<span class="tag" title="Also VOI for ${escapeHtml(c.sharedWith.join(', '))}">🔥 shared: ${escapeHtml(c.sharedWith.join(', '))}</span>` : ''}
              ${c.vehicleStruck ? '<span class="tag call">sold?</span>' : ''}
              <br><span class="hint">${escapeHtml(c.vehicle || 'no vehicle')} ${c.stock ? `[${escapeHtml(c.stock)}]` : '— no stock #'} · ${escapeHtml(c.sections.join(' + '))}</span>
              <br>${taskIcons}
              ${c.pqTasks.length ? `<span class="hint">Send Out Price by ${c.channels.join(' + ')}</span>` : ''}
              ${other.length ? `<span class="hint">· other template: ${escapeHtml(other.map((t) => t.template || t.description).join('; '))}</span>` : ''}
            </span>
          </li>`;
        })
        .join('')
    : '<li class="hint">Nothing matches this filter — try "Everything".</li>';
}

function renderCustomer() {
  $('#customer-section').hidden = !state.record;
  if (!state.record) return;
  for (const input of document.querySelectorAll('[data-field]')) {
    const v = state.record[input.dataset.field];
    input.value = v === null || v === undefined ? '' : v;
  }
  $('#view-badge').textContent = state.view;
  renderDealBox();
  // Autoweb-style leads: open Freestyle so the best-deal box is right there.
  if (/autoweb/i.test(state.record.leadSource || '')) $('#freestyle-section').open = true;
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
  const r = state.record || {};
  const crmLine = r.crmPrice
    ? `<p class="ok">✓ VinSolutions: ${escapeHtml(r.vehicleTitle || 'vehicle')} — Stock # ${escapeHtml(r.stock || '?')}${r.miles ? ` — ${Number(r.miles).toLocaleString('en-US')} mi` : ''} — Internet Price <b>${money(r.crmPrice)}</b></p>`
    : '';
  if (!inv) {
    el.innerHTML = `${crmLine}<p class="hint">Website not checked yet.</p>`;
    return;
  }
  const v = inv.vehicle;
  const tried = (inv.tried || [])
    .map((t) => (typeof t === 'string' ? { url: t, count: null } : t))
    .map((t) => `<a href="${escapeHtml(t.url)}" target="_blank">${escapeHtml(t.label || t.url.replace(/^https?:\/\/[^/]+/, ''))}</a>${t.note ? ` — <span class="warn">⚠️ ${escapeHtml(t.note)}</span>` : t.count === null ? '' : ` — ${t.count} vehicle${t.count === 1 ? '' : 's'}`}`)
    .join('<br>');
  el.innerHTML = crmLine + (v
    ? `<p class="ok">✓ Website: ${escapeHtml(v.title || 'Vehicle')} — Stock # ${escapeHtml(v.stock || '?')} — SALE PRICE <b>${money(v.price) || 'not readable'}</b></p>
       ${v.store?.status === 'excluded' ? `<p class="warn">⚠️ Listed at the ${escapeHtml(v.store.where)} store, not yours.</p>` : ''}
       ${v.url ? `<p><a href="${escapeHtml(v.url)}" target="_blank">Open VDP</a></p>` : ''}
       <p class="hint">Checked: ${tried}</p>`
    : `${websiteSearchOn() && !inv.modelResults ? `<p class="hint warn">Vehicle of interest not found on the website${state.record?.crmStatus === 'sold' ? ' (expected — it sold)' : ''}.</p>` : ''}<p class="hint">Checked: ${tried || '—'}</p>`);
}

function renderPricing() {
  $('#asking').value = state.asking ? money(state.asking) : '';
  $('#discount').value = state.discount !== null && state.discount !== undefined ? money(state.discount) : '';
  updatePricingOut();
}

function updatePricingOut() {
  renderDealBox();
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

// Editable vehicle rows, shared by Alternatives and Freestyle.
function vehicleRows(list, listKey) {
  if (!list.length) return '<li class="hint">None yet.</li>';
  return list
    .map((v, i) => {
      const at = `data-list="${listKey}" data-idx="${i}"`;
      const outside = v.inWindow === false ? '<span class="tag">outside price window</span>' : '';
      const st = v.store || { status: 'unknown' };
      const store =
        st.status === 'allowed'
          ? `<span class="tag">📍 ${escapeHtml(st.where)}</span>`
          : st.status === 'excluded'
            ? `<span class="tag call">⛔ ${escapeHtml(st.where)} store</span>`
            : v.found === false || (v.manual && !v.found)
              ? ''
              : '<span class="tag" title="The listing didn\'t say which store">📍 location?</span>';
      return `<li class="veh">
        <input type="checkbox" ${at} data-f="selected" ${v.selected !== false ? 'checked' : ''}>
        <div class="veh-fields">
          <input ${at} data-f="title" value="${escapeHtml(v.title || '')}" placeholder="Year Make Model Trim">
          <div class="veh-row">
            <input ${at} data-f="stock" value="${escapeHtml(v.stock || '')}" placeholder="Stock #">
            <input ${at} data-f="miles" value="${v.miles ? Number(v.miles).toLocaleString('en-US') : ''}" placeholder="Miles">
            <input ${at} data-f="price" value="${v.price ? money(v.price) : ''}" placeholder="Price">
          </div>
          <input ${at} data-f="link" value="${escapeHtml(v.link || '')}" placeholder="Link (website VDP)">
          <span class="hint">${v.manual ? (v.found ? 'added · from website' : 'added by hand') : 'from website'} ${store} ${outside}
            ${v.link ? `· <a href="${escapeHtml(v.link)}" target="_blank">open ↗</a>` : ''}</span>
        </div>
        <button class="x" data-remove="${listKey}:${i}" title="Remove">✕</button>
      </li>`;
    })
    .join('');
}

function renderVehicleLists() {
  $('#alts-list').innerHTML = vehicleRows(state.alternatives, 'alternatives');
  $('#fs-vehicles').innerHTML = vehicleRows(state.fsVehicles, 'fsVehicles');
  $('#btn-fs-from-alts').hidden = !state.alternatives.some((a) => a.selected !== false);
}

function renderAlternatives() {
  renderVehicleLists();
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

// Clipboard. The modern API can be refused in a side panel (e.g. "Document is
// not focused" when you last clicked in VinSolutions), so fall back to the
// older copy command, which the clipboardWrite permission allows.
function execCopy(fill) {
  const holder = document.createElement('div');
  holder.contentEditable = 'true';
  holder.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:pre-wrap;';
  fill(holder);
  document.body.appendChild(holder);
  const range = document.createRange();
  range.selectNodeContents(holder);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const ok = document.execCommand('copy');
  sel.removeAllRanges();
  holder.remove();
  if (!ok) throw new Error('the browser blocked copying');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    execCopy((el) => (el.textContent = text));
  }
}

async function copyRich(html, text) {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ]);
  } catch {
    execCopy((el) => (el.innerHTML = html));
  }
}

// Show the result on the button itself — the status line can be off-screen.
function flashButton(btn, ok, label) {
  if (!btn) return;
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  btn.textContent = label;
  btn.classList.toggle('flash-ok', ok);
  btn.classList.toggle('flash-bad', !ok);
  clearTimeout(btn._flash);
  btn._flash = setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('flash-ok', 'flash-bad');
  }, 2500);
}

function wire() {
  $('#btn-tasks').onclick = readTasks;
  $('#btn-customer').onclick = readCustomer;
  $('#btn-capture').onclick = capturePage;
  $('#btn-lookup').onclick = () => busy('Checking website…', runLookup);
  $('#btn-alts').onclick = () => busy('Searching…', runAlternatives);
  $('#btn-draft').onclick = generateDrafts;
  $('#btn-save').onclick = saveToQueue;
  $('#btn-site-access').onclick = requestSiteAccess;
  $('#btn-fs-copy').onclick = (e) => copyFreestyle(e);
  $('#btn-fs-deal').onclick = buildBestDeal;
  $('#fs-deal-discount').oninput = renderDealBox;
  $('#fs-deal-discount').onblur = (e) => {
    const n = parseMoney(e.target.value);
    e.target.value = n === null ? '' : money(n);
  };
  $('#btn-fs-open').onclick = (e) => copyFreestyle(e, { openClaude: true });
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
  $('#task-filter').onchange = (e) => {
    state.taskFilter = e.target.value;
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

  // Vehicle rows (alternatives + freestyle): edits write straight to state.
  const onVehicleEdit = (e) => {
    const { list, idx, f } = e.target.dataset;
    if (!list || !f) return;
    const v = state[list]?.[Number(idx)];
    if (!v) return; // row from a list that's since been cleared
    if (f === 'selected') v.selected = e.target.checked;
    else if (f === 'miles' || f === 'price') v[f] = parseMoney(e.target.value);
    else v[f] = e.target.value.trim();
  };
  const onVehicleClick = (e) => {
    const rm = e.target.dataset.remove;
    if (!rm) return;
    const [list, idx] = rm.split(':');
    if (state[list]?.[Number(idx)]) state[list].splice(Number(idx), 1);
    renderVehicleLists();
  };
  for (const id of ['#alts-list', '#fs-vehicles']) {
    $(id).addEventListener('input', onVehicleEdit);
    $(id).addEventListener('change', onVehicleEdit);
    $(id).addEventListener('click', onVehicleClick);
  }
  $('#btn-inv-screen').onclick = readInventoryScreen;
  $('#btn-alt-add').onclick = () => busy('Looking up…', () => addVehicle('alternatives', '#alt-add-query'));
  $('#btn-fs-veh-add').onclick = () => busy('Looking up…', () => addVehicle('fsVehicles', '#fs-veh-query'));
  $('#btn-fs-from-alts').onclick = () => {
    for (const a of state.alternatives.filter((x) => x.selected !== false)) {
      if (!state.fsVehicles.some((v) => (v.link && v.link === a.link) || (v.stock && v.stock === a.stock))) state.fsVehicles.push({ ...a });
    }
    $('#freestyle-section').open = true;
    renderVehicleLists();
  };

  document.body.addEventListener('click', async (e) => {
    const kind = e.target.dataset?.copy;
    if (!kind) return;
    try {
      if (kind === 'sms') await copyText($('#sms-out').value);
      if (kind === 'email-rich') await copyRich($('#email-out').innerHTML, $('#email-out').innerText);
      if (kind === 'email-plain') await copyText($('#email-out').innerText);
      if (kind === 'email-subject') await copyText($('#email-subject').value);
      flashButton(e.target, true, '✓ Copied!');
      setStatus('Copied.', 'ok');
    } catch (err) {
      flashButton(e.target, false, '✗ Copy failed');
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
  refreshSiteAccessBanner();
  state.queue = await storage.loadQueue();
  const working = await storage.loadWorking();
  if (working?.record) Object.assign(state, working, { drafts: null });
  renderSettings();
  renderQueue();
  renderTasks();
  renderVehicleLists();
  renderDealBox();
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
