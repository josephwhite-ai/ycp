import test from "node:test";
import assert from "node:assert/strict";

import {
  applyInterpretedEventFields,
  interpretEventFields
} from "../src/generate/interpretEventFields.js";

test("uses Gemini to interpret speaker times while preserving the campaign subject exactly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          speakerSchedule: [{ speakerName: "Jane Doe", startTime: "18:30", endTime: "19:00", topic: "Faith at Work" }]
        }) }] } }]
      };
    }
  });

  try {
    const interpreted = await interpretEventFields({
      event: {
        rawSpeakerTimes: "Jane speaks from 6:30 to 7 about Faith at Work",
        rawCampaignSubject: "  Join Us: Faith & Work  ",
        speakers: ["Jane Doe, Executive - Example Co"],
        agenda: [{ startTime: "18:00", endTime: "20:00", label: "Event", internal: false }]
      },
      config: { geminiApiKey: "test-key", geminiModel: "gemini-test" }
    });
    assert.equal(interpreted.campaignSubject, "Join Us: Faith & Work");
    assert.equal(interpreted.methods.speakerSchedule, "gemini");
    assert.deepEqual(interpreted.speakerSchedule, [
      { speakerName: "Jane Doe", startTime: "18:30", endTime: "19:00", topic: "Faith at Work" }
    ]);
    assert.deepEqual(applyInterpretedEventFields({ eventName: "Event" }, interpreted), {
      eventName: "Event",
      campaignSubject: "Join Us: Faith & Work",
      speakerSchedule: interpreted.speakerSchedule
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to deterministic speaker-time parsing without Gemini", async () => {
  const interpreted = await interpretEventFields({
    event: {
      rawSpeakerTimes: "6:30-7:00 PM Jane Doe",
      rawCampaignSubject: "Faith at Work",
      speakers: ["Jane Doe, Executive - Example Co"]
    },
    config: {}
  });
  assert.equal(interpreted.methods.speakerSchedule, "deterministic");
  assert.deepEqual(interpreted.speakerSchedule, [
    { speakerName: "Jane Doe", startTime: "18:30", endTime: "19:00", topic: "" }
  ]);
});
