// The ONE place that knows what VinSolutions screens look like.
//
// These are text patterns matched against each frame's visible text, not CSS
// selectors, so they survive most of Cox's cosmetic UI changes. They are a
// first pass built from the workflow description — once Capture Mode samples
// come in, tighten them here and nowhere else.

export const VIN_MAP = {
  frames: {
    left: /leftpane/i,
    right: /rightpane/i,
  },

  markers: {
    active: /View Photos\s*\|?\s*View VDP/i,
    sold: /no longer in your active inventory/i,
    notInventory: /VIN required to use Accelerate/i,
    leadInfoView: /Lead Info/i,
    dashboardView: /Customer Dashboard/i,
    sessionExpired:
      /(session (has )?(expired|timed out)|please (sign|log) in|sign in to continue|forgot (your )?password)/i,
  },

  fields: {
    manager: /Manager\s*:[ \t]*([^\n\r\t]+)/i,
    stock: /Stock\s*(?:#|No\.?|Number)?\s*:?[ \t]*([A-Z0-9][A-Z0-9-]{2,14})\b/i,
    vin: /\bVIN\s*#?\s*:?[ \t]*([A-HJ-NPR-Z0-9]{17})\b/i,
    customerName: [
      /Customer\s*(?:Name)?\s*:[ \t]*([^\n\r\t]+)/i,
      /^[ \t]*Name\s*:[ \t]*([^\n\r\t]+)/im,
    ],
    email: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
    phone: /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/,
    notesCount: /Notes\s*(?:&|and)\s*History\s*\(?\s*(\d+)\s*\)?/i,
    notesHeader: /Notes\s*(?:&|and)\s*History/i,
    taskType: /(?:Task\s*Type|Activity\s*Type)\s*:[ \t]*([^\n\r\t]+)/i,
    vehicleSection: /(Vehicle Info|Vehicle of Interest|Vehicle Interest|Sought Vehicle|Wish List)/i,
    tradeSection: /(Trade[- ]?In|Trade Info|Trade Vehicle)/i,
  },

  // Order matters: "call" is checked first so anything call-ish is skipped.
  taskTypes: {
    call: /\b(call|phone)\b/i,
    text: /\b(text|sms)\b/i,
    email: /\be-?mail\b/i,
  },

  taskGridHeaders: {
    customer: /customer|name/i,
    type: /type|task|action|activity/i,
    manager: /manager|assigned/i,
    due: /due|date/i,
    vehicle: /vehicle|interest/i,
    subject: /subject|desc/i,
  },
};
