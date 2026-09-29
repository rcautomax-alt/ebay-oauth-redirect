import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, canDraft, isMe } from '../src/lib/rules.js';
import { DEFAULT_SETTINGS } from '../src/config/defaults.js';

const settings = DEFAULT_SETTINGS;
const base = () => ({
  customerName: 'Jane Smith',
  manager: 'Rick Clemons',
  task: { type: 'email' },
  voi: { stock: '24123A', vin: '1G6AB5RX4H0123456', status: 'active' },
  notes: { count: 0 },
});
const codes = (r) => r.flags.map((f) => f.code);

test('clean active quote: no confirms, first-touch tone', () => {
  const r = evaluate(base(), { settings });
  assert.equal(r.mode, 'quote');
  assert.ok(codes(r).includes('TONE_FIRST'));
  assert.ok(canDraft(r, {}));
});

test('call tasks are skipped and can never be drafted', () => {
  const rec = { ...base(), task: { type: 'call' } };
  const r = evaluate(rec, { settings });
  assert.equal(r.mode, 'skip');
  assert.equal(canDraft(r, { CALL_TASK: true }), false);
});

test('unknown task type needs confirmation', () => {
  const r = evaluate({ ...base(), task: { type: 'unknown' } }, { settings });
  assert.ok(codes(r).includes('TASK_TYPE_UNKNOWN'));
  assert.equal(canDraft(r, {}), false);
  assert.equal(canDraft(r, { TASK_TYPE_UNKNOWN: true }), true);
});

test('task assigned to BDC agent needs confirmation and names them', () => {
  const r = evaluate({ ...base(), manager: 'Arthur Deeley' }, { settings });
  const f = r.flags.find((x) => x.code === 'MANAGER_NOT_ME');
  assert.ok(f && f.message.includes('Arthur Deeley'));
  assert.equal(canDraft(r, {}), false);
});

test('internal tasks are skipped', () => {
  const r = evaluate({ ...base(), task: { type: 'other' } }, { settings });
  assert.equal(r.mode, 'skip');
  assert.equal(r.flags[0].code, 'NOT_CONTACT_TASK');
});

test('task Assigned To someone else needs confirmation even if Manager is me', () => {
  const r = evaluate({ ...base(), assignedTo: 'Michael Crynock' }, { settings });
  assert.ok(r.flags.find((f) => f.code === 'TASK_NOT_MINE').message.includes('Michael Crynock'));
  assert.equal(canDraft(r, {}), false);
});

test('Assigned To me with no Manager field is fine', () => {
  const r = evaluate({ ...base(), manager: null, assignedTo: 'Rick Clemons' }, { settings });
  assert.ok(!codes(r).some((c) => /MANAGER|NOT_MINE/.test(c)));
});

test('manager field variants that are still me', () => {
  assert.ok(isMe('Clemons, Rick', settings));
  assert.ok(isMe('Rick Clemons (Pre-Owned Sales Manager)', settings));
  assert.equal(isMe('Michael Crynock', settings), false);
});

test('sold VOI switches to alternatives', () => {
  const rec = base();
  rec.voi.status = 'sold';
  assert.equal(evaluate(rec, { settings }).mode, 'alternatives');
});

test('Accelerate / no stock = not inventory, needs confirmation', () => {
  const rec = base();
  rec.voi = { stock: null, vin: null, status: 'not-inventory' };
  const r = evaluate(rec, { settings });
  assert.equal(r.mode, 'alternatives');
  assert.ok(codes(r).includes('NOT_INVENTORY'));
});

test('no stock and no VIN = ask', () => {
  const rec = base();
  rec.voi = { stock: null, vin: null, status: 'unknown' };
  assert.equal(evaluate(rec, { settings }).mode, 'ask');
});

test('you say sold but CRM says active: discrepancy flag, not a silent switch', () => {
  const r = evaluate(base(), { settings, userSaysSold: true });
  assert.ok(codes(r).includes('YOU_VS_CRM'));
  assert.equal(r.mode, 'quote');
});

test('CRM active but not on website after model search needs confirmation', () => {
  const r = evaluate(base(), { settings, inventory: { found: false } });
  assert.ok(codes(r).includes('NOT_ON_SITE'));
});

test('shared VOI is flagged', () => {
  const r = evaluate(base(), { settings, sharedWith: ['Bob Jones'] });
  assert.ok(r.flags.find((f) => f.code === 'SHARED_VOI').message.includes('Bob Jones'));
});

test('notes present = follow-up tone', () => {
  const rec = base();
  rec.notes.count = 4;
  assert.ok(codes(evaluate(rec, { settings })).includes('TONE_FOLLOWUP'));
});

test('customer on screen differs from the task you picked', () => {
  const r = evaluate(base(), { settings, expectedCustomer: 'Maria Lopez' });
  assert.ok(codes(r).includes('CUSTOMER_MISMATCH'));
});
