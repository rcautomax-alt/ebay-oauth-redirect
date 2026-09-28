import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomer, parseTaskGrid, classifyTaskType, detectSessionProblem } from '../src/lib/vin-parser.js';
import { parseVehicleTitle } from '../src/lib/vehicle.js';
import {
  parsePrice, vehiclesFromExtraction, findVehicle, pickAlternatives, stockSearchUrl, modelSearchUrl,
} from '../src/lib/inventory.js';
import { sharedVoi, toCsv, upsert } from '../src/lib/queue.js';
import { scrubPii } from '../src/lib/scrub.js';

const LABELS = ['SALE PRICE', 'Ritchey Price', 'Internet Price', 'Our Price'];

// Synthetic frames shaped like the VinSolutions layout (left task list,
// right customer detail). Real captures will replace these.
const leadInfoFrames = [
  { name: '', path: [''], isTop: true, url: 'https://vinsolutions.app.coxautoinc.com/', title: 'VinSolutions', text: 'Home', tables: [] },
  {
    name: 'rightpaneframe',
    path: ['', 'rightpaneframe'],
    url: 'https://vinsolutions.app.coxautoinc.com/CarDashboard/Lead.aspx',
    title: '',
    text: [
      'Customer: Jane Smith',
      'jane@example.com  (386) 555-0101',
      'Lead Info',
      'Task Type: Email',
      'Manager: Rick Clemons',
      'Vehicle Info',
      'Used 2011 Chrysler 300 Limited',
      'Stock #: 24123A   VIN: 2C3CA5CG1BH512345',
      'View Photos View VDP',
      'Trade-In',
      '2015 Honda Civic LX  Stock #: T9999',
      'Notes & History (3)',
      '9/20 Customer asked about tow package',
    ].join('\n'),
    tables: [],
  },
];

test('parses a Lead Info view', () => {
  const r = parseCustomer(leadInfoFrames);
  assert.equal(r.view, 'lead-info');
  assert.equal(r.customerName, 'Jane Smith');
  assert.equal(r.firstName, 'Jane');
  assert.equal(r.manager, 'Rick Clemons');
  assert.equal(r.task.type, 'email');
  assert.equal(r.voi.stock, '24123A');
  assert.equal(r.voi.vin, '2C3CA5CG1BH512345');
  assert.equal(r.voi.title, '2011 Chrysler 300 Limited');
  assert.equal(r.voi.model, '300');
  assert.equal(r.voi.status, 'active');
  assert.equal(r.notes.count, 3);
});

test('sold marker wins', () => {
  const frames = structuredClone(leadInfoFrames);
  frames[1].text = frames[1].text.replace('View Photos View VDP', 'This vehicle is no longer in your active inventory');
  assert.equal(parseCustomer(frames).voi.status, 'sold');
});

test('Accelerate with no stock = not inventory; "Stock #: VIN" is not a stock number', () => {
  const frames = structuredClone(leadInfoFrames);
  frames[1].text = 'Customer Dashboard\nManager: Arthur Deeley\nVehicle of Interest\n2026 GMC Sierra 1500 Denali\nStock #: VIN required to use Accelerate\nNotes & History (0)';
  const r = parseCustomer(frames);
  assert.equal(r.view, 'customer-dashboard');
  assert.equal(r.voi.stock, null);
  assert.equal(r.voi.status, 'not-inventory');
  assert.equal(r.voi.model, 'Sierra');
  assert.equal(r.notes.count, 0);
});

test('task type classification: calls always win', () => {
  assert.equal(classifyTaskType('Phone Call'), 'call');
  assert.equal(classifyTaskType('Email or call'), 'call');
  assert.equal(classifyTaskType('Text Message'), 'text');
  assert.equal(classifyTaskType('E-mail'), 'email');
  assert.equal(classifyTaskType(''), 'unknown');
});

test('task grid parsed by header names', () => {
  const frames = [{
    name: 'leftpaneframe', path: ['', 'leftpaneframe'], text: '',
    tables: [[
      ['', 'Customer', 'Task Type', 'Due', 'Manager'],
      ['', 'Jane Smith', 'Email', '9/28', 'Rick Clemons'],
      ['', 'Bob Jones', 'Phone Call', '9/28', 'Rick Clemons'],
    ]],
  }];
  const rows = parseTaskGrid(frames);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, 'email');
  assert.equal(rows[1].type, 'call');
});

test('session expiry detected', () => {
  assert.ok(detectSessionProblem([{ isTop: true, url: 'https://x/', text: 'Your session has expired' }]));
  assert.equal(detectSessionProblem(leadInfoFrames), null);
});

test('vehicle titles, including two-word makes', () => {
  assert.equal(parseVehicleTitle('2019 Land Rover Range Rover Sport HSE').make, 'Land Rover');
  assert.equal(parseVehicleTitle('2020 Toyota Camry SE Stock #: 123').title, '2020 Toyota Camry SE');
  assert.equal(parseVehicleTitle('no car here'), null);
});

test('SALE PRICE beats other prices; monthly payments ignored', () => {
  assert.equal(parsePrice('MSRP $40,000 Est. $399/mo SALE PRICE $32,995', LABELS), 32995);
  assert.equal(parsePrice('Sale Price:\n$ 28,450', LABELS), 28450);
  assert.equal(parsePrice('Payments from $399', LABELS), null);
});

test('vehicles from cards + JSON-LD, merged and matched by stock', () => {
  const extraction = {
    cards: [
      { text: 'Used 2011 Chrysler 300 Limited Stock #: 24123A SALE PRICE $12,995', data: { vin: '2C3CA5CG1BH512345' }, href: '/used-2011-chrysler-300.htm' },
      { text: 'Used 2012 Chrysler 300 S Stock #: 24200B SALE PRICE $14,500', data: {}, href: '' },
    ],
    jsonld: [JSON.stringify({ '@type': 'Car', name: '2013 Chrysler 300 C', vehicleIdentificationNumber: '2C3CCAET5DH123456', sku: '24300C', offers: { price: '17900' } })],
    bodyText: '',
  };
  const vs = vehiclesFromExtraction(extraction, LABELS, 'https://www.ritcheybuickgmc.com/searchused.aspx');
  assert.equal(vs.length, 3);
  const hit = findVehicle(vs, { stock: '24123a' });
  assert.equal(hit.price, 12995);
  assert.equal(hit.url, 'https://www.ritcheybuickgmc.com/used-2011-chrysler-300.htm');

  const alts = pickAlternatives(vs, { excludeStock: '24123A', targetPrice: 12995, window: 5000, limit: 3 });
  assert.deepEqual(alts.map((a) => a.stock), ['24200B', '24300C']);
  assert.equal(alts[1].inWindow, true);
});

test('single-VDP page with no cards still yields the vehicle', () => {
  const vs = vehiclesFromExtraction({ cards: [], jsonld: [], bodyText: '2020 Toyota Camry SE Stock #: P1234 SALE PRICE $21,000' }, LABELS, '');
  assert.equal(vs[0].stock, 'P1234');
  assert.equal(vs[0].price, 21000);
});

test('search URLs', () => {
  const base = 'https://www.ritcheybuickgmc.com/searchused.aspx';
  assert.equal(stockSearchUrl(base, ' 24123A '), `${base}?stock=24123A`);
  assert.equal(modelSearchUrl(base, 'Sierra 1500'), `${base}?model=Sierra%201500`);
});

test('shared VOI + queue upsert + CSV', () => {
  let q = [];
  q = upsert(q, { customerName: 'Jane Smith', stock: '24123A', flags: ['A', 'B'] });
  q = upsert(q, { customerName: 'Jane Smith', stock: '24123A', flags: ['A'] });
  q = upsert(q, { customerName: 'Bob Jones', stock: '24-123a' });
  assert.equal(q.length, 2);
  assert.deepEqual(sharedVoi(q, { stock: '24123A', customerName: 'Maria Lopez' }), ['Jane Smith', 'Bob Jones']);
  const csv = toCsv(q);
  assert.ok(csv.startsWith('Saved,Customer'));
  assert.ok(csv.includes('Jane Smith'));
});

test('capture scrubbing', () => {
  const s = scrubPii('Jane Smith jane@x.com (386) 555-0101 lives at 123 Main St. <input value="Jane">', ['Jane Smith']);
  assert.ok(!/jane|555|Main St/i.test(s), s);
});
