// Parses the multi-line "time" field from the event summary sheet into ordered
// agenda rows, classifying internally-focused rows (leadership setup/cleanup) so
// they can be kept out of the public event window and the public webpage schedule.
//
// Example input (one sheet cell, newline-separated):
//   6-7PM (Leadership team) Set up
//   7- 7:30PM Networking
//   7:30 - 8:30PM Talk by Omar Kouatly
//   8:30 -9 PM Closing, Prayer + Networking
//   9 - 10 PM (leadership team) clean up

// A parenthetical that marks a row as internal/staff-only.
const INTERNAL_TAG = /\(([^)]*\b(?:leadership|internal|staff|volunteer|crew|team)\b[^)]*)\)/i;
// Setup/teardown task words that imply an internal row even without a tag.
const INTERNAL_KEYWORDS =
  /\b(?:set\s*up|setup|clean\s*up|cleanup|tear\s*down|teardown|break\s*down|breakdown|load[\s-]*(?:in|out)|strike)\b/i;
// A start–end time range, e.g. "6-7PM", "7- 7:30PM", "8:30 -9 PM".
const TIME_RANGE =
  /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[–—-]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

function to24(hourStr, minStr, meridiem) {
  let hour = Number(hourStr);
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minStr || "00"}`;
}

export function parseEventAgenda(timeText) {
  const lines = String(timeText || "")
    .split(/\r?\n|\u000b/)
    .map((line) => line.trim())
    .filter(Boolean);

  const rows = [];
  for (const line of lines) {
    const m = TIME_RANGE.exec(line);
    if (!m) continue;
    // When only one side carries am/pm, borrow it for the other side.
    const endMeridiem = (m[6] || m[3] || "").toLowerCase();
    const startMeridiem = (m[3] || m[6] || "").toLowerCase();
    const startTime = to24(m[1], m[2], startMeridiem);
    const endTime = to24(m[4], m[5], endMeridiem);

    const after = line.slice(m.index + m[0].length).trim();
    const before = line.slice(0, m.index).trim();
    const rawLabel = after || before;
    const internal = INTERNAL_TAG.test(line) || INTERNAL_KEYWORDS.test(rawLabel || line);
    const label = rawLabel
      .replace(INTERNAL_TAG, "")
      .replace(/^[\s:–—•-]+/, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    rows.push({ startTime, endTime, label, internal });
  }
  return rows;
}

export function selectPublicAgenda(rows) {
  return (rows || []).filter((row) => !row.internal);
}

// Formats a row's range for display, e.g. {19:00,19:30} -> "7:00–7:30 PM".
export function formatAgendaRange(row) {
  const start = to12(row.startTime);
  const end = to12(row.endTime);
  if (!start || !end) return "";
  if (start.meridiem === end.meridiem) {
    return `${start.clock}–${end.clock} ${end.meridiem}`;
  }
  return `${start.clock} ${start.meridiem}–${end.clock} ${end.meridiem}`;
}

function to12(time24) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(time24 || ""));
  if (!m) return null;
  const hour = Number(m[1]);
  const meridiem = hour >= 12 ? "PM" : "AM";
  const clockHour = hour % 12 === 0 ? 12 : hour % 12;
  return { clock: `${clockHour}:${m[2]}`, meridiem };
}
