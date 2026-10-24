export function normalizeEventVenue(event) {
  const full = String(event?.venue || "").replace(/\r\n/g, "\n").trim();
  const lines = full
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  // A parish name may be followed by a church name before the street address.
  const streetIndex = lines.findIndex((line, index) => index > 0 && /^(?:\d+[A-Za-z-]*\s|P\.?O\.?\s+Box\s)/i.test(line));
  const nameEnd = streetIndex > 0 ? streetIndex : Math.min(1, lines.length);
  const name = lines.slice(0, nameEnd).join(" — ");
  const addressLines = lines.slice(nameEnd);
  const city = String(event?.city || inferCityFromAddressLines(addressLines) || "").trim();
  const cityIndex = addressLines.findIndex(line => /^([^,\n]+),?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?$/.test(line));
  const address = addressLines.slice(0, cityIndex >= 0 ? cityIndex : addressLines.length).join(", ");
  const search = [name, ...addressLines, city].filter(Boolean).join(" ");
  return { full, name, address, city, search };
}

function inferCityFromAddressLines(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = /^([^,\n]+),?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?$/.exec(lines[i]);
    if (match) return match[1].trim();
  }
  return "";
}

