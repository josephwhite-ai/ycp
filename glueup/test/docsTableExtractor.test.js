import test from "node:test";
import assert from "node:assert/strict";

import { extractEventFromGoogleDoc } from "../src/extract/docsTableExtractor.js";
import { renderPublishedContent } from "../src/generate/eventContent.js";

function paragraph(...runs) {
  return {
    paragraph: {
      elements: runs.map(({ text, bold = false }) => ({
        textRun: { content: text, textStyle: bold ? { bold: true } : {} }
      }))
    }
  };
}

test("carries event-sheet bold text through final summary rendering", () => {
  const doc = {
    title: "October Event Summary Sheet",
    body: {
      content: [
        {
          table: {
            tableRows: [
              {
                tableCells: [
                  { content: [paragraph({ text: "Description" })] },
                  {
                    content: [
                      paragraph(
                        { text: "Holiness is found " },
                        { text: "through the challenges of work", bold: true },
                        { text: "." }
                      )
                    ]
                  }
                ]
              },
              {
                tableCells: [
                  { content: [paragraph({ text: "The times at which the different speakers will be speaking" })] },
                  { content: [paragraph({ text: "6:30-7:00 PM Jane Doe\n7:00-7:30 PM John Smith" })] }
                ]
              },
              {
                tableCells: [
                  { content: [paragraph({ text: "The subject line of the campaign email" })] },
                  { content: [paragraph({ text: "An Evening of Faith and Work" })] }
                ]
              }
            ]
          }
        }
      ]
    }
  };

  const event = extractEventFromGoogleDoc(doc);
  assert.equal(
    event.descriptionHtml,
    "<p>Holiness is found <strong>through the challenges of work</strong>.</p>"
  );
  assert.equal(event.rawSpeakerTimes, "6:30-7:00 PM Jane Doe\n7:00-7:30 PM John Smith");
  assert.equal(event.rawCampaignSubject, "An Evening of Faith and Work");
  assert.equal(
    renderPublishedContent({ event }).summaryHtml,
    '<p style="text-align: center;">Holiness is found <strong>through the challenges of work</strong>.</p>'
  );
});
