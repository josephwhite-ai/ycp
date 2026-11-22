import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { rowsToLeaders } from "../src/sheet.js";

// Exercise the real Apps Script callbacks with in-memory Sheets/Drive services.
// Tests cover publication boundaries, shared-editor conflicts and upload privacy.
const source = ["Publish.gs", "Editor.gs"].map(file => readFileSync(new URL(`../sheet/${file}`, import.meta.url), "utf8")).join("\n");
const copy = value => JSON.parse(JSON.stringify(value));

function setup() {
  let uuid = 0, nextId = 1, dispatchStatus = 204, locked = false;
  const tabs = [], scriptProperties = new Map(), documentProperties = new Map(), uploads = [], requests = [];
  function tab(name, rows) {
    const sheet = {
      name, rows:copy(rows), id:nextId++, hidden:false,
      getName() { return this.name; }, getSheetId() { return this.id; },
      getLastRow() { return this.rows.length; }, getMaxRows() { return 1000; }, getMaxColumns() { return 26; },
      hideSheet() { this.hidden = true; },
      getDataRange() { return { getDisplayValues:() => copy(this.rows) }; },
      getRange(row, column, height, width) {
        return { setRichTextValues:values => {
          for (let y = 0; y < height; y++) {
            this.rows[row+y-1] ||= [];
            for (let x = 0; x < width; x++) this.rows[row+y-1][column+x-1] = values[y][x].text;
          }
        } };
      }
    };
    tabs.push(sheet); return sheet;
  }
  const approved = tab("Approved leaders", [
    ["Name","Title","Group","Photo","Notes"],
    ["Ann Lee","President","Leadership","","Ann's note"],
    ["Fr. Bob","Chaplain","Board & Chaplaincy","","Bob's note"]
  ]);
  const properties = values => ({ getProperty:key => values.get(key) || null, setProperty:(key,value) => values.set(key,value) });
  const book = { getSheets:() => tabs, getSheetByName:name => tabs.find(sheet => sheet.name === name), insertSheet:(name, index) => { assert.equal(index, tabs.length, "draft tab goes last"); return tab(name, []); } };
  const context = vm.createContext({
    console, Set, Date,
    SpreadsheetApp: { getActiveSpreadsheet:() => book, flush() {}, newRichTextValue:() => ({ text:"", setText(text) { this.text = text; return this; }, build() { return { text:this.text }; } }) },
    LockService: { getDocumentLock:() => ({ waitLock() { assert.equal(locked, false); locked = true; }, releaseLock() { locked = false; } }) },
    PropertiesService: { getDocumentProperties:() => properties(documentProperties), getScriptProperties:() => properties(scriptProperties) },
    Utilities: {
      DigestAlgorithm:{ SHA_256:"sha256" }, computeDigest:(_,text) => Array.from(createHash("sha256").update(text).digest()),
      getUuid:() => `uuid-${++uuid}`, base64Decode:text => Array.from(Buffer.from(text,"base64")),
      base64Encode:bytes => Buffer.from(bytes).toString("base64"), newBlob:(bytes,type,name) => ({ bytes,type,name })
    },
    DriveApp: {
      getFolderById:id => ({ createFile:blob => { uploads.push({ id,blob }); return { getId:() => "1UploadedPhotoFile1234567890" }; } }),
      getFileById:() => ({ getThumbnail:() => ({ getBytes:() => [1,2,3], getContentType:() => "image/jpeg" }) })
    },
    UrlFetchApp: { fetch:(url,options) => {
      requests.push({ url,options });
      return { getResponseCode:() => dispatchStatus, getContentText:() => JSON.stringify({ workflow_runs:[] }) };
    } }
  });
  vm.runInContext(source, context);
  return { api:context, approved, tabs, uploads, requests, scriptProperties, documentProperties, setDispatchStatus:value => { dispatchStatus = value; } };
}

test("opening imports the approved roster into a separate hidden draft", () => {
  const { api,approved,tabs } = setup(), before = copy(approved.rows);
  const state = api.getLeaderEditorData();
  assert.equal(state.leaders.length, 2);
  assert.equal(state.leaders[1].group, "board");
  assert.equal(state.hasUnpublishedChanges, false);
  assert.deepEqual(approved.rows, before);
  assert.equal(tabs[1].name, "_Leaders draft");
  assert.equal(tabs[1].hidden, true);
  assert.equal(api.getLeaderEditorData().revision, state.revision, "opening again is stable");
});

test("saving a draft survives reopening and never changes what the hourly sync reads", () => {
  const { api,approved,requests } = setup(), before = copy(approved.rows);
  const state = api.getLeaderEditorData(); state.leaders[0].name = "Ann Updated";
  const saved = api.saveLeaderDraft(state);
  assert.equal(saved.hasUnpublishedChanges, true);
  assert.equal(api.getLeaderEditorData().leaders[0].name, "Ann Updated");
  assert.deepEqual(approved.rows, before);
  assert.equal(requests.length, 0);
});

test("publishing promotes draft edits, ordering, additions and removals to the sync format", () => {
  const { api,approved,scriptProperties,requests } = setup(); scriptProperties.set("GITHUB_TOKEN", "test-only");
  const state = api.getLeaderEditorData();
  state.leaders = [state.leaders[1], { id:"new-person", name:"=Example", title:"Treasurer", group:"leadership", photo:"https://example.org/photo.jpg" }];
  const published = api.publishLeaderDraft(state);
  assert.equal(published.hasUnpublishedChanges, false);
  assert.match(published.message, /Submitted/);
  const parsed = rowsToLeaders(approved.rows);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.leaders.map(person => person.name), ["Fr. Bob","=Example"]);
  assert.equal(approved.rows[1][4], "Bob's note", "notes follow unchanged people");
  assert.ok(approved.rows[2][0].startsWith("="), "names are written through rich text, not formulas");
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].options.payload).ref, "main");
});

test("a stale editor cannot overwrite someone else's draft or manual Sheet edits", () => {
  const { api,approved } = setup(), a = api.getLeaderEditorData(), b = api.getLeaderEditorData();
  a.leaders[0].name = "Saved by A"; const saved = api.saveLeaderDraft(a);
  b.leaders[0].name = "Stale B";
  assert.throws(() => api.saveLeaderDraft(b), /Someone else changed/);
  assert.throws(() => api.publishLeaderDraft(b), /Someone else changed/);
  assert.equal(api.getLeaderEditorData().leaders[0].name, "Saved by A");
  approved.rows[1][1] = "Manually changed";
  assert.throws(() => api.publishLeaderDraft(saved), /Someone else changed/);
});

test("invalid people and an empty publication leave the approved roster intact", () => {
  const { api,approved } = setup(), before = copy(approved.rows);
  for (const change of [
    state => { state.leaders[0].name = ""; },
    state => { state.leaders[0].group = "wrong"; },
    state => { state.leaders[0].photo = "javascript:alert(1)"; },
    state => { state.leaders[1].id = state.leaders[0].id; },
    state => { state.leaders = []; }
  ]) {
    const state = api.getLeaderEditorData(); change(state);
    assert.throws(() => api.publishLeaderDraft(state));
    assert.deepEqual(approved.rows, before);
  }
  const state = api.getLeaderEditorData(); state.leaders = [];
  assert.equal(api.saveLeaderDraft(state).leaders.length, 0, "an empty work-in-progress can still be saved");
});

test("dispatch failures retain the approved roster for the hourly sync and explain the outcome", () => {
  const { api,approved,scriptProperties,setDispatchStatus } = setup();
  scriptProperties.set("GITHUB_TOKEN", "test-only"); setDispatchStatus(403);
  const state = api.getLeaderEditorData(); state.leaders[0].title = "New title";
  const result = api.publishLeaderDraft(state);
  assert.match(result.message, /Roster approved and saved.*hourly/);
  assert.equal(approved.rows[1][1], "New title");
  assert.equal(api.getLeaderEditorData().hasUnpublishedChanges, false);
});

test("moving the approved tab prevents exporting a draft by accident", () => {
  const { api,tabs } = setup(); api.getLeaderEditorData(); tabs.reverse();
  assert.throws(() => api.getLeaderEditorData(), /first position/);
});

test("photo uploads use the configured folder without granting public access", () => {
  const { api,uploads,scriptProperties,approved } = setup(), before = copy(approved.rows);
  assert.throws(() => api.uploadLeaderPhoto({}), /configured/);
  scriptProperties.set("LEADERS_PHOTOS_FOLDER_ID", "private-photo-folder");
  const photo = api.uploadLeaderPhoto({ name:"Ann.png",type:"image/png",base64:Buffer.from("photo-bytes").toString("base64") });
  assert.match(photo.photo, /^https:\/\/drive.google.com\/file\/d\//);
  assert.equal(uploads[0].id, "private-photo-folder");
  assert.equal(uploads[0].blob.type, "image/png");
  assert.deepEqual(approved.rows, before, "uploading alone never publishes a photo");
  assert.throws(() => api.uploadLeaderPhoto({ type:"text/html",base64:"AAAA" }), /JPEG/);
  assert.throws(() => api.uploadLeaderPhoto({ type:"image/png",base64:"A".repeat(14*1024*1024) }), /10 MB/);
});

test("Drive previews are limited to photos already in the saved roster", () => {
  const { api } = setup(), state = api.getLeaderEditorData();
  const photo = "https://drive.google.com/file/d/1PrivatePhotoFile1234567890/view";
  assert.equal(api.getLeaderPhotoPreview(photo), "");
  state.leaders[0].photo = photo; api.saveLeaderDraft(state);
  assert.equal(api.getLeaderPhotoPreview(photo), "data:image/jpeg;base64,AQID");
});

test("the installed editor's inline JavaScript parses", () => {
  const html = readFileSync(new URL("../sheet/Editor.html", import.meta.url), "utf8");
  for (const [,script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script);
});
