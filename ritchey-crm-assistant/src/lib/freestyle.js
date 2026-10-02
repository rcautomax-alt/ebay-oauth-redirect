import { money, escapeHtml } from './format.js';
import { scrubPii } from './scrub.js';

// Freestyle messages: the panel builds a request you paste into Claude chat,
// then parses Claude's reply back into the Text / Email boxes. No API key.

export const STARTERS = [
  { label: 'Trade bump', text: "I'm willing to give $____ more for their trade-in. " },
  { label: 'Bad phone #', text: "The phone number we have for them isn't working. Ask for the best number to reach them. " },
  { label: 'Price drop', text: 'The price on their vehicle just dropped to $____. ' },
  { label: 'Similar one came in', text: 'The vehicle they wanted sold, but we just took in a similar one (see vehicle below). Let them know and send the link. ' },
  { label: 'Checking in', text: "Just checking in — haven't heard back in a while, no pressure. " },
];

function noteLines(excerpt, fullName) {
  if (!excerpt) return '';
  const cleaned = scrubPii(excerpt, fullName ? [fullName] : [])
    .replace(/\t+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return cleaned.length > 1500 ? `${cleaned.slice(0, 1500)}…` : cleaned;
}

// The default ask for the 🏷️ best-deal button (Autoweb-style leads).
export function bestDealInstruction({ goodThrough = '' } = {}) {
  return [
    'Send them our special internet pricing on this vehicle.',
    'Show the savings clearly (price, my discount, their special price) and make them feel they are getting a special deal set aside for them as an online shopper.',
    goodThrough ? `This pricing is good through ${goodThrough.trim()}.` : '',
    'Invite them in to see it and lock it in.',
  ]
    .filter(Boolean)
    .join(' ');
}

function vehicleLine(v) {
  return [
    v.title || 'Vehicle',
    v.miles && `${Number(v.miles).toLocaleString('en-US')} miles`,
    v.stock && `Stock # ${v.stock}`,
    v.price && `Price ${money(v.price)}`,
    v.link && `Link: ${v.link}`,
    v.note,
  ]
    .filter(Boolean)
    .join(' | ');
}

export function buildFreestylePrompt({ instruction, record, settings, lang = 'en', channels = { sms: true, email: true }, pricing = null, notesExcerpt = '', vehicles = [], deal = null }) {
  const r = record || {};
  const s = settings;
  const want = [channels.sms && 'a text message', channels.email && 'an email'].filter(Boolean).join(' and ') || 'a text message and an email';
  const context = [
    `Customer first name: ${r.firstName || '[Customer First Name]'}`,
    r.vehicleTitle && `Vehicle of interest: ${r.vehicleTitle}${r.stock ? ` (Stock # ${r.stock})` : ''}`,
    r.crmStatus === 'sold' && 'Note: that vehicle has SOLD.',
    r.crmStatus === 'not-inventory' && 'Note: that vehicle is not in our inventory.',
    pricing &&
      `Pricing I've worked up: Asking ${money(pricing.asking)}, Manager Discount -${money(pricing.discount)}, Manager Special Price ${money(pricing.special)}, Price with Fees ${money(pricing.withFees)}`,
    r.notesCount !== null && r.notesCount !== undefined && r.notesCount !== '' && `Prior notes/history entries: ${r.notesCount}`,
    r.leadSource && `Lead source: ${r.leadSource}`,
  ].filter(Boolean);

  // Best-deal framing: they clicked an online "get the best price" offer.
  const dealLines = deal
    ? [
        '',
        'DEAL CONTEXT:',
        `- This customer came in through ${r.leadSource || 'an online lead service (e.g. Autoweb)'}: they clicked a link to get the best deal, so they are expecting a real offer. Lead with the savings.`,
        pricing
          ? `- Show the numbers plainly: price ${money(pricing.asking)}, my discount -${money(pricing.discount)}, their special price ${money(pricing.special)} (${money(pricing.withFees)} with fees). In the email, put these on their own lines with **bold** amounts.`
          : '- I have not set the numbers yet: leave clear blanks like [$____] for the price, discount and special price.',
        '- Make it feel like special pricing reserved for them as an online shopper — warm and confident, not pushy or salesy.',
        deal.goodThrough
          ? `- The pricing is good through ${deal.goodThrough}; say so once.`
          : '- Do NOT invent a deadline, expiration date, rebate, incentive or condition.',
        '- In the text, mention the special price (not every line item) and ask when they can come see it.',
      ]
    : [];

  const notes = noteLines(notesExcerpt, r.customerName);

  return [
    `Help me write ${want} to a customer. I'm ${s.firstName}, ${s.title} at ${s.dealership}, a car dealership. My direct line is ${s.phone}.`,
    '',
    'WHAT I WANT TO SAY:',
    instruction.trim() || '(no instruction given)',
    '',
    'CUSTOMER CONTEXT:',
    ...context.map((c) => `- ${c}`),
    ...dealLines,
    ...(vehicles.length
      ? ['', 'VEHICLE(S) TO MENTION (include each link exactly as written, in both the text and the email):', ...vehicles.map((v) => `- ${vehicleLine(v)}`)]
      : []),
    ...(notes ? ['', 'RECENT CRM NOTES (newest first, for context and tone only — do not quote them back):', notes] : []),
    '',
    'DEFAULTS (my instructions above win if they conflict):',
    `- Write in ${lang === 'es' ? 'Spanish (use "usted")' : 'English'}.`,
    '- Sound like a real person at a dealership: friendly, direct, professional. No hype, no emojis.',
    '- Only use facts, numbers and links I gave you. If something is missing, leave a clear blank like [____] instead of inventing it.',
    '- Put links on their own, as plain URLs — do not shorten or change them.',
    '- Match the tone of the notes if there are any; otherwise keep it polite and professional.',
    '- End with one simple question or next step.',
    '- Text message: under 320 characters, starts with "Hi [first name], this is Rick…" style intro, no signature.',
    '- Email: short paragraphs, **bold** only for key numbers, no signature (my CRM adds it). Start with "Hi [first name],".',
    '',
    'REPLY IN EXACTLY THIS FORMAT (keep the labels, nothing before or after):',
    ...(channels.sms !== false ? ['TEXT:', '<the text message>', ''] : []),
    ...(channels.email !== false ? ['EMAIL SUBJECT:', '<subject line>', '', 'EMAIL:', '<the email body>'] : []),
  ].join('\n');
}

// Pull TEXT / EMAIL SUBJECT / EMAIL out of Claude's reply. Tolerates
// markdown dressing like "**TEXT:**" or "### Email".
export function parseClaudeReply(reply) {
  const out = { sms: '', subject: '', email: '' };
  const labelRe = /^\s*(?:#+\s*)?\**\s*(text(?: message)?|sms|email subject|subject(?: line)?|email(?: body)?)\s*\**\s*:?\s*\**\s*(.*)$/i;
  let current = null;
  const buf = { sms: [], subject: [], email: [] };
  for (const line of String(reply || '').replace(/\r/g, '').split('\n')) {
    const m = line.match(labelRe);
    // A label line: either "TEXT:" alone, or "Subject: Your trade" on one line.
    if (m && (/:\s*|\*\*$/.test(line) || !m[2])) {
      const label = m[1].toLowerCase();
      current = label.startsWith('email subject') || label.startsWith('subject') ? 'subject' : label.startsWith('email') ? 'email' : 'sms';
      if (m[2] && m[2].trim()) buf[current].push(m[2].trim());
      continue;
    }
    if (current) buf[current].push(line);
  }
  for (const k of Object.keys(buf)) out[k] = buf[k].join('\n').trim().replace(/^```\w*\n?|\n?```$/g, '').trim();
  out.subject = out.subject.replace(/^\*+|\*+$/g, '').split('\n')[0].trim();
  // No labels at all: treat the whole reply as the text message.
  if (!out.sms && !out.email && !out.subject) out.sms = String(reply || '').trim();
  return out;
}

// Email body -> HTML for the preview/rich copy: paragraphs, line breaks,
// **bold**.
export function emailTextToHtml(text) {
  return String(text || '')
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}
