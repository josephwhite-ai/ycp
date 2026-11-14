// Turns the leaders Google Sheet (exported as CSV) into leader records.
// Pure functions only, so the rules editors depend on are easy to test.

// What editors type in the Group column, mapped to the group the embed filters on.
// The labels match the tab names on the chapter page.
const GROUPS = new Map([
  ["leadership", "leadership"],
  ["our leadership", "leadership"],
  ["board", "board"],
  ["board & chaplaincy", "board"],
  ["board and chaplaincy", "board"],
  ["our board & chaplaincy", "board"],
  ["chaplaincy", "board"]
]);
export const GROUP_LABELS = { leadership: "Leadership", board: "Board & Chaplaincy" };
const REQUIRED_COLUMNS = ["name", "title", "group", "photo"];

// RFC 4180 CSV: quoted fields may contain commas, quotes ("") and newlines.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// A Photo cell can hold a Google Drive share link, a bare Drive file ID, or a web address.
export function parsePhotoRef(value) {
  const text = (value || "").trim();
  if (!text) return null;
  const driveId =
    text.match(/^https:\/\/(?:drive|docs)\.google\.com\/.*?\/d\/([\w-]{20,})/)?.[1] ||
    text.match(/^https:\/\/(?:drive|docs)\.google\.com\/.*[?&]id=([\w-]{20,})/)?.[1] ||
    text.match(/^([\w-]{25,})$/)?.[1];
  if (driveId) return { kind: "drive", id: driveId };
  if (/^https?:\/\/\S+$/i.test(text)) return { kind: "url", url: text };
  return { kind: "invalid", value: text };
}

// Returns { leaders, errors }. Errors name the sheet row so editors can find them.
export function rowsToLeaders(rows) {
  const errors = [];
  const header = (rows[0] || []).map(cell => cell.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter(name => !header.includes(name));
  if (missing.length) {
    return { leaders: [], errors: [`Row 1 must have the column headings Name, Title, Group and Photo (missing: ${missing.join(", ")}).`] };
  }
  const column = Object.fromEntries(REQUIRED_COLUMNS.map(name => [name, header.indexOf(name)]));

  const leaders = [];
  rows.slice(1).forEach((cells, index) => {
    const rowNumber = index + 2;
    const cell = name => (cells[column[name]] || "").trim();
    if (REQUIRED_COLUMNS.every(name => !cell(name))) return; // blank row

    const name = cell("name");
    const groupText = cell("group");
    const group = GROUPS.get(groupText.toLowerCase().replace(/\s+/g, " "));
    const photo = parsePhotoRef(cell("photo"));
    const problems = [];
    if (!name) problems.push("Name is empty");
    if (!group) problems.push(`Group must be "${GROUP_LABELS.leadership}" or "${GROUP_LABELS.board}"${groupText ? ` (it says "${groupText}")` : ""}`);
    if (photo?.kind === "invalid") problems.push("Photo must be a Google Drive link or a web address starting with https://");
    if (problems.length) {
      errors.push(`Row ${rowNumber}${name ? ` (${name})` : ""}: ${problems.join("; ")}.`);
      return;
    }
    leaders.push({ row: rowNumber, name, title: cell("title"), group, photo });
  });

  if (!errors.length && !leaders.length) errors.push("The sheet has no leaders.");
  return { leaders, errors };
}

export function slugify(text) {
  return (
    text
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "leader"
  );
}
