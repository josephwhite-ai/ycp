import test from "node:test";
import assert from "node:assert/strict";

import {
  SPECIAL_VALIDATION_RULES,
  specialRulePromptData,
  validateSpecialRuleResults
} from "../src/validate/specialValidationRules.js";

const RULE_ID = "canonical-venue-saint-thomas-more-yale";

test("exports special rules as declarative AI prompt data", () => {
  assert.equal(SPECIAL_VALIDATION_RULES.length, 1);
  assert.deepEqual(specialRulePromptData()[0], {
    id: RULE_ID,
    label: "Canonical Saint Thomas More Yale venue name",
    canonicalValue: "Saint Thomas More Chapel & Center at Yale University",
    instruction: SPECIAL_VALIDATION_RULES[0].instruction
  });
});

test("blocks when an applicable AI rule fails", () => {
  assert.deepEqual(
    validateSpecialRuleResults({
      specialRuleResults: [{
        ruleId: RULE_ID,
        applies: true,
        passes: false,
        field: "venue",
        reason: "The venue is abbreviated as St. Thomas More Chapel."
      }]
    }),
    [
      'Special validation rule "Canonical Saint Thomas More Yale venue name" failed in venue: The venue is abbreviated as St. Thomas More Chapel.'
    ]
  );
});

test("passes exact canonical wording and non-applicable events", () => {
  for (const result of [
    { ruleId: RULE_ID, applies: true, passes: true },
    { ruleId: RULE_ID, applies: false, passes: true }
  ]) {
    assert.deepEqual(validateSpecialRuleResults({ specialRuleResults: [result] }), []);
  }
});

test("blocks when AI did not return an evaluation", () => {
  assert.deepEqual(
    validateSpecialRuleResults({ specialRuleResults: [] }),
    ['Special validation rule "Canonical Saint Thomas More Yale venue name" was not evaluated.']
  );
});
