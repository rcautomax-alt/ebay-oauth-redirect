// Everything a human might need to change lives here (and is editable from the
// Settings section of the side panel, which overrides these defaults).

export const DEFAULT_SETTINGS = {
  myName: 'Rick Clemons',
  // Other ways your name can show up in the VinSolutions "Manager:" field.
  myNameAliases: ['Rick Clemons', 'Clemons, Rick', 'Richard Clemons'],
  firstName: 'Rick',
  title: 'Pre-Owned Sales Manager',
  titleEs: 'Gerente de Ventas de Seminuevos',
  dealership: 'Ritchey Cadillac Buick GMC',
  phone: '(386) 236-5126',

  // Known managers / BDC agents — used to make the "assigned to someone else"
  // flag say who it is.
  otherManagers: ['Arthur Deeley', 'Michael Crynock', 'Coreen Arbore'],

  // Flat add-on for every deal. Price with Fees = Special Price + sum of these.
  fees: [
    { label: 'Doc fee', amount: 999 },
    { label: 'Electronic filing fee', amount: 299 },
    { label: 'Tag agency fee', amount: 33 },
  ],

  inventoryBase: 'https://www.ritcheybuickgmc.com/searchused.aspx',
  // Exact search VinSolutions' own "View VDP" button uses.
  inventorySearchAll: 'https://www.ritcheybuickgmc.com/searchall.aspx',
  // Price labels on the inventory site, in priority order.
  priceLabels: ['SALE PRICE', 'Ritchey Price', 'Internet Price', 'Our Price'],

  // Alternatives for sold units: same model, within this many dollars.
  altPriceWindow: 5000,
  altLimit: 3,

  // Which number goes in the text message: 'special' or 'withFees'.
  textPriceField: 'special',

  // VinSolutions adds the signature itself; flip on if you ever need it inline.
  includeSignature: false,
};

export function feeTotal(fees) {
  return fees.reduce((sum, f) => sum + Number(f.amount || 0), 0);
}
