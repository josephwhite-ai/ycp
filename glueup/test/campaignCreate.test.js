import test from "node:test";
import assert from "node:assert/strict";

import { buildDefaultCampaignSetupPayloads } from "../src/glueup/campaignCreate.js";

test("campaign setup uses prepared concise summary instead of Glue Up full-summary block", () => {
  const payloads = buildDefaultCampaignSetupPayloads({
    eventId: "123",
    event: { eventName: "Test Event" },
    campaign: { title: "Test Campaign" },
    campaignSummaryHtml: "<p>Concise campaign copy.</p>",
    speakersHtml: "<p><strong>Featured Speakers</strong></p>"
  });
  const content = payloads.find(({ action }) => action === "ContentFormSubmit");
  assert.deepEqual(content.data.blocks.slice(0, 6), [
    { type: "organizationLogo", "value.size": "S", "value.alignment": "Left" },
    { type: "detailsHeader" },
    { type: "rsvp" },
    { type: "html", value: "<p>Dear [givenName,fallback=Subscriber],</p>" },
    { type: "html", value: "<p>Concise campaign copy.</p>" },
    { type: "html", value: "<p><strong>Featured Speakers</strong></p>" }
  ]);
  assert.equal(content.data.blocks.some(({ type }) => type === "summary"), false);
});
