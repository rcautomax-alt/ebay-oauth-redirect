import { feeTotal } from '../config/defaults.js';

// Manager Special Price = Asking − Discount
// Price with Fees       = Manager Special Price + fees ($1,331 by default)
export function computePricing({ asking, discount, fees }) {
  const a = Number(asking);
  const d = Number(discount);
  if (!Number.isFinite(a) || a <= 0) throw new Error('Asking price is missing or invalid.');
  if (!Number.isFinite(d) || d < 0) throw new Error('Discount must be $0 or more.');
  if (d >= a) throw new Error('Discount is bigger than the asking price — typo?');

  const feeSum = feeTotal(fees);
  const special = a - d;
  return {
    asking: a,
    discount: d,
    special,
    fees: feeSum,
    withFees: special + feeSum,
  };
}
