import { money, escapeHtml } from './format.js';
import { scrubPii } from './scrub.js';

// Freestyle messages: the panel builds a request you paste into Claude chat,
// then parses Claude's reply back into the Text / Email boxes. No API key.

export const STARTERS = [
  { label: 'Trade bump', text: "I'm willing to give $____ more for their trade-in. " },
  { label: 'Bad phone #', text: "The phone number we have for them isn't working. Ask for the best number to reach them. " },
  { label: 'Price drop', text: 'The price on their vehicle just dropped to $____. ' },
  { label: 'Back in stock', text: 'We just got in a vehicle that fits what they were looking for: ____. ' },
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

export function buildFreestylePrompt({ instruction, record, settings, lang = 'en', channels = { sms: true, email: true }, pricing = null, notesExcerpt = '' }) {
  const r = record || {};
  const s = settings;
  const want = [channels.sms && 'a text message', channels.email && 'an email'].filter(Boolean).join(' and ') || 'a text message and an email';
  const context = [
    `Customer first name: ${r.firstName || '[Customer First Name]'}`,
    r.vehicleTitle && `Vehicle of interest: ${r.vehicleTitle}${r.stock ? ` (Stock # ${r.stock})` : ''}`,
    r.crmStatus === 'sold' && 'Note: that vehicle has SOLD.',
    pricing &&
      `Pricing I've worked up: Asking ${money(pricing.asking)}, Manager Discount -${money(pricing.discount)}, Manager Special Price ${money(pricing.special)}, Price with Fees ${money(pricing.withFees)}`,
    r.notesCount !== null && r.notesCount !== undefined && r.notesCount !== '' && `Prior notes/history entries: ${r.notesCount}`,
  ].filter(Boolean);

  const notes = noteLines(notesExcerpt, r.customerName);

  return [
    `Help me write ${want} to a customer. I'm ${s.firstName}, ${s.title} at ${s.dealership}, a car dealership. My direct line is ${s.phone}.`,
    '',
    'WHAT I WANT TO SAY:',
    instruction.trim() || '(no instruction given)',
    '',
    'CUSTOMER CONTEXT:',
    ...context.map((c) => `- ${c}`),
    ...(notes ? ['', 'RECENT CRM NOTES (newest first, for context and tone only — do not quote them back):', notes] : []),
    '',
    'RULES:',
    `- Write in ${lang === 'es' ? 'Spanish (use "usted")' : 'English'}.`,
    '- Sound like a real person at a dealership: friendly, direct, professional. No hype, no emojis.',
    '- Only use facts and numbers I gave you. If something is missing, leave a clear blank like [____] instead of inventing it.',
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
