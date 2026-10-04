# vAuto Price Adjuster (v2)

Chrome extension that takes the vAuto **Pricing** export, recommends price drops
using the house pricing rules, and then applies and verifies them in vAuto.

## Install / update

1. Download this `vauto-price-adjuster` folder (or unzip `vauto-price-adjuster.zip`).
2. In Chrome go to `chrome://extensions` and turn on **Developer mode** (top right).
3. **Remove the old v1 extension** if it's installed.
4. Click **Load unpacked** and pick the `vauto-price-adjuster` folder.
5. Pin it: puzzle-piece icon → pin **vAuto Price Adjuster**.

To update later, replace the folder's files and hit the ↻ reload button on the
extension's card in `chrome://extensions`.

## Daily use

1. In vAuto, open the Pricing page filtered to **no price change in 7 days** and export it (the .xls).
2. Click the extension icon. A full planner tab opens.
3. Drop the .xls on the page. You get the plan: Stock, Vehicle, Age, Days Supply,
   Like Mine, Current, Suggested, Change, Reason, plus the summary line and flags.
4. Review it. Uncheck any car you want to skip, or type your own price in the
   Suggested box (it has to end in 88, be a drop, be $1,000 or less, and stay above 50% of book).
5. **First time only:** click **Test on first car**. It types in the price and
   stops before saving so you can look at the vAuto tab. Click **Looks right — Save it**.
6. Click **Apply selected** and go do something else. Keep the vAuto tab open on
   the same filtered Pricing page.

For each car it:
opens the vehicle → Pricing tab → enters the List Price → **Save & Close** →
re-opens it → checks List Price, Disposition and "Publish this vehicle". If the
car flipped to Wholesale or got unpublished, it puts it back to the original
disposition, re-checks Publish, re-enters the price and saves again.

### What makes it stop or skip

| Situation | What it does |
|---|---|
| Stock # not on the current vAuto page | Skips it and keeps going |
| vAuto price doesn't match the export (someone changed it) | Skips it and keeps going |
| Car is already Wholesale | Skips it, doesn't touch it |
| Can't find a field or button, or a fix didn't stick | **Stops** and tells you which car and why |

It only clicks buttons whose text is exactly **Save & Close** / **Save**.
Anything with Delete, Cancel, Wholesale or Remove in it is never clicked during a save.

## Wholesale Report tab

Lists every car priced **under cost** (negative markup). These still get their
normal drop in the plan, with a note. Export it to CSV or print it for the
wholesale manager. If you add an MMR / auction column to the vAuto Pricing view
before exporting, it shows up in this report automatically.

## Change Log & Sync Check tab

Every price the extension saves is logged. vAuto saves the price right away, but
the grid and the outside sites (dealer website, Cars.com, AutoTrader, etc.) pick
it up on vAuto's periodic pushes. The grid also shows a red asterisk until then.

To confirm changes went through, drop in a **newer export** (an unfiltered one
works best, since changed cars drop off the "no change in 7 days" list). Each
logged change gets marked:

- **Confirmed:** export shows the new price
- **Export still shows OLD price:** the save didn't take, or the push hasn't happened yet. Check that car.
- **Export shows something else:** the price changed again

The plan also notes any car the extension already changed in the last 7 days.

## Pricing rules (Settings tab can tune the Like Mine cutoffs and nameplates)

- **Age tiers:** 1–14 days $100–150 · 15–45 $200–350 · 46–75 $400–600 · 76+ $650–900
- **Market %:** over 105% → upper end of the tier; at or under 105% → lower/middle
- **Markup:** standard thresholds $5k boost / $8k aggressive / under $3k conservative.
  Commodity cars use $3k / $6k; unique cars use $7k / $10k.
- **Commodity status:** Like Mine (from the export) over 90 or a high-volume nameplate →
  commodity · under 40 → unique · otherwise middle
- **Days supply:** 60–90 → one notch more aggressive · 90+ → top of the tier
- **Output:** every price ends in 88 · max $1,000 drop · never below 50% of book ·
  missing Market % or Markup → flagged, not priced
- Because prices already end in 88, drops come in whole $100 steps
  (Minimal = $100, Moderate = $200/$300, Aggressive = $400–$600, Very Aggressive = $700–$900).

## Troubleshooting

If vAuto changes its screens and the extension can't find a field: open that
vehicle's Pricing screen in vAuto, then go to **Settings → Save vAuto page snapshot**.
That downloads a copy of the page that can be sent over to get the extension updated.

The **Copy as Claude prompt** button is a fallback. It copies the approved list
as a Phase 2 prompt you can paste into Claude in Chrome.
