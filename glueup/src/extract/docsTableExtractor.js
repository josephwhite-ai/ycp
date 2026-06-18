export function extractEventFromGoogleDoc(doc) {
  const tables = [];
  const paragraphs = [];

  for (const content of doc.body?.content || []) {
    if (content.table) {
      tables.push(extractTable(content.table));
    } else if (content.paragraph) {
      const text = extractParagraphText(content.paragraph);
      if (text) paragraphs.push(text);
    }
  }

  const fields = {};
  const sessions = [];

  for (const table of tables) {
    if (table.length === 0) continue;
    if (looksLikeKeyValueTable(table)) {
      Object.assign(fields, tableToKeyValues(table));
    } else {
      sessions.push(...tableToSessions(table));
    }
  }

  const event = normalizeEventFields({
    sourceDocumentTitle: doc.title || "",
    eventType: pick(fields, ["event type", "program type", "template", "format"]) || "",
    eventName:
      pick(fields, ["event name", "title", "program title"]) ||
      deriveEventName(fields) ||
      doc.title?.replace(/ - Event Summary Sheet$/i, "") ||
      "",
    eventDate: normalizeDate(pick(fields, ["event date", "date", "program date"]) || ""),
    venue: pick(fields, ["venue", "location", "place"]) || "",
    city: pick(fields, ["city"]) || "",
    registrationUrl: pick(fields, ["registration url", "registration link", "link", "url"]) || "",
    description: cleanText(pick(fields, ["description", "overview", "summary"]) || paragraphs.join("\n\n")),
    rawFields: fields,
    speakers: splitSpeakerEntries(pick(fields, ["speaker (if applicable)", "speakers", "speaker", "presenter", "presenters"]) || ""),
    sessions
  });

  return event;
}

export function normalizeEventFields(event) {
  const rawFields = event?.rawFields || {};
  const explicitTitle = cleanTitleCandidate(pick(rawFields, ["event name", "title", "program title"]));
  const topic = cleanTitleCandidate(pick(rawFields, ["talk topic (if applicable)", "talk topic", "topic"]));
  const eventName = cleanTitleCandidate(event?.eventName);
  return {
    ...event,
    eventName: topic || explicitTitle || eventName || event?.sourceDocumentTitle?.replace(/ - Event Summary Sheet$/i, "") || ""
  };
}

function extractTable(table) {
  return (table.tableRows || []).map((row) =>
    (row.tableCells || []).map((cell) =>
      (cell.content || [])
        .map((item) => (item.paragraph ? extractParagraphText(item.paragraph) : ""))
        .filter(Boolean)
        .join("\n")
        .trim()
        .replace(/\u000b/g, "\n")
    )
  );
}

function extractParagraphText(paragraph) {
  return (paragraph.elements || [])
    .map((element) => element.textRun?.content || "")
    .join("")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function looksLikeKeyValueTable(table) {
  const rowsWithTwoCells = table.filter((row) => row.length >= 2 && row[0] && row[1]);
  if (rowsWithTwoCells.length === 0) return false;
  const firstCellValues = rowsWithTwoCells.map((row) => row[0].toLowerCase());
  return firstCellValues.some((value) =>
    ["event", "date", "venue", "location", "registration", "description", "summary"].some((hint) =>
      value.includes(hint)
    )
  );
}

function tableToKeyValues(table) {
  const fields = {};
  for (const row of table) {
    if (row.length < 2 || !row[0]) continue;
    fields[normalizeKey(row[0])] = row.slice(1).filter(Boolean).join(" ").trim();
  }
  return fields;
}

function tableToSessions(table) {
  const [headerRow, ...rows] = table;
  if (!headerRow || headerRow.length === 0) return [];

  const headers = headerRow.map((header) => normalizeKey(header));
  return rows
    .filter((row) => row.some(Boolean))
    .map((row) => {
      const session = {};
      headers.forEach((header, index) => {
        if (!header) return;
        session[header] = row[index] || "";
      });
      return {
        time: pick(session, ["time", "start time", "session time"]) || "",
        title: pick(session, ["title", "session title", "topic"]) || "",
        speakers: splitPeople(pick(session, ["speakers", "speaker", "presenter", "presenters"]) || ""),
        description: pick(session, ["description", "summary", "details"]) || "",
        raw: session
      };
    });
}

function normalizeKey(value) {
  return value.toLowerCase().replace(/[:*]/g, "").replace(/\s+/g, " ").trim();
}

function pick(object, keys) {
  for (const key of keys) {
    const value = object[normalizeKey(key)];
    if (value) return value;
  }
  return "";
}

function splitPeople(value) {
  return value
    .split(/\n|;|,(?=\s*[A-Z])/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitSpeakerEntries(value) {
  return String(value || "")
    .replace(/\u000b/g, "\n")
    .split(/\n|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

function deriveEventName(fields) {
  const topic = cleanTitleCandidate(pick(fields, ["talk topic (if applicable)", "talk topic", "topic"]));
  if (topic) return topic;

  const summary = cleanText(pick(fields, ["summary", "description", "overview"]));
  if (!summary) return "";
  const firstLine = summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "";
  return firstLine.replace(/^[^\p{L}\p{N}]+/u, "").trim() || firstLine;
}

function cleanTitleCandidate(value) {
  const cleaned = cleanText(value);
  if (!cleaned || /^n\/?a\b/i.test(cleaned) || /^tbd\b/i.test(cleaned)) return "";
  const firstLine = cleaned.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  if (!firstLine || firstLine.length > 140) return "";
  return firstLine;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u000b/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
