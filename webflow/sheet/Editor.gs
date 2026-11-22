/**
 * Bound Google Sheets editor. Install alongside Publish.gs and Editor.html.
 * No public web-app deployment: only people who can edit the Sheet can open it.
 * The first tab contains APPROVED data; _Leaders draft is never read by CI.
 */
const DRAFT_TAB = "_Leaders draft";
const DRAFT_HEADERS = ["ID", "Name", "Title", "Group", "Photo"];
const LEADER_GROUPS = { leadership: "Leadership", board: "Board & Chaplaincy" };
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function showLeaderEditor() {
  const html = HtmlService.createHtmlOutputFromFile("Editor").setWidth(1120).setHeight(760);
  SpreadsheetApp.getUi().showModalDialog(html, "Chapter website · Leaders");
}

function withLeaderLock_(work) {
  const lock = LockService.getDocumentLock();
  if (!lock) throw new Error("Install this script from Extensions > Apps Script in the leaders Sheet.");
  lock.waitLock(10000);
  try {
    return work();
  } finally {
    try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
  }
}

function leaderHash_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value))
    .map(function (byte) { return (byte & 255).toString(16).padStart(2, "0"); }).join("");
}

function leaderGroup_(value) {
  const group = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (["leadership", "our leadership"].includes(group)) return "leadership";
  if (["board", "board & chaplaincy", "board and chaplaincy", "our board & chaplaincy", "chaplaincy"].includes(group)) return "board";
  throw new Error('Group must be "Leadership" or "Board & Chaplaincy".');
}

function leaderPhotoId_(photo) {
  return photo.match(/^https:\/\/(?:drive|docs)\.google\.com\/.*?\/d\/([\w-]{20,})/)?.[1] ||
    photo.match(/^https:\/\/(?:drive|docs)\.google\.com\/.*[?&]id=([\w-]{20,})/)?.[1] ||
    photo.match(/^([\w-]{25,})$/)?.[1] || "";
}

function validateLeaderDraft_(input, allowEmpty) {
  if (!Array.isArray(input) || input.length > 150) throw new Error("The roster must contain at most 150 people.");
  if (!allowEmpty && !input.length) throw new Error("Add at least one person before publishing.");
  const ids = new Set();
  return input.map(function (entry, index) {
    if (!entry || typeof entry !== "object") throw new Error("Person " + (index + 1) + " is invalid.");
    const text = function (key, max) {
      const value = typeof entry[key] === "string" ? entry[key].trim() : "";
      if (value.length > max) throw new Error("Person " + (index + 1) + ": " + key + " is too long.");
      return value;
    };
    const leader = { id: text("id", 80), name: text("name", 160), title: text("title", 500), group: leaderGroup_(entry.group), photo: text("photo", 2048) };
    if (!/^[\w-]{1,80}$/.test(leader.id) || ids.has(leader.id)) throw new Error("Person IDs are missing or duplicated. Reload the editor.");
    ids.add(leader.id);
    if (!leader.name) throw new Error("Person " + (index + 1) + " needs a name.");
    if (leader.photo && !leaderPhotoId_(leader.photo) && !/^https?:\/\/[^\s]+$/i.test(leader.photo)) {
      throw new Error(leader.name + ": use a Google Drive photo link or an http(s) image address.");
    }
    return leader;
  });
}

function approvedLeaderSheet_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const properties = PropertiesService.getDocumentProperties();
  const savedId = properties.getProperty("LEADERS_APPROVED_TAB_ID");
  const sheet = savedId ? book.getSheets().find(function (tab) { return String(tab.getSheetId()) === savedId; }) : book.getSheets()[0];
  if (!sheet || sheet.getName() === DRAFT_TAB) throw new Error("The approved leaders tab is missing.");
  if (book.getSheets()[0].getSheetId() !== sheet.getSheetId()) throw new Error("Move the approved leaders tab back to the first position; the website sync reads the first tab.");
  const rows = sheet.getDataRange().getDisplayValues();
  const headers = rows[0].map(function (value) { return value.trim().toLowerCase(); });
  const columns = ["name", "title", "group", "photo"].map(function (key) { return headers.indexOf(key); });
  if (columns.some(function (column) { return column < 0; })) throw new Error("The first tab needs Name, Title, Group and Photo headings.");
  if (!savedId) properties.setProperty("LEADERS_APPROVED_TAB_ID", String(sheet.getSheetId()));
  return { book: book, sheet: sheet, rows: rows, columns: columns };
}

function approvedLeaderRecords_(approved) {
  return approved.rows.slice(1).filter(function (row) {
    return approved.columns.some(function (column) { return String(row[column] || "").trim(); });
  }).map(function (row) {
    return { name: String(row[approved.columns[0]] || "").trim(), title: String(row[approved.columns[1]] || "").trim(),
      group: leaderGroup_(row[approved.columns[2]]), photo: String(row[approved.columns[3]] || "").trim() };
  });
}

// Rich text writes keep names such as "=Example" as text, never Sheet formulas.
// Pad the previous rows in this same write, so a reader never sees a cleared tab.
function writeLeaderRows_(sheet, rows, width) {
  const count = Math.max(sheet.getLastRow(), rows.length);
  while (rows.length < count) rows.push(Array(width).fill(""));
  if (sheet.getMaxRows() < count) sheet.insertRowsAfter(sheet.getMaxRows(), count - sheet.getMaxRows());
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  sheet.getRange(1, 1, count, width).setRichTextValues(rows.map(function (row) {
    return row.map(function (value) { return SpreadsheetApp.newRichTextValue().setText(String(value)).build(); });
  }));
}

function readLeaderEditor_() {
  const approved = approvedLeaderSheet_();
  let draft = approved.book.getSheetByName(DRAFT_TAB);
  if (!draft) {
    // Always last: the sync exports the FIRST tab, so the draft must never land there.
    draft = approved.book.insertSheet(DRAFT_TAB, approved.book.getSheets().length);
    const initial = approvedLeaderRecords_(approved).map(function (leader) {
      return [Utilities.getUuid(), leader.name, leader.title, LEADER_GROUPS[leader.group], leader.photo];
    });
    writeLeaderRows_(draft, [DRAFT_HEADERS].concat(initial), 5);
    draft.hideSheet();
  }
  const draftRows = draft.getDataRange().getDisplayValues();
  if (JSON.stringify(draftRows[0].slice(0, 5)) !== JSON.stringify(DRAFT_HEADERS)) {
    throw new Error("The draft tab headings were changed. Restore ID, Name, Title, Group and Photo.");
  }
  const leaders = draftRows.slice(1).filter(function (row) { return row.some(function (value) { return value.trim(); }); }).map(function (row) {
    return { id: row[0], name: row[1], title: row[2], group: leaderGroup_(row[3]), photo: row[4] || "" };
  });
  const plain = leaders.map(function (leader) { return { name: leader.name, title: leader.title, group: leader.group, photo: leader.photo }; });
  return {
    approved: approved, draft: draft,
    data: {
      leaders: leaders,
      revision: leaderHash_([approved.rows, draftRows]),
      hasUnpublishedChanges: JSON.stringify(plain) !== JSON.stringify(approvedLeaderRecords_(approved)),
      uploadsEnabled: !!PropertiesService.getScriptProperties().getProperty("LEADERS_PHOTOS_FOLDER_ID"),
      lastSubmittedAt: PropertiesService.getDocumentProperties().getProperty("LEADERS_SUBMITTED_AT") || ""
    }
  };
}

function getLeaderEditorData() {
  return withLeaderLock_(function () { return readLeaderEditor_().data; });
}

function checkedLeaderEditor_(revision) {
  const state = readLeaderEditor_();
  if (!revision || revision !== state.data.revision) {
    throw new Error("Someone else changed the roster. Your edits are still open here. Copy any changes you need, then reload before saving.");
  }
  return state;
}

function writeLeaderDraft_(state, leaders) {
  writeLeaderRows_(state.draft, [DRAFT_HEADERS].concat(leaders.map(function (leader) {
    return [leader.id, leader.name, leader.title, LEADER_GROUPS[leader.group], leader.photo];
  })), 5);
}

function saveLeaderDraft(payload) {
  const leaders = validateLeaderDraft_(payload?.leaders, true);
  return withLeaderLock_(function () {
    const state = checkedLeaderEditor_(payload.revision);
    writeLeaderDraft_(state, leaders);
    return readLeaderEditor_().data;
  });
}

function publishLeaderDraft(payload) {
  const leaders = validateLeaderDraft_(payload?.leaders, false);
  return withLeaderLock_(function () {
    const state = checkedLeaderEditor_(payload.revision);
    // Keep any extra columns with their person when reordering/removing rows.
    const extraByPerson = {};
    state.approved.rows.slice(1).forEach(function (row) {
      const name = row[state.approved.columns[0]] || "";
      const group = row[state.approved.columns[2]] || "";
      if (name.trim()) extraByPerson[name.trim() + "\n" + leaderGroup_(group)] = row;
    });
    const width = state.approved.rows[0].length;
    const rows = [state.approved.rows[0]].concat(leaders.map(function (leader) {
      const old = extraByPerson[leader.name + "\n" + leader.group];
      const row = old ? old.slice() : Array(width).fill("");
      [leader.name, leader.title, LEADER_GROUPS[leader.group], leader.photo].forEach(function (value, index) {
        row[state.approved.columns[index]] = value;
      });
      return row;
    }));
    writeLeaderDraft_(state, leaders);
    writeLeaderRows_(state.approved.sheet, rows, width);
    SpreadsheetApp.flush();
    PropertiesService.getDocumentProperties().setProperty("LEADERS_SUBMITTED_AT", new Date().toISOString());
    const data = readLeaderEditor_().data;
    // The approved roster is safe for the hourly sync even if dispatch fails.
    try {
      dispatchLeadersPublish_();
      data.message = "Submitted for publishing. Check publish status in a few minutes; browsers can take up to 10 more minutes to refresh.";
    } catch (error) {
      data.message = "Roster approved and saved. Immediate publishing could not start: " + error.message + " The next hourly sync will retry.";
    }
    return data;
  });
}

function uploadLeaderPhoto(payload) {
  // This is a bound-dialog function, running as the signed-in Sheet editor.
  approvedLeaderSheet_();
  const folderId = PropertiesService.getScriptProperties().getProperty("LEADERS_PHOTOS_FOLDER_ID");
  if (!folderId) throw new Error("Photo uploads need the shared photos folder configured by the chapter's technology lead.");
  const types = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" };
  if (!payload || !types[payload.type] || typeof payload.base64 !== "string") throw new Error("Choose a JPEG, PNG, WebP or HEIC photo.");
  if (payload.base64.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.base64)) throw new Error("Choose a photo smaller than 10 MB.");
  const bytes = Utilities.base64Decode(payload.base64);
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new Error("Choose a photo smaller than 10 MB.");
  const name = String(payload.name || "headshot").replace(/[^\w .-]/g, "").slice(0, 80).replace(/\.[^.]*$/, "") || "headshot";
  const blob = Utilities.newBlob(bytes, payload.type, name + "-" + Utilities.getUuid().slice(0, 8) + "." + types[payload.type]);
  const file = DriveApp.getFolderById(folderId).createFile(blob);
  // Inherits the folder permissions; never make a Drive photo public.
  return { photo: "https://drive.google.com/file/d/" + file.getId() + "/view" };
}

function getLeaderPhotoPreview(photo) {
  const id = leaderPhotoId_(String(photo || ""));
  if (!id) return "";
  const state = withLeaderLock_(function () { return readLeaderEditor_(); });
  if (!state.data.leaders.some(function (leader) { return leaderPhotoId_(leader.photo) === id; })) return "";
  try {
    const thumbnail = DriveApp.getFileById(id).getThumbnail();
    return thumbnail ? "data:" + thumbnail.getContentType() + ";base64," + Utilities.base64Encode(thumbnail.getBytes()) : "";
  } catch (error) {
    return ""; // A missing thumbnail must not block editing the person's name.
  }
}
