// Clicking the toolbar icon opens the side panel. All the real work happens in
// the side panel page, which has a DOM (for parsing inventory HTML) and stays
// open while you work — a service worker would get killed mid-lookup.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('sidePanel behavior', err));
