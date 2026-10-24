import test from "node:test";
import assert from "node:assert/strict";
import { selectEventTemplate, selectPublicEventTag } from "../src/templates/eventTypes.js";

test("anniversary classification survives networking wording in the reception description", () => {
  const event = { eventType: "Anniversary Party", eventName: "3rd Year Anniversary Mass and Reception", description: "Reception & Networking Happy Hour" };
  const selected = selectEventTemplate(event).selected;
  assert.equal(selected.key, "anniversary");
  assert.equal(selected.glueUp.blueprintCode, "90663");
  assert.deepEqual(selectPublicEventTag(event), { code: "3039", label: "Other Events" });
});

test("explicit program type takes priority over incidental description hints", () => {
  const selection = selectEventTemplate({ eventType: "ESS", description: "Meet us for networking and a happy hour after the panel discussion." });
  assert.equal(selection.selected.key, "executive-speaker-series");
  assert.equal(selection.selected.publicTag.code, "3037");
});

test("unknown explicit types require review rather than silently adopting description hints", () => {
  assert.equal(selectEventTemplate({ eventType: "Fundraiser", description: "Networking happy hour" }).selected, null);
});

test("abbreviations match whole words; public and members-only variants still work", () => {
  assert.equal(selectEventTemplate({ description: "A blessing for your professional life" }).selected, null);
  const selection = selectEventTemplate({ eventType: "NHH", description: "Members only" });
  assert.equal(selection.selected.variantKey, "members-only");
  assert.equal(selection.selected.publicTag.code, "3038");
  assert.equal(selectEventTemplate({ eventType: "EPD" }).selected.variantKey, "public");
});

test("event title takes priority when no explicit type is provided", () => {
  assert.equal(selectPublicEventTag({ eventName: "3rd Year Anniversary Mass and Reception", description: "Reception and Networking Happy Hour" }).code, "3039");
  assert.equal(selectEventTemplate({ eventName: "St Joseph Saturdays" }).selected.key, "st-joseph-saturdays");
});
