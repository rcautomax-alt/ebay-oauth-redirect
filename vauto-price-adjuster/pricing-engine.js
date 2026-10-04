// vAuto Price Adjuster — pricing engine
// Pure functions only (no DOM, no Chrome APIs) so the same math runs in the
// extension and in tests. Rules come straight from Rick's pricing prompt.

(function (root) {
  const DEFAULT_SETTINGS = {
    // Like Mine count from the vAuto export (market-wide count, not the
    // Pricing-tab population count). Calibrated on Ritchey's inventory.
    uniqueBelow: 40,      // Like Mine < 40  => unique / low-volume
    commodityAbove: 90,   // Like Mine > 90  => commodity
    // High-volume nameplates are always commodity, whatever Like Mine says.
    commodityModels: [
      'Corolla', 'Camry', 'Civic', 'Accord', 'CR-V', 'RAV4', 'Encore', 'Equinox',
      'Trax', 'Trailblazer', 'Terrain', 'Escape', 'Rogue', 'Altima', 'Sentra',
      'Forte', 'Elantra', 'Malibu', 'Cherokee', 'Envision', 'Crosstrek',
      'Tucson', 'Sportage', 'Kicks', 'Corolla Cross', 'HR-V', 'Explorer'
    ],
    maxDrop: 1000,
    bookFloorPct: 0.5,
    recentChangeDays: 7
  };

  // Age tiers: [maxAge, key, label, minDrop, maxDrop]
  const TIERS = [
    [14, 'minimal', 'Minimal', 100, 150],
    [45, 'moderate', 'Moderate', 200, 350],
    [75, 'aggressive', 'Aggressive', 400, 600],
    [Infinity, 'veryAggressive', 'Very Aggressive', 650, 900]
  ];

  const MARKUP_THRESHOLDS = {
    commodity: { boost: 3000, aggressive: 6000 },
    middle: { boost: 5000, aggressive: 8000 },
    unique: { boost: 7000, aggressive: 10000 }
  };

  function getTier(age) {
    const t = TIERS.find(([max]) => age <= max);
    return { key: t[1], label: t[2], min: t[3], max: t[4] };
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function classifyVehicle(vehicleName, likeMine, settings) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const name = vehicleName || '';
    const hit = s.commodityModels.find(m =>
      m && new RegExp(`\\b${escapeRegex(m.trim())}\\b`, 'i').test(name));
    if (hit) return { cls: 'commodity', why: `${hit} nameplate` };
    if (likeMine == null) return { cls: 'middle', why: 'Like Mine blank' };
    if (likeMine > s.commodityAbove) return { cls: 'commodity', why: `${likeMine} like mine` };
    if (likeMine < s.uniqueBelow) return { cls: 'unique', why: `${likeMine} like mine` };
    return { cls: 'middle', why: `${likeMine} like mine` };
  }

  // Largest price ending in 88 that is <= value
  function floorTo88(value) {
    return Math.floor((value - 88) / 100) * 100 + 88;
  }

  // Smallest price ending in 88 that is >= value
  function ceilTo88(value) {
    return Math.ceil((value - 88) / 100) * 100 + 88;
  }

  function endsIn88(price) {
    return Math.round(price) % 100 === 88;
  }

  // v: { stock, vehicle, age, price, marketPct (e.g. 104.2), book, markup,
  //      cost, daysSupply, likeMine, lastChangeDays }
  function recommend(v, settings) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const flags = [];
    const notes = [];

    if (!(v.price > 0)) flags.push('Price missing');
    if (v.marketPct == null) flags.push('Market % missing');
    if (v.markup == null) flags.push('Markup missing');
    if (!(v.book > 0)) flags.push('Book missing');
    if (flags.length) {
      return { status: 'flagged', flags, notes, reason: 'FLAG: ' + flags.join(', ') };
    }

    const age = Math.max(0, v.age || 0);
    const tier = getTier(age);
    const { cls, why: clsWhy } = classifyVehicle(v.vehicle, v.likeMine, s);
    const th = MARKUP_THRESHOLDS[cls];
    const why = [];

    // Position inside the tier's $ range: 0 = low end, 1 = high end
    let p;
    if (v.marketPct > 105) {
      p = 0.9;
      why.push(`${v.marketPct.toFixed(0)}% mkt >105`);
    } else {
      p = 0.3;
      why.push(`${v.marketPct.toFixed(0)}% mkt`);
    }

    const mk = v.markup;
    if (mk > th.aggressive) {
      p = Math.max(p, 0.5) + 0.25;
      why.push(`markup $${(mk / 1000).toFixed(1)}k aggressive`);
    } else if (mk > th.boost) {
      p += 0.15;
      why.push(`markup $${(mk / 1000).toFixed(1)}k boost`);
    } else if (mk < 3000 && v.marketPct <= 105) {
      p = Math.min(p, 0.3);
      why.push(mk < 0 ? 'under cost' : 'low markup');
    }

    if (v.daysSupply != null) {
      if (v.daysSupply >= 90) {
        p = 1;
        why.push(`DS ${v.daysSupply} max push`);
      } else if (v.daysSupply >= 60) {
        p += 0.25;
        why.push(`DS ${v.daysSupply} +1`);
      }
    }
    p = Math.min(1, Math.max(0, p));

    // Current prices end in 88, so real drops come in $100 steps.
    // Pick the $100 step inside the tier closest to the target.
    const target = tier.min + (tier.max - tier.min) * p;
    const steps = [];
    for (let d = 100; d <= s.maxDrop; d += 100) {
      if (d >= tier.min && d <= tier.max) steps.push(d);
    }
    if (!steps.length) steps.push(Math.round(tier.min / 100) * 100);
    const drop = steps.reduce((best, d) =>
      Math.abs(d - target) < Math.abs(best - target) ||
      (Math.abs(d - target) === Math.abs(best - target) && d > best) ? d : best);

    let suggested = floorTo88(v.price - drop);
    if (!endsIn88(v.price)) notes.push(`Current price $${v.price} did not end in 88`);

    const floor = Math.round(v.book * s.bookFloorPct);
    if (suggested < floor) {
      suggested = ceilTo88(floor);
      notes.push('Held at 50% of book floor');
    }
    if (v.price - suggested > s.maxDrop) {
      suggested = ceilTo88(v.price - s.maxDrop);
      notes.push('Capped at $1,000');
    }
    if (suggested >= v.price) {
      return { status: 'flagged', flags: ['No valid drop'], notes,
        reason: 'FLAG: could not find a lower 88 price within the rules' };
    }

    const underCost = mk < 0;
    if (underCost) notes.push(`UNDER COST by $${Math.abs(mk).toLocaleString()} — see wholesale report`);
    if (v.lastChangeDays != null && v.lastChangeDays < s.recentChangeDays) {
      notes.push(`Price changed ${v.lastChangeDays}d ago`);
    }

    return {
      status: 'ready',
      tier: tier.label,
      cls,
      clsWhy,
      suggested,
      change: v.price - suggested,
      underCost,
      flags,
      notes,
      reason: `${tier.label}, ${cls}; ${why.join(', ')}`
    };
  }

  // Manual override check (when Rick types his own number)
  function validateManualPrice(v, price, settings) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const errs = [];
    if (!Number.isFinite(price) || price <= 0) errs.push('not a number');
    else {
      if (!endsIn88(price)) errs.push('must end in 88');
      if (v.price - price > s.maxDrop) errs.push('more than $1,000 drop');
      if (v.book > 0 && price < v.book * s.bookFloorPct) errs.push('below 50% of book');
      if (price >= v.price) errs.push('not a reduction');
    }
    return errs;
  }

  const api = { DEFAULT_SETTINGS, TIERS, getTier, classifyVehicle, floorTo88,
    ceilTo88, endsIn88, recommend, validateManualPrice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PricingEngine = api;
})(typeof self !== 'undefined' ? self : this);
