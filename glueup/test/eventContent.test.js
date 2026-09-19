import test from "node:test";
import assert from "node:assert/strict";

import {
  centerSummaryHtml,
  eventSummaryHtml,
  preservesBoldText
} from "../src/generate/eventContent.js";

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

test("accepts Quill normalization from strong to b", () => {
  assert.equal(
    preservesBoldText(
      '<p><strong>Becoming Saints</strong> in the workplace</p>',
      '<p class="ql-align-center"><b>Becoming Saints</b> in the workplace</p>'
    ),
    true
  );
});

test("detects bold formatting lost during persistence", () => {
  assert.equal(
    preservesBoldText(
      '<p><strong>Becoming Saints</strong> in the workplace</p>',
      '<p class="ql-align-center">Becoming Saints in the workplace</p>'
    ),
    false
  );
});
