import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDefaultCampaignSetupPayloads,
  buildNativeSpeakersBlock,
  findGlueUpSpeakerId
} from "../src/glueup/campaignCreate.js";

const SPEAKER_ID = "69c9d18de4b00ff34448c3bb";

test("campaign setup uses prepared concise summary instead of Glue Up full-summary block", () => {
  const payloads = buildDefaultCampaignSetupPayloads({
    eventId: "123",
    event: { eventName: "Test Event" },
    campaign: { title: "Test Campaign" },
    campaignSummaryHtml: "<p>Concise campaign copy.</p>",
    speakerIds: [SPEAKER_ID]
  });
  const content = payloads.find(({ action }) => action === "ContentFormSubmit");
  assert.deepEqual(content.data.blocks.slice(0, 6), [
    { type: "organizationLogo", "value.size": "S", "value.alignment": "Left" },
    { type: "detailsHeader" },
    { type: "rsvp" },
    { type: "html", value: "<p>Dear [givenName,fallback=Subscriber],</p>" },
    { type: "html", value: "<p>Concise campaign copy.</p>" },
    { type: "speakers", [`value.speakers.${SPEAKER_ID}`]: true }
  ]);
  assert.equal(content.data.blocks.some(({ type }) => type === "summary"), false);
});

test("builds a native speakers block with every selected Glue Up speaker", () => {
  const secondId = "69c9d1d8e4b00ff34448c3c9";
  assert.deepEqual(buildNativeSpeakersBlock([SPEAKER_ID, secondId]), {
    type: "speakers",
    [`value.speakers.${SPEAKER_ID}`]: true,
    [`value.speakers.${secondId}`]: true
  });
});

test("finds a Glue Up speaker ID by the exact rendered name", () => {
  const html = `<dd data-id="${SPEAKER_ID}"><script type="application/json">{"name":"Fr Jeffrey Ellis"}</script></dd>`;
  assert.equal(findGlueUpSpeakerId(html, "Fr Jeffrey Ellis"), SPEAKER_ID);
  assert.equal(findGlueUpSpeakerId(html, "Another Speaker"), null);
});

test("uses the interpreted campaign subject instead of the event title", () => {
  const payloads = buildDefaultCampaignSetupPayloads({
    eventId: "123",
    event: { eventName: "Event Title", campaignSubject: "Custom Campaign Subject" },
    campaign: { title: "Campaign Name" }
  });
  const setup = payloads.find(({ action }) => action === "SetupCampaignFormSubmit");
  assert.equal(setup.data.setup.subject, "Custom Campaign Subject");
  assert.equal(setup.data.setup.campaignName, "Campaign Name");
});
