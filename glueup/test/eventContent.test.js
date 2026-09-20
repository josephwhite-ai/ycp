import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCampaignSummaryHtml,
  centerSummaryHtml,
  eventSummaryHtml,
  preservesBoldText,
  renderPublishedContent
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

test("renders prepared campaign summary as escaped paragraph HTML", () => {
  assert.equal(
    buildCampaignSummaryHtml({}, "Join us for faith & fellowship."),
    "<p>Join us for faith &amp; fellowship.</p>"
  );
});

test("appends concise date, time, and venue lines to the campaign summary", () => {
  assert.equal(
    buildCampaignSummaryHtml(
      {
        eventDate: "2026-10-15",
        venue: "Saint Thomas More Chapel & Center at Yale University\n268 Park Street\nNew Haven, CT 06511",
        rawFields: { time: "6:30 PM - 8:00 PM" }
      },
      "A concise invitation."
    ),
    "<p>A concise invitation.</p>" +
      "<p>📅 October 15 | 6:30–8:00 PM</p>" +
      "<p>📍 Saint Thomas More Chapel &amp; Center at Yale University &ndash; New Haven, CT</p>"
  );
});

test("published content includes the prepared campaign summary", () => {
  const rendered = renderPublishedContent({
    event: { description: "A much longer source summary." },
    campaignSummary: "A concise invitation."
  });
  assert.equal(rendered.campaignSummaryHtml, "<p>A concise invitation.</p>");
});
