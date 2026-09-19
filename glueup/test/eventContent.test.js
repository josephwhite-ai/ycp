import test from "node:test";
import assert from "node:assert/strict";

import { centerSummaryHtml, eventSummaryHtml } from "../src/generate/eventContent.js";

test("centers plain-text event summary paragraphs", () => {
  assert.equal(
    eventSummaryHtml({ description: "First paragraph.\n\nSecond paragraph." }),
    '<p style="text-align: center;">First paragraph.</p><p style="text-align: center;">Second paragraph.</p>'
  );
});

test("centers rich summary blocks while preserving formatting", () => {
  assert.equal(
    eventSummaryHtml({
      descriptionHtml: '<p><strong>Welcome</strong></p><ul><li style="color: red;">Reflect</li></ul>'
    }),
    '<p style="text-align: center;"><strong>Welcome</strong></p><ul><li style="color: red; text-align: center;">Reflect</li></ul>'
  );
});

test("overrides an existing block alignment without duplicating it", () => {
  assert.equal(
    centerSummaryHtml('<p style="font-weight: 600; text-align: right; color: blue">Text</p>'),
    '<p style="font-weight: 600; text-align: center; color: blue">Text</p>'
  );
});
