// The ONE place that knows what VinSolutions screens look like.
//
// These are text patterns matched against each frame's visible text, not CSS
// selectors, so they survive most of Cox's cosmetic UI changes. Tuned from
// screenshots of My Tasks, the Customer Dashboard and the Lead Info / Vehicle
// Info panel; tighten here (and nowhere else) as Capture Mode samples come in.

export const VIN_MAP = {
  // Frames have no reliable names, so they're matched by URL (with the old
  // frame names kept as a fallback).
  frames: {
    customerUrl: /CustomerDashboard\.aspx|rims2\.aspx|\/Pages\/CRM\//i,
    taskListUrl: /ActiveLeads_WorkList|ActiveLeadsLayout|\/vinconnect\//i,
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
    manager: /(?:^|[\n\t])[ \t]*Manager\s*:[ \t]*([^\n\r\t]+)/i,
    assignedTo: /Assigned To\s*:[ \t]*([^\n\r\t]+)/i,
    stock: /Stock\s*(?:#|No\.?|Number)?\s*:?[ \t]*([A-Z0-9][A-Z0-9-]{2,14})\b/i,
    vin: /\bVIN\s*#?\s*:?[ \t]*([A-HJ-NPR-Z0-9]{17})\b/i,
    bareVin: /\b[A-HJ-NPR-Z0-9]{17}\b/g,
    customerName: [
      // Customer Dashboard: "Robert Sampico" on one line, "(Individual)" on the next
      /^[ \t]*([A-Z][A-Za-z.'-]+(?:[ \t]+[A-Z][A-Za-z.'-]+){1,3})[ \t]*\r?\n[ \t]*\((?:Individual|Business|Company)\)/m,
      /Customer\s*(?:Name)?\s*:[ \t]*([^\n\r\t]+)/i,
      /^[ \t]*Name\s*:[ \t]*([^\n\r\t]+)/im,
    ],
    email: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
    phone: /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/,
    notesCount: /Notes\s*(?:&|and)\s*History\s*\(?\s*(\d+)\s*\)?/i,
    notesHeader: /Notes\s*(?:&|and)\s*History/i,
    vehicleSection: /(Vehicle Info|Vehicle of Interest|Vehicle Interest|Sought Vehicle)/i,
    tradeSection: /(Trade[- ]?In|Trade Info|Trade Vehicle|Vehicle\(s\) of Interest|Buyer and Co-?buyer)/i,
  },

  // My Tasks / Follow Ups list.
  taskList: {
    // "Follow Ups (18)", "Replies (1)", "Call Tracking Tasks (0)"
    sectionHeader: /^([A-Za-z][A-Za-z /&-]{1,40}?)\s*\((\d+)\)\s*$/,
    // "2017 GMC Acadia Limited [142087A]" or "2020 Cadillac XT4 (117222A)"
    vehicleWithStock: /^((?:19|20)\d{2}[ \t]+.+?)[ \t]*[[(]([A-Z0-9-]{3,15})[\])][ \t]*$/i,
    // "…description… Template: "Thank You for Purchase Script"" -> [description, template]
    template: /^(.*?)\bTemplate\s*:\s*["“]?(.+?)["”]?\s*$/i,
    noise: /^(edit|dismiss|edit dismiss|n\/a|details)$/i,
    // Date/time/age lines from the Updated/Age columns.
    dateLike: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}:\d{2}\s*[ap]m\b/i,
    priceQuote: /send out price|manager special price quote/i,
    callSection: /call tracking/i,
  },

  // Task icon titles in My Tasks -> our task types.
  taskIcons: {
    phone: 'call',
    email: 'email',
    text: 'text',
    generic: 'other',
    alert: 'other',
  },

  // Task classification from text (fallback when there's no icon), checked
  // in this order. Calls are checked before
  // email/text so anything call-ish is skipped.
  taskTypes: {
    textReply: /^\s*text message reply received/i,
    emailReply: /^\s*e-?mail reply received/i,
    call: /\bcall\b|\bphone\b|\bscript\b/i,
    text: /text message|\bsms\b|\btext\b/i,
    email: /\be-?mail\b|send out (?:manager|price|quote)|price quote|template\s*:/i,
  },
};
