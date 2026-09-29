import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFreestylePrompt, parseClaudeReply, emailTextToHtml } from '../src/lib/freestyle.js';
import { DEFAULT_SETTINGS } from '../src/config/defaults.js';
import { computePricing } from '../src/lib/pricing.js';

const record = {
  customerName: 'Hannah Hill',
  firstName: 'Hannah',
  vehicleTitle: '2017 GMC Acadia Limited',
  stock: '142087N',
  crmStatus: 'active',
  notesCount: 34,
};

test('prompt carries the ask, context, rules and reply format — and no phone/email', () => {
  const p = buildFreestylePrompt({
    instruction: "I'm willing to give $1,500 more for her trade.",
    record,
    settings: DEFAULT_SETTINGS,
    pricing: computePricing({ asking: 24995, discount: 1000, fees: DEFAULT_SETTINGS.fees }),
    notesExcerpt: 'Notes & History (34)\n09/28/2026 2:26 PM\nInbound Text Message\nReceived from: (904) 555-1996\nHannah Hill says I found other Acadias hannah@example.com',
  });
  assert.ok(p.includes("I'm willing to give $1,500 more for her trade."));
  assert.ok(p.includes('Customer first name: Hannah'));
  assert.ok(p.includes('2017 GMC Acadia Limited (Stock # 142087N)'));
  assert.ok(p.includes('Manager Special Price $23,995'));
  assert.ok(p.includes('I found other Acadias'));
  assert.ok(!p.includes('555-1996') && !p.includes('hannah@example.com') && !p.includes('Hannah Hill'));
  assert.ok(p.includes('TEXT:') && p.includes('EMAIL SUBJECT:') && p.includes('EMAIL:'));
  assert.ok(p.includes('(386) 236-5126'));
});

test('prompt asks only for the channels picked, in Spanish when set', () => {
  const p = buildFreestylePrompt({ instruction: 'x', record, settings: DEFAULT_SETTINGS, channels: { sms: true, email: false }, lang: 'es' });
  assert.ok(p.includes('write a text message to'));
  assert.ok(!p.includes('EMAIL:'));
  assert.ok(p.includes('Spanish'));
});

test('parses a clean reply', () => {
  const r = parseClaudeReply('TEXT:\nHi Hannah, this is Rick.\n\nEMAIL SUBJECT:\nMore for your trade\n\nEMAIL:\nHi Hannah,\n\nGood news.\n\nThanks,');
  assert.equal(r.sms, 'Hi Hannah, this is Rick.');
  assert.equal(r.subject, 'More for your trade');
  assert.equal(r.email, 'Hi Hannah,\n\nGood news.\n\nThanks,');
});

test('parses markdown-dressed labels and same-line subject', () => {
  const r = parseClaudeReply("Here you go!\n\n**TEXT:**\nHi Hannah — quick one.\n\n**Email Subject:** Your trade-in\n\n### EMAIL\nHi Hannah,\n\nI can do **$1,500** more.");
  assert.equal(r.sms, 'Hi Hannah — quick one.');
  assert.equal(r.subject, 'Your trade-in');
  assert.equal(r.email, 'Hi Hannah,\n\nI can do **$1,500** more.');
});

test('a reply with no labels becomes the text', () => {
  assert.equal(parseClaudeReply('Hi Hannah, call me.').sms, 'Hi Hannah, call me.');
});

test('email text to HTML keeps paragraphs and bold, escapes the rest', () => {
  assert.equal(emailTextToHtml('Hi <b>,\n\nI can do **$1,500** more.\nThanks'), '<p>Hi &lt;b&gt;,</p>\n<p>I can do <b>$1,500</b> more.<br>Thanks</p>');
});
