import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTimeRanges, parseEventAgenda } from "../src/extract/agenda.js";

test("infers AM for a cross-noon range with a trailing PM", () => {
  assert.deepEqual(parseEventAgenda("8-3PM (9-2PM for retreat)"), [
    {
      startTime: "08:00",
      endTime: "15:00",
      label: "(9:00 AM–2:00 PM for retreat)",
      internal: false
    }
  ]);
});

test("keeps ordinary trailing-PM evening ranges in PM", () => {
  assert.deepEqual(parseEventAgenda("7-9PM Networking")[0], {
    startTime: "19:00",
    endTime: "21:00",
    label: "Networking",
    internal: false
  });
});

test("normalizes ambiguous ranges embedded in labels", () => {
  assert.equal(normalizeTimeRanges("(9-2PM for retreat)"), "(9:00 AM–2:00 PM for retreat)");
});
