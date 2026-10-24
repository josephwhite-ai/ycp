import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEventVenue } from "../src/extract/venue.js";

test("keeps parish and church names while retaining the actual street address", () => {
  const v = normalizeEventVenue({ venue: "Parish of Saint Teresa of Calcutta\nSt. Bartholomew’s Church\n45 Ludlow Rd\nManchester, CT 06040" });
  assert.equal(v.name, "Parish of Saint Teresa of Calcutta — St. Bartholomew’s Church");
  assert.equal(v.address, "45 Ludlow Rd");
  assert.equal(v.city, "Manchester");
});

test("preserves suites and supports simple, one-line and empty venues", () => {
  assert.equal(normalizeEventVenue({ venue: "Venue\n123 Main St\nSuite 2\nHartford, CT 06103" }).address, "123 Main St, Suite 2");
  assert.equal(normalizeEventVenue({ venue: "Venue\n45 Ludlow Rd\nManchester, CT 06040" }).name, "Venue");
  assert.equal(normalizeEventVenue({ venue: "Venue", city: "Hartford" }).city, "Hartford");
  assert.equal(normalizeEventVenue({}).address, "");
});
