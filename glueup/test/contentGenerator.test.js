import test from "node:test";
import assert from "node:assert/strict";

import { generateArtifacts } from "../src/generate/contentGenerator.js";
import { shortenEventSummary } from "../src/generate/eventContent.js";

test("deterministic campaign-summary fallback keeps short copy unchanged", () => {
  assert.equal(shortenEventSummary("Join us for an evening of faith and fellowship."), "Join us for an evening of faith and fellowship.");
});

test("deterministic campaign-summary fallback respects its word limit", () => {
  const source = Array.from({ length: 20 }, (_, index) => `word${index + 1}`).join(" ");
  const shortened = shortenEventSummary(source, { maxWords: 10 });
  assert.equal(shortened, "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10…");
});

test("content generation uses the configured Gemini API", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return {
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  webpage: "Web brief",
                  campaignSummary: "A concise campaign invitation.",
                  emails: { weekBefore: "Week brief", dayBefore: "Day brief" },
                  photoRecommendations: []
                })
              }]
            }
          }]
        };
      }
    };
  };

  try {
    const generated = await generateArtifacts({
      event: { description: "A longer event description.", rawFields: {} },
      photos: [],
      config: { geminiApiKey: "test-key", geminiModel: "gemini-test" }
    });
    assert.equal(request.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    assert.equal(request.options.headers["x-goog-api-key"], "test-key");
    assert.equal(generated.campaignSummary, "A concise campaign invitation.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
