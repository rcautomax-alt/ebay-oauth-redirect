import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDrafts } from '../src/lib/templates.js';
import { computePricing } from '../src/lib/pricing.js';
import { DEFAULT_SETTINGS } from '../src/config/defaults.js';

const settings = DEFAULT_SETTINGS;
const pricing = computePricing({ asking: 12995, discount: 1000, fees: settings.fees });
const common = {
  customer: { firstName: 'Jane' },
  vehicleTitle: '2011 Chrysler 300',
  stock: '24123A',
  settings,
};

test('English quote email matches the Send Out Price template', () => {
  const d = buildDrafts({ ...common, mode: 'quote', pricing });
  assert.ok(d.emailText.startsWith('Hi Jane,'));
  assert.ok(d.emailText.includes('Thank you for your interest in the 2011 Chrysler 300.'));
  assert.ok(d.emailText.includes('Pre-Owned Sales Manager here at Ritchey Cadillac Buick GMC'));
  assert.ok(d.emailText.includes('Stock #: 24123A'));
  assert.ok(d.emailText.includes('MSRP / Asking Price: $12,995'));
  assert.ok(d.emailText.includes('Manager Discount: -$1,000'));
  assert.ok(d.emailText.includes('Your Manager Special Price: $11,995'));
  assert.ok(d.emailText.includes('Our Price with Fees: $13,326'));
  assert.ok(d.emailText.includes('(386) 236-5126'));
  assert.ok(d.emailText.includes('today or tomorrow?'));
  // Bold pricing values in HTML
  assert.ok(d.emailHtml.includes('<b>$12,995</b>'));
  assert.ok(d.emailHtml.includes('<b>Our Price with Fees: $13,326</b>'));
  // VinSolutions adds the signature itself
  assert.ok(!d.emailText.includes('998 North Nova'));
});

test('English text message uses the special price by default', () => {
  const d = buildDrafts({ ...common, mode: 'quote', pricing });
  assert.equal(
    d.sms,
    'Hi Jane, this is Rick, Pre-Owned Sales Manager at Ritchey Cadillac Buick GMC. I reviewed the 2011 Chrysler 300 you’re interested in and put together special manager pricing of $11,995 for you. Do you have a few minutes to connect today?',
  );
  const d2 = buildDrafts({ ...common, mode: 'quote', pricing, settings: { ...settings, textPriceField: 'withFees' } });
  assert.ok(d2.sms.includes('$13,326'));
});

test('follow-up tone when notes exist', () => {
  const d = buildDrafts({ ...common, mode: 'quote', pricing, followUp: true });
  assert.ok(d.emailText.includes('continued interest'));
  assert.ok(d.sms.includes('following up'));
});

test('Spanish quote', () => {
  const d = buildDrafts({ ...common, mode: 'quote', pricing, lang: 'es' });
  assert.ok(d.emailText.startsWith('Hola Jane,'));
  assert.ok(d.emailText.includes('Nuestro precio con cargos: $13,326'));
  assert.ok(d.sms.includes('$11,995'));
});

test('alternatives draft has no price quote for the sold unit', () => {
  const d = buildDrafts({
    ...common,
    mode: 'alternatives',
    alternatives: [{ title: '2012 Chrysler 300 S', stock: '24200B', price: 14500 }],
  });
  assert.ok(d.emailText.includes('already sold'));
  assert.ok(d.emailText.includes('2012 Chrysler 300 S — Stock # 24200B — $14,500'));
  assert.ok(!d.emailText.includes('Manager Discount'));
  assert.ok(d.sms.includes('just sold'));
});

test('customer names are HTML-escaped', () => {
  const d = buildDrafts({ ...common, customer: { firstName: '<b>x' }, mode: 'quote', pricing });
  assert.ok(d.emailHtml.includes('&lt;b&gt;x'));
});
