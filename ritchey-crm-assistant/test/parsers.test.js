import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomer, parseTaskList, classifyTaskType, detectSessionProblem } from '../src/lib/vin-parser.js';
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
      'SALES MGR: Day 10. Send out Manager Special Price Quote',
      'Template: *10 Day: MGR | Send Out Price\tAssigned To: Rick Clemons',
      'Lead Info',
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
  assert.equal(r.task.isPriceQuote, true);
  assert.equal(r.assignedTo, 'Rick Clemons');
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

test('task type classification', () => {
  assert.equal(classifyTaskType('SALES MGR: Day 10. Call Customer with Manager Special Price.'), 'call');
  assert.equal(classifyTaskType('SALES MGR: Day 10. Send out Manager Special Price Quote Template: *10 Day: MGR | Send Out Price'), 'email');
  assert.equal(classifyTaskType('Sales Manager - Sold Delivered 5 days ago Template: Thank You for Purchase Script'), 'call');
  // The customer's own words don't turn a text reply into a call
  assert.equal(classifyTaskType("Text Message Reply Received: can you call me?"), 'text');
  assert.equal(classifyTaskType('MGR: Check did Salesperson Send out Video?'), 'other');
  assert.equal(classifyTaskType('Sales rep changed to Joshua Rourke by John Huger'), 'other');
  assert.equal(classifyTaskType('VISIT: NEXT DAY SAVE-A-DEAL.'), 'other');
  assert.equal(classifyTaskType('Phone Call'), 'call');
  assert.equal(classifyTaskType(''), 'unknown');
});

// Shaped like the My Tasks screen (names are made up).
const MY_TASKS = [
  'My Tasks (28)',
  'Details',
  'Replies (1)',
  'Customer\tHot\tStatus / Source\tUpdated\tAge\tEngagement Strength',
  'Hannah Hill',
  '2017 GMC Acadia Limited [142087A]\t\tActive Lead',
  'Combined R. Autos Website\t9/28/26',
  '11:17am\t11',
  "Text Message Reply Received: I've found other Acadias, can you call me?",
  'Assigned To: Rick Clemons',
  'Edit\tDismiss',
  'Call Tracking Tasks (0)',
  'Sorry, no leads found.',
  'Follow Ups (18)',
  'Customer\tHot\tStatus / Source\tUpdated\tAge\tEngagement Strength',
  'Robert Sample',
  '2004 Toyota Sienna [183706A]\t\tDelivered',
  'Repeat Customer\t9/25/26',
  '8:36am\t11',
  'Sales Manager - Sold Delivered 5 days ago - Make sure all is well. Template: "Thank You for Purchase Script"\tAssigned To: Rick Clemons',
  'Edit\tDismiss',
  'Faith Cole',
  '2022 Kia K5 [242239A]\t\tActive Lead',
  'Carfax, Inc\t9/27/26',
  '3:46pm\t11',
  'SALES MGR: Day 10. Call Customer with Manager Special Price.',
  'Assigned To: Rick Clemons',
  'Edit\tDismiss',
  'SALES MGR: Day 10. Send out Manager Special Price Quote',
  'Template: *10 Day: MGR | Send Out Price\tAssigned To: Rick Clemons',
  'Edit\tDismiss',
  'Jordan Pryce',
  '2020 Cadillac XT4 (117222A)\t\tWaiting for prospect response',
  'Carfax, Inc\t9/28/26',
  '5:29pm\t1',
  'Sales rep changed to Joshua Rourke by John Huger',
  'Assigned To: Rick Clemons',
  'MGR: Check did Salesperson Send out Video?',
  'Assigned To: Rick Clemons',
  'Pat Lambert',
  '2026 Toyota RAV4 [1094868]\t\tAppointment Set',
  'Autoweb\t9/29/26',
  'Sales rep changed to John Carroll by Rick Clemons',
  'Assigned To: Rick Clemons',
  'Don Swift\t\tWaiting for prospect response',
  '2026 Toyota RAV4 [1094868]',
  'SALES MGR: Day 10. Send out Manager Special Price Quote',
  'Template: *10 Day: MGR | Send Out Price\tAssigned To: Michael Crynock',
].join('\n');

test('My Tasks list: tasks, types, price quotes, sections, shared VOI', () => {
  const tasks = parseTaskList([{ name: 'leftpaneframe', path: ['', 'leftpaneframe'], text: MY_TASKS, tables: [] }]);
  const brief = tasks.map((t) => `${t.customer}|${t.stock}|${t.type}${t.isPriceQuote ? '|$' : ''}`);
  assert.deepEqual(brief, [
    'Hannah Hill|142087A|text',
    'Robert Sample|183706A|call',
    'Faith Cole|242239A|call',
    'Faith Cole|242239A|email|$',
    'Jordan Pryce|117222A|other',
    'Jordan Pryce|117222A|other',
    'Pat Lambert|1094868|other',
    'Don Swift|1094868|email|$',
  ]);
  const faithQuote = tasks[3];
  assert.equal(faithQuote.template, '*10 Day: MGR | Send Out Price');
  assert.equal(faithQuote.description, 'SALES MGR: Day 10. Send out Manager Special Price Quote');
  assert.equal(tasks[1].template, 'Thank You for Purchase Script');
  assert.ok(tasks[1].description.startsWith('Sales Manager - Sold Delivered'));
  assert.equal(tasks[0].section, 'Replies');
  assert.equal(tasks[7].assignedTo, 'Michael Crynock');
  assert.deepEqual(tasks[7].sharedWith, ['Pat Lambert']);
  assert.deepEqual(tasks[3].sharedWith, []);
});

// Shaped like the Customer Dashboard with Lead Info / Vehicle Info side by
// side (tab-interleaved columns) and a sold VOI.
const DASHBOARD_SOLD = [
  'Customer Dashboard',
  'Jordan Pryce',
  '(Individual)',
  'H: (386) 555-0100',
  'jp@example.com',
  'Sales rep changed to Joshua Rourke by John Huger',
  'Assigned To: Rick Clemons',
  'Key Information',
  'Equity: $83,520 2024 Cadillac Escalade Calculated: 08/11/2026',
  'Inbox\tHot\tCall\tEmail\tAppt.\tNote\tLost\tBad\tSold\tVisit\tLetter\tText',
  'Lead Info\tVehicle Info',
  'Status:\tWaiting for Prospect Response\t2020 Cadillac XT4 FWD Premium Luxury (Used)',
  'Sales Rep:\tJoshua Rourke\tFWD Sport Utility (4 Door)',
  'BD Agent:\tArthur Deeley\tStock #: 117222A',
  'Manager:\tRick Clemons\t1GYFZCR43LF123456',
  'Created:\t9/28/26 3:35p (1d)\tOdom: 24,382',
  'Warning: This vehicle is no longer in your active inventory',
  'View Photos\tDeal Central',
  'Vehicle(s) of Interest',
  'Trade-in Info',
  '(none entered)',
].join('\n');

test('Customer Dashboard + Lead Info: name, manager (not BD agent), bare VIN, sold', () => {
  const r = parseCustomer([{ name: 'rightpaneframe', path: ['', 'rightpaneframe'], text: DASHBOARD_SOLD, tables: [] }]);
  assert.equal(r.customerName, 'Jordan Pryce');
  assert.equal(r.manager, 'Rick Clemons');
  assert.equal(r.assignedTo, 'Rick Clemons');
  assert.equal(r.voi.title, '2020 Cadillac XT4 FWD Premium Luxury');
  assert.equal(r.voi.stock, '117222A');
  assert.equal(r.voi.vin, '1GYFZCR43LF123456');
  assert.equal(r.voi.status, 'sold');
  assert.equal(r.task.type, 'other');
});

test('Customer Dashboard with no lead: equity/sales vehicles are NOT taken as the VOI', () => {
  const text = [
    'Customer Dashboard',
    'Robert Sample',
    '(Individual)',
    'Sales Manager - Sold Delivered 5 days ago - Make sure all is well. Template: "Thank You for Purchase Script" Dismiss Edit',
    'Assigned To: Rick Clemons',
    'Equity: $83,520 2024 Cadillac Escalade Calculated: 08/11/2026',
    'Sales (2)\tService Lead (6)\tWish List\tValue',
    'Sold\t9/18/26\tRepeat Customer\t2024 Toyota Sienna',
  ].join('\n');
  const r = parseCustomer([{ name: 'rightpaneframe', path: ['', 'rightpaneframe'], text, tables: [] }]);
  assert.equal(r.customerName, 'Robert Sample');
  assert.equal(r.voi.title, null);
  assert.equal(r.voi.stock, null);
  assert.equal(r.task.type, 'call');
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

// Rows shaped exactly like probeTaskList() returns from the real My Tasks
// table (names made up).
test('structured task rows: icon decides the type; email + text Send Out Price; no-stock leads', async () => {
  const { tasksFromDom } = await import('../src/lib/vin-parser.js');
  const rows = [
    {
      rowKey: '1', customer: 'Faith Cole', vehicle: '2022 Kia K5 [242239A]', section: 'Follow Ups', status: 'Active Lead',
      tasks: [
        { taskId: 'a', icon: 'Phone', note: 'SALES MGR: Day 10. Call Customer with Manager Special Price.', template: '', assignedTo: 'Rick Clemons' },
        { taskId: 'b', icon: 'Email', note: 'SALES MGR: Day 10. Send out Manager Special Price Quote', template: '*10 Day: MGR | Send Out Price', assignedTo: 'Rick Clemons' },
        { taskId: 'c', icon: 'Text', note: 'SALES MGR: Day 10. Send out Manager Special Price Quote', template: '*10 Day: MGR | Send Out Price.', assignedTo: 'Rick Clemons' },
      ],
    },
    {
      rowKey: '2', customer: 'Latoya Park', vehicle: '2022 Kia K5 [242239A]', section: 'Follow Ups',
      tasks: [{ taskId: 'd', icon: 'Generic', note: 'MISSED Appointment - reach out to make contact and save the deal!', template: '', assignedTo: 'Rick Clemons' }],
    },
    {
      rowKey: '3', customer: 'Chad Walt', vehicle: '2026 Chevrolet Silverado 1500', section: 'Follow Ups',
      tasks: [{ taskId: 'e', icon: 'Text', note: 'SP: Day 5 Contacted internet lead. Send a custom text message.', template: 'SP: Blank Text', assignedTo: 'Rick Clemons' }],
    },
    {
      rowKey: '4', customer: 'Steve Denn', vehicle: '2019 GMC Acadia [P12138]', section: 'Overdue Tasks',
      tasks: [{ taskId: 'f', icon: 'Email', note: 'USED SALES MANAGER: EMAIL Day:4 | OFF Pace... Today Only Deal', template: 'PQ | *04 Day: SM | Off Pace Today Only Deal', assignedTo: 'Rick Clemons' }],
    },
    {
      rowKey: '5', customer: 'Alert Only', vehicle: '', section: 'Follow Ups',
      tasks: [{ taskId: 'g', icon: 'Alert', note: 'You have been assigned to this customer', template: '', assignedTo: 'Rick Clemons' }],
    },
  ];
  const t = tasksFromDom([...rows, rows[0]]); // duplicate row from a second frame is ignored
  assert.deepEqual(t.map((x) => `${x.customer}|${x.stock || '-'}|${x.type}${x.isPriceQuote ? '|$' : ''}`), [
    'Faith Cole|242239A|call',
    'Faith Cole|242239A|email|$',
    'Faith Cole|242239A|text|$',
    'Latoya Park|242239A|other',
    'Chad Walt|-|text',
    'Steve Denn|P12138|email',
    'Alert Only|-|other',
  ]);
  assert.equal(t[0].vehicle, '2022 Kia K5');
  assert.equal(t[4].vehicle, '2026 Chevrolet Silverado 1500');
  assert.deepEqual(t[1].sharedWith, ['Latoya Park']);
});

test('frames are matched by URL even when they have no names', async () => {
  const { splitPanes } = await import('../src/lib/vin-parser.js');
  const frames = [
    { name: 'carfax', isTop: true, url: 'https://vinsolutions.app.coxautoinc.com/vinconnect/#/CarDashboard/Pages/LeadManagement/ActiveLeadsLayout.aspx?x', text: 'My Tasks' },
    { name: '', url: 'https://vinsolutions.app.coxautoinc.com/CarDashboard/Pages/CRM/CustomerDashboard.aspx?x', text: 'Customer Dashboard' },
    { name: '', url: 'https://vinsolutions.app.coxautoinc.com/CarDashboard/Pages/rims2.aspx?x', text: 'Lead Info' },
  ];
  const { left, right } = splitPanes(frames);
  assert.deepEqual(left.map((f) => f.text), ['My Tasks']);
  assert.deepEqual(right.map((f) => f.text), ['Customer Dashboard', 'Lead Info']);
});

test('exact VIN/stock search URL matches the VinSolutions View VDP link', async () => {
  const { stockOrVinUrl } = await import('../src/lib/inventory.js');
  assert.equal(
    stockOrVinUrl('https://www.ritcheybuickgmc.com/searchall.aspx', '1GKKRSKD2HJ284655'),
    'https://www.ritcheybuickgmc.com/searchall.aspx?stockOrVIN=1GKKRSKD2HJ284655&q=1GKKRSKD2HJ284655',
  );
});

test('alternatives keep units whose price could not be read; miles are parsed', async () => {
  const { pickAlternatives, parseVehicleCard } = await import('../src/lib/inventory.js');
  const alts = pickAlternatives(
    [
      { title: '2013 Chrysler 200', stock: 'SOLD1', price: 9995 },
      { title: '2014 Chrysler 200', stock: 'NEW2', price: null },
      { title: '2012 Chrysler 200', stock: 'OLD3', price: 8995 },
    ],
    { excludeStock: 'SOLD1', targetPrice: null, window: 5000, limit: 3 },
  );
  assert.deepEqual(alts.map((a) => a.stock), ['OLD3', 'NEW2']);
  const v = parseVehicleCard({ text: '2014 Chrysler 200 Limited Stock #: NEW2 Mileage: 61,234 SALE PRICE $11,995', data: {} }, LABELS, '');
  assert.equal(v.miles, 61234);
});

test('a search that gets forwarded to a homepage is reported, not read as "no vehicles"', async () => {
  const { searchDropped } = await import('../src/lib/inventory.js');
  assert.match(searchDropped('https://www.ritcheybuickgmc.com/searchused.aspx?model=200', 'https://www.ritcheyautos.com/'), /redirected to https:\/\/www.ritcheyautos.com\//);
  assert.equal(searchDropped('https://www.ritcheyautos.com/searchused.aspx?model=200', 'https://www.ritcheyautos.com/searchused.aspx?model=200'), null);
  assert.equal(searchDropped('https://www.ritcheyautos.com/vdp/123', 'https://www.ritcheyautos.com/vdp/123'), null);
});

test('group site: only your stores are offered; unlabeled listings are "unknown"', async () => {
  const { storeOf } = await import('../src/lib/inventory.js');
  const A = ['Daytona'];
  const X = ['Dublin', 'Melbourne'];
  assert.deepEqual(storeOf({ listingText: 'Used 2014 Chrysler 200 Located at Ritchey Subaru of Daytona' }, A, X), { status: 'allowed', where: 'Daytona' });
  assert.deepEqual(storeOf({ listingText: 'Used 2014 Chrysler 200 Ritchey Automotive Melbourne' }, A, X), { status: 'excluded', where: 'Melbourne' });
  assert.equal(storeOf({ listingText: 'Used 2014 Chrysler 200' }, A, X).status, 'unknown');
  // A group tagline that names every store doesn't decide it; a location field does.
  assert.equal(storeOf({ listingText: 'Serving Daytona, Melbourne and Dublin' }, A, X).status, 'unknown');
  assert.deepEqual(storeOf({ location: 'Dublin', listingText: 'Serving Daytona, Melbourne and Dublin' }, A, X), { status: 'excluded', where: 'Dublin' });
});
