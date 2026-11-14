import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parsePhotoRef, rowsToLeaders, slugify } from "../src/sheet.js";

const DRIVE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";

test("parseCsv handles quotes, commas, newlines and a byte-order mark", () => {
  const csv = '﻿Name,Title\r\n"Hoffner, Sr. Christine","Treasurer, ""ASCJ""\nHamden"\r\nAnn,\n';
  assert.deepEqual(parseCsv(csv), [
    ["Name", "Title"],
    ["Hoffner, Sr. Christine", 'Treasurer, "ASCJ"\nHamden'],
    ["Ann", ""]
  ]);
});

test("parsePhotoRef recognises Drive links, bare IDs and web addresses", () => {
  for (const link of [
    `https://drive.google.com/file/d/${DRIVE_ID}/view?usp=sharing`,
    `https://drive.google.com/open?id=${DRIVE_ID}`,
    `https://drive.google.com/uc?export=download&id=${DRIVE_ID}`,
    ` ${DRIVE_ID} `
  ]) {
    assert.deepEqual(parsePhotoRef(link), { kind: "drive", id: DRIVE_ID }, link);
  }
  assert.deepEqual(parsePhotoRef("https://example.org/a.jpg"), { kind: "url", url: "https://example.org/a.jpg" });
  assert.equal(parsePhotoRef("   "), null);
  assert.equal(parsePhotoRef("natasha.jpg").kind, "invalid");
  assert.equal(parsePhotoRef("javascript:alert(1)").kind, "invalid");
});

test("rowsToLeaders keeps sheet order, maps group labels and skips blank rows", () => {
  const { leaders, errors } = rowsToLeaders([
    [" Name ", "TITLE", "Group", "Photo", "Notes for editors"],
    ["Ann Lee", "President", "Leadership", `https://drive.google.com/file/d/${DRIVE_ID}/view`, "x"],
    ["", "", "", "", "a note on an otherwise empty row"],
    ["Fr. Bob", "Chaplain", "board & chaplaincy", ""],
    ["Cy", "", "  Board  and  Chaplaincy ", "https://example.org/c.jpg"]
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    leaders.map(({ row, name, group, photo }) => [row, name, group, photo?.kind ?? null]),
    [[2, "Ann Lee", "leadership", "drive"], [4, "Fr. Bob", "board", null], [5, "Cy", "board", "url"]]
  );
});

test("rowsToLeaders reports every problem with its row number", () => {
  const { errors } = rowsToLeaders([
    ["Name", "Title", "Group", "Photo"],
    ["Ann", "President", "Boad", "ann.jpg"],
    ["", "Treasurer", "Leadership", ""]
  ]);
  assert.deepEqual(errors, [
    'Row 2 (Ann): Group must be "Leadership" or "Board & Chaplaincy" (it says "Boad"); Photo must be a Google Drive link or a web address starting with https://.',
    "Row 3: Name is empty."
  ]);
});

test("rowsToLeaders rejects a sheet without the expected headings or without leaders", () => {
  assert.match(rowsToLeaders([["Name", "Role"]]).errors[0], /missing: title, group, photo/);
  assert.deepEqual(rowsToLeaders([["Name", "Title", "Group", "Photo"]]).errors, ["The sheet has no leaders."]);
});

test("slugify makes safe file names", () => {
  assert.equal(slugify("Sr. Faith Marie Woolsley, FSE"), "sr-faith-marie-woolsley-fse");
  assert.equal(slugify("José Ñúñez"), "jose-nunez");
  assert.equal(slugify("!!!"), "leader");
});
