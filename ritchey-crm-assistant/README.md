# Ritchey CRM Assistant (v0.5.1)

A Chrome extension that sits in a side panel next to VinSolutions. It reads the customer you have open, checks the vehicle of interest against the website (ritcheyautos.com), and drafts the **"\*10 Day: MGR | Send Out Price"** text and email for you to review.

**It never sends anything.** Drafts get copied and pasted by you.

---

## Install (one time, ~2 minutes)

1. Download this folder: on GitHub, open the branch, click **Code → Download ZIP**, and unzip it somewhere permanent (e.g. `Documents\ritchey-crm-assistant`). Chrome loads it from that spot, so don't delete it.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and pick the `ritchey-crm-assistant` folder (the one containing `manifest.json`).
5. Click the puzzle-piece icon in the toolbar and **pin** "Ritchey CRM Assistant."
6. Click the pinned icon to open the side panel.

**Updating:** replace the folder contents with the new version, then hit the ↻ reload arrow on the extension card at `chrome://extensions`.

> If your VinSolutions URL isn't on `*.vinsolutions.com`, `*.vinmanager.com` or `*.coxautoinc.com`, add it to `host_permissions` in `manifest.json` and reload.

---

## Daily flow

1. **Read Task List** while My Tasks is showing. The panel lists **customers who need a Send Out Price** (uncheck the filter to see everyone). Each task's type comes from VinSolutions' own icon: 📞 call (yours), ✉️ email, 💬 text, ⚙️ internal. Also shown:
   - 💲 marks the "*10 Day: MGR | Send Out Price" tasks, and whether VinSolutions wants them by email, text, or both.
   - 🔥 **shared** means another customer on the list has the same stock #.
   - **sold?** means the vehicle is struck through in the list.
   - **✓ drafted** means the customer is already saved in today's queue.
2. **Click a customer's name.** The panel clicks them open in VinSolutions, waits for their dashboard, and reads it. (**Read Customer** still works for anyone you open yourself.) The panel fills in:
   - Customer, task type, Lead Manager, task Assigned To, vehicle, stock #, VIN, CRM status, and notes count. If the dashboard has no Vehicle Info section, the vehicle and stock # come from the task you clicked. **Every field is editable.** If the reader gets something wrong, fix it and the flags update.
   - **Flags:**
     - 🟥 **Call task:** skipped, no drafts.
     - 🟧 **Confirm:** you tick "Got it" before drafts unlock. This covers tasks assigned to Arthur Deeley or Michael Crynock, "VIN required to use Accelerate" leads, "you said sold but CRM says active" mismatches, units not found on the website, and a customer on screen who doesn't match the one you picked.
     - 🟨 **Heads-up:** sold unit, unreadable fields, CRM and website disagreeing.
     - 🟦 **Info:** 🔥 shared VOI with another customer in today's queue, and tone (0 notes = first-touch, notes = follow-up).
3. **Inventory check** runs automatically. It tries `searchused.aspx?stock=…` first, then **always falls back to `?model=…`** before calling a unit gone. It grabs the **SALE PRICE** and shows links to the pages it checked.
4. **Type your discount.** Pricing calculates live:
   - Manager Special Price = SALE PRICE − discount
   - Price with Fees = Special + **$1,331** ($999 doc + $299 e-filing + $33 tag agency)
5. **Generate drafts.** You get the text and email (bold pricing block, no signature since VinSolutions adds it). Both are editable in place.
   - **Copy email (keeps bold)** puts formatted text on the clipboard, so bold survives pasting into the VinSolutions editor.
6. **Save to today's queue.** **Export CSV** gives you the day's list for your spreadsheet.

**✍️ Freestyle messages** are for anything outside the templates: a trade bump, a bad phone number, a price drop. No API key needed.
1. Open **✍️ Freestyle message**, type what you want to say (or click a starter like *Trade bump*, *Bad phone #* or *Similar one came in*), and pick Text/Email and Language as usual.
   - **Vehicles to mention:** add by stock #, VIN or website link, or type the details for a unit that isn't online yet. **＋ Add the checked alternatives** pulls them in from the Alternatives list. Each vehicle's link goes into the request with instructions to include it exactly as written.
2. Click **Copy request for Claude**, then paste it into Claude (**Open Claude ↗**). The request includes the customer's first name, vehicle, stock #, your pricing (if you tick the box), and recent notes with phone numbers and emails stripped out. Their full name, phone and email are never included.
3. Paste Claude's reply into the box and click **Use these drafts**. They land in the same Text/Email boxes, so the copy buttons and **Save to today's queue** work the same way. Freestyle entries show ✍️ in the queue.

**Sold or not-real-inventory VOI:** no price quote. The panel always runs the model search, even when the sold unit still shows on the website, and falls back to a keyword search. The inventory box shows how many vehicles each search returned. Every alternative is editable, and each one's **link** goes into the email, or into the text when you offer just one. **Add vehicle** takes a stock #, VIN or website link. A fresh trade that isn't on the website yet comes up as a blank row to fill in by hand. Otherwise: It searches the same model on the website, pre-checks up to 3 units closest in price (±$5,000 window), and drafts a "that one sold, here are a few similar options" text and email. Uncheck any you don't want offered.

**Spanish:** switch Language to Spanish before generating drafts.

**Flaky session:** frame reads retry automatically with backoff. If VinSolutions logged you out, the panel says so. Log back in, then hit **Retry**, and nothing you typed is lost. The panel also remembers the current customer if you close it.

---

## Capture Mode: help me tune the reader

The VinSolutions reader was built from your workflow description, not from real screens. It works on text patterns ("Manager:", "Stock #", "View Photos View VDP", "no longer in your active inventory", etc.), but VinSolutions' exact wording and layout will need tuning.

Screenshots help, but the **Capture Page** button in the extension saves what the reader actually sees: the text in every frame, plus the hidden stuff a screenshot can't show, like which icon (phone, envelope, text bubble) sits next to a task. On each of these screens, click **Capture Page**:

1. My Tasks / Follow Ups grid
2. A customer in the full **Lead Info / Vehicle Info / Notes & History** view
3. A customer in the compact **Customer Dashboard** view
4. A customer whose VOI is **sold**
5. *(Optional)* A lead whose vehicle has **no stock #**, where VinSolutions shows "VIN required to use Accelerate" instead of pricing (e.g. a new-model or "any Tahoe" inquiry). If you don't run into one, skip it.

Each capture downloads a `.json` file. Emails, phone numbers, street addresses, form values, and the customer's name are scrubbed automatically. **Skim each file before sharing it.** Scrubbing is best effort.

All VinSolutions patterns live in **one file:** `src/config/vinsolutions-map.js`.

---

## Settings (bottom of the panel)

- Your name and aliases, used to decide whether a task's Manager field is you
- Title (default **Pre-Owned Sales Manager**), phone, and other managers/BDC agents
- Text message price: Special Price (default) or Price with Fees
- Alternatives price window
- Include signature in email (off by default, since VinSolutions adds it)

Fees and inventory URL defaults live in `src/config/defaults.js`.

---

## Project layout

```
manifest.json                   Chrome extension manifest (MV3)
src/background.js               Opens the side panel on icon click
src/sidepanel/                  The UI + orchestration (read → check → price → draft)
src/config/defaults.js          Your name, fees, phone, inventory URL, etc.
src/config/vinsolutions-map.js  Every VinSolutions text pattern, in one place
src/lib/vin-parser.js           Turns frame snapshots into a customer record / task list
src/lib/inventory.js            Website search URLs, SALE PRICE parsing, alternatives
src/lib/rules.js                Skip calls, manager check, sold/not-inventory, discrepancies
src/lib/pricing.js              Special Price / Price with Fees math
src/lib/templates.js            "*10 Day: MGR | Send Out Price" (EN + ES), alternatives version
src/lib/probes.js               Functions injected into VinSolutions / inventory pages
src/lib/queue.js                Today's queue, shared-VOI detection, CSV export
test/                           Unit tests (node --test)
```

Run the tests with `npm test` (Node 18+, no dependencies).

---

## Roadmap

- **v0.2:** tune the reader against real captures, then auto-search the customer from the task list (no copy-paste).
- **v0.3:** "Insert into VinSolutions" puts the draft into the compose box, still unsent.
- **Later:** actual sending through the VinSolutions compose UI (Cox's official API is partner-only), and optional Claude-written personalization from notes.
