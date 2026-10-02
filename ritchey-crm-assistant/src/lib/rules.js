import { nameKey } from './format.js';

// Flag levels:
//   block   – no drafting, period (phone-call tasks)
//   confirm – you must tick the box before drafts are generated
//   warn    – heads-up, doesn't stop anything
//   info    – context (tone, shared VOI)
//
// Modes:
//   skip         – call task (yours) or internal task (nothing to send)
//   quote        – normal Manager Special price quote
//   alternatives – VOI sold / not real inventory: offer similar units
//   ask          – not enough info to draft anything; your call

export function isMe(managerField, settings) {
  const fieldTokens = new Set(nameKey(managerField).split(' ').filter(Boolean));
  if (!fieldTokens.size) return false;
  // Match when every token of one of your names appears in the field, so
  // "Clemons, Rick (Pre-Owned Sales Manager)" still counts as you.
  return [settings.myName, ...(settings.myNameAliases || [])].some((n) => {
    const t = nameKey(n).split(' ').filter(Boolean);
    return t.length > 0 && t.every((x) => fieldTokens.has(x));
  });
}

export function evaluate(record, ctx) {
  const { settings, userSaysSold = false, sharedWith = [], inventory = null, expectedCustomer = null } = ctx;
  const flags = [];
  const add = (level, code, message) => flags.push({ level, code, message });
  const voi = record.voi || {};
  const taskType = record.task?.type || 'unknown';

  // 1. Calls are yours. Full stop.
  if (taskType === 'call') {
    add('block', 'CALL_TASK', 'Phone-call task — skipped. Calls stay with you.');
    return { mode: 'skip', flags };
  }
  if (taskType === 'other') {
    add('block', 'NOT_CONTACT_TASK', 'Internal/notification task (rep change, video check, visit reminder…) — nothing to send the customer.');
    return { mode: 'skip', flags };
  }
  if (taskType === 'unknown') {
    add('confirm', 'TASK_TYPE_UNKNOWN', "Couldn't read the task type. Confirm this is an email/text task, not a call.");
  }

  // This tool drafts the "*10 Day: MGR | Send Out Price" template. Other
  // price-quote templates (Day 4 Off Pace, Day 7 Best & Final) aren't built yet.
  if (record.task?.isPriceQuote === false && record.task?.template) {
    add('confirm', 'OTHER_TEMPLATE', `This task uses template "${record.task.template}". Drafts below follow *10 Day: MGR | Send Out Price — use them anyway?`);
  }

  // 2. Right customer on screen?
  if (expectedCustomer && record.customerName && nameKey(expectedCustomer) !== nameKey(record.customerName)) {
    add('confirm', 'CUSTOMER_MISMATCH', `You picked "${expectedCustomer}" but the screen shows "${record.customerName}".`);
  }

  // 3. Who owns it? Both the task's "Assigned To:" and the lead's "Manager:"
  //    (BD Agent / Sales Rep are other people's fields and don't count).
  const whoIs = (name) => (settings.otherManagers || []).find((n) => nameKey(n) === nameKey(name)) || name;
  if (!record.manager && !record.assignedTo) {
    add('warn', 'MANAGER_UNREAD', "Couldn't read the Manager: or Assigned To: field — double-check who this belongs to.");
  }
  if (record.assignedTo && !isMe(record.assignedTo, settings)) {
    add('confirm', 'TASK_NOT_MINE', `Task is assigned to ${whoIs(record.assignedTo)}, not you. Handle it anyway?`);
  }
  if (record.manager && !isMe(record.manager, settings)) {
    add('confirm', 'MANAGER_NOT_ME', `Lead's Manager is ${whoIs(record.manager)}, not you. Handle it anyway?`);
  }

  // 4. Is the VOI real, active inventory?
  let mode = 'quote';
  const crm = voi.status;
  if (crm === 'not-inventory') {
    add('confirm', 'NOT_INVENTORY', '"VIN required to use Accelerate" and no stock # — new-model order or trade lead, not real inventory. Draft alternatives instead?');
    mode = 'alternatives';
  } else if (crm === 'sold') {
    add('warn', 'VOI_SOLD', 'VOI is no longer in active inventory (sold). No price quote — drafting alternatives.');
    mode = 'alternatives';
  } else if (!voi.stock && !voi.vin) {
    add('confirm', 'NO_STOCK', 'No stock # or VIN found for the vehicle of interest. Type one in or decide how to handle it.');
    mode = 'ask';
  } else if (crm === 'unknown') {
    add('warn', 'STATUS_UNKNOWN', "Couldn't find \"View Photos / View VDP\" or a sold notice — status unconfirmed in CRM.");
  }

  // 5. You vs. the CRM vs. the website.
  if (userSaysSold && crm === 'active') {
    add('confirm', 'YOU_VS_CRM', "You marked this sold, but VinSolutions shows it active. Right customer/vehicle? Confirm to continue.");
  } else if (userSaysSold && mode === 'quote') {
    mode = 'alternatives';
  }
  if (inventory) {
    if (inventory.found && crm === 'sold') {
      add('warn', 'CRM_VS_SITE', 'CRM says sold, but the website still lists it (site can lag a day). Check before offering it.');
    }
    if (!inventory.found && mode === 'quote') {
      if (voi.crmPrice) {
        // VinSolutions has the unit and its Internet Price — the website is
        // only a cross-check, so this is a heads-up, not a stop.
        add('warn', 'NOT_ON_SITE', "Couldn't confirm this unit on the website, but VinSolutions has it active — using its Internet Price.");
      } else {
        add('confirm', 'NOT_ON_SITE', 'CRM shows active, but not found on the website by stock # OR model search. Enter the asking price manually or treat as sold.');
      }
    }
    if (inventory.found && voi.crmPrice && inventory.vehicle?.price && inventory.vehicle.price !== voi.crmPrice && mode === 'quote') {
      add('warn', 'PRICE_MISMATCH', `VinSolutions Internet Price is $${voi.crmPrice.toLocaleString('en-US')} but the website shows $${inventory.vehicle.price.toLocaleString('en-US')}. Using VinSolutions — check which is current.`);
    }
    if (inventory.found && !inventory.vehicle?.price && !voi.crmPrice && mode === 'quote') {
      add('warn', 'NO_SITE_PRICE', 'Found on the website but no SALE PRICE was readable — enter it manually.');
    }
  }

  // 6. Prioritization + tone.
  if (sharedWith.length) {
    add('info', 'SHARED_VOI', `🔥 Shared VOI — also the vehicle of interest for: ${sharedWith.join(', ')}.`);
  }
  const count = record.notes?.count;
  if (count === 0) add('info', 'TONE_FIRST', 'No notes/history — formal first-touch tone.');
  else if (count > 0) add('info', 'TONE_FOLLOWUP', `${count} notes/history entries — follow-up tone. Skim the notes below.`);
  else add('warn', 'NOTES_UNREAD', "Couldn't read the Notes & History count — defaulting to first-touch tone.");

  return { mode, flags };
}

export function unacknowledged(flags, acks) {
  return flags.filter((f) => f.level === 'confirm' && !acks[f.code]);
}

export function canDraft(result, acks) {
  if (result.mode === 'skip' || result.mode === 'ask') return false;
  return unacknowledged(result.flags, acks).length === 0;
}
