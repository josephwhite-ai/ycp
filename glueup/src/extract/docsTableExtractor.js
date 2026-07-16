import { parseEventAgenda } from "./agenda.js";

const NO_SPEAKER_RE = /^(?:tbd|n\/?a|none|not applicable)$/i;

export function extractEventFromGoogleDoc(doc) {
  const paragraphs = [];
  const bodyParagraphItems = [];
  const fields = {};
  const fieldsHtml = {};
  const sessions = [];

  for (const content of doc.body?.content || []) {
    if (content.table) {
      const table = extractTable(content.table);
      if (table.length === 0) continue;
      if (looksLikeKeyValueTable(table)) {
        Object.assign(fields, tableToKeyValues(table));
        Object.assign(fieldsHtml, tableToKeyValueHtml(content.table, doc));
      } else {
        sessions.push(...tableToSessions(table));
      }
    } else if (content.paragraph) {
      const text = extractParagraphText(content.paragraph);
      if (text) {
        paragraphs.push(text);
        bodyParagraphItems.push(content);
      }
    }
  }

  const descriptionKey = pickKey(fields, ["description", "overview", "summary"]);
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
    description: cleanText((descriptionKey ? fields[descriptionKey] : "") || paragraphs.join("\n\n")),
    descriptionHtml: descriptionKey
      ? fieldsHtml[descriptionKey] || ""
      : contentToHtml(bodyParagraphItems, doc),
    rawFields: fields,
    speakers: splitSpeakerEntries(pick(fields, ["speaker (if applicable)", "speakers", "speaker", "presenter", "presenters"]) || ""),
    agenda: parseEventAgenda(pick(fields, ["time", "schedule", "agenda", "run of show"]) || ""),
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
  return (table.tableRows || []).map((row) => (row.tableCells || []).map(cellText));
}

function cellText(cell) {
  return (cell.content || [])
    .map((item) => (item.paragraph ? extractParagraphText(item.paragraph) : ""))
    .filter(Boolean)
    .join("\n")
    .trim()
    .replace(/\u000b/g, "\n");
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

// HTML mirror of tableToKeyValues: the value cells rendered with their inline
// formatting intact, keyed the same way, so rich fields (the description) can be
// published exactly as they look in the Google Doc.
function tableToKeyValueHtml(rawTable, doc) {
  const fields = {};
  for (const row of rawTable.tableRows || []) {
    const cells = row.tableCells || [];
    if (cells.length < 2) continue;
    const key = normalizeKey(cellText(cells[0]));
    if (!key) continue;
    const html = cells
      .slice(1)
      .map((cell) => contentToHtml(cell.content, doc))
      .filter(Boolean)
      .join("");
    if (html) fields[key] = html;
  }
  return fields;
}

// Renders Docs structural elements (a table cell's content or top-level
// paragraphs) to the HTML vocabulary Glue Up's Quill editor accepts: <p>, <br>,
// <strong>, <em>, <u>, <a>, <ul>, <ol>, <li>. Nested lists are flattened.
function contentToHtml(content, doc) {
  const blocks = [];
  let list = null;

  const flushList = () => {
    if (!list) return;
    blocks.push(`<${list.tag}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.tag}>`);
    list = null;
  };

  for (const item of content || []) {
    const paragraph = item.paragraph;
    if (!paragraph) continue;
    let html = paragraphInlineHtml(paragraph);
    if (html && /^HEADING_/.test(paragraph.paragraphStyle?.namedStyleType || "")) {
      html = `<strong>${html}</strong>`;
    }
    if (paragraph.bullet) {
      if (!html) continue;
      const tag = listTag(doc, paragraph.bullet.listId);
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(html);
      continue;
    }
    flushList();
    blocks.push(html ? `<p>${html}</p>` : "<p><br></p>");
  }
  flushList();

  // Collapse runs of blank paragraphs and drop them from the edges, so stray
  // empty lines in the doc don't pad the published page.
  const isBlank = (block) => block === "<p><br></p>";
  const collapsed = [];
  for (const block of blocks) {
    if (isBlank(block) && (!collapsed.length || isBlank(collapsed[collapsed.length - 1]))) continue;
    collapsed.push(block);
  }
  while (collapsed.length && isBlank(collapsed[collapsed.length - 1])) collapsed.pop();
  return collapsed.join("");
}

function paragraphInlineHtml(paragraph) {
  return (paragraph.elements || [])
    .map((element) => textRunHtml(element.textRun))
    .join("")
    .replace(/^(?:<br>)+|(?:<br>)+$/g, "")
    .trim();
}

function textRunHtml(textRun) {
  const content = textRun?.content;
  if (!content) return "";
  const style = textRun.textStyle || {};
  let html = escapeHtml(content.replace(/\n+$/g, "")).replace(/\u000b/g, "<br>");
  if (!html) return "";
  if (style.bold) html = `<strong>${html}</strong>`;
  if (style.italic) html = `<em>${html}</em>`;
  const link = style.link?.url;
  if (link) {
    // Docs underlines links by default; the <a> styling covers that.
    html = `<a href="${escapeAttr(link)}" rel="noopener noreferrer" target="_blank">${html}</a>`;
  } else if (style.underline) {
    html = `<u>${html}</u>`;
  }
  return html;
}

function listTag(doc, listId) {
  const glyph = doc?.lists?.[listId]?.listProperties?.nestingLevels?.[0]?.glyphType || "";
  return /DECIMAL|ALPHA|ROMAN/i.test(glyph) ? "ol" : "ul";
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function normalizeKey(value) {
  return value.toLowerCase().replace(/[:*]/g, "").replace(/\s+/g, " ").trim();
}

function pickKey(object, keys) {
  for (const key of keys) {
    const normalized = normalizeKey(key);
    if (object[normalized]) return normalized;
  }
  return "";
}

function pick(object, keys) {
  const key = pickKey(object, keys);
  return key ? object[key] : "";
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
    .filter((item) => item && !NO_SPEAKER_RE.test(item));
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
