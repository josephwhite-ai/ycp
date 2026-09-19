// Declarative AI-evaluated rules for organization-specific facts and wording.
// Add future rules here; the proofreader must return one evaluation per rule,
// and validation blocks when an evaluation is missing or an applicable rule fails.
export const SPECIAL_VALIDATION_RULES = [
  {
    id: "canonical-venue-saint-thomas-more-yale",
    label: "Canonical Saint Thomas More Yale venue name",
    severity: "error",
    canonicalValue: "Saint Thomas More Chapel & Center at Yale University",
    instruction:
      "Determine semantically whether the venue or any public-facing event copy refers to the Catholic chapel and center at Yale commonly called Saint Thomas More, St. Thomas More, STM, or a similar abbreviation. If it does, every such reference must use the exact wording ‘Saint Thomas More Chapel & Center at Yale University’ with no abbreviation, omission, alternate punctuation, or other deviation. Additional street-address text may follow the exact venue name."
  }
];

export function specialRulePromptData() {
  return SPECIAL_VALIDATION_RULES.map(({ id, label, canonicalValue, instruction }) => ({
    id,
    label,
    canonicalValue,
    instruction
  }));
}

export function validateSpecialRuleResults(contentReview) {
  const results = Array.isArray(contentReview?.specialRuleResults)
    ? contentReview.specialRuleResults
    : [];
  const byId = new Map(results.map((result) => [result.ruleId, result]));
  const errors = [];

  for (const rule of SPECIAL_VALIDATION_RULES) {
    const result = byId.get(rule.id);
    if (!result) {
      errors.push(`Special validation rule "${rule.label}" was not evaluated.`);
      continue;
    }
    if (result.applies && !result.passes) {
      errors.push(
        `Special validation rule "${rule.label}" failed${result.field ? ` in ${result.field}` : ""}: ` +
        `${result.reason || `use exactly "${rule.canonicalValue}"`}`
      );
    }
  }

  return errors;
}
