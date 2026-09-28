// Strip customer PII from Capture Mode output before it leaves your machine.
// Best effort — skim the file before sending it anywhere.
export function scrubPii(str, names = []) {
  let s = String(str || '');
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]');
  s = s.replace(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[PHONE]');
  s = s.replace(
    /\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?\s+(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Dr|Drive|Ln|Lane|Ct|Court|Way|Cir|Circle|Pkwy|Hwy|Pl|Ter|Trl)\b\.?/g,
    '[ADDRESS]',
  );
  s = s.replace(/\bvalue="[^"]+"/g, 'value="[VALUE]"');
  for (const n of names) {
    for (const part of String(n || '').split(/[\s,]+/).filter((p) => p.length > 2)) {
      s = s.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '[NAME]');
    }
  }
  return s;
}
