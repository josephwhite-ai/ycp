# YCP Automation Monorepo

This repository contains automation projects for YCP workflows.

## Apps

- bulletins/: existing bulletin PDF event-extraction scripts.
- glueup/: Glue Up event-page and campaign preparation agent.

## Workflows

- .github/workflows/ocr-pdf-gemini.yml: runs the Gemini bulletin extractor.
- .github/workflows/ocr-pdf-claude.yml: runs the Claude bulletin extractor.
- .github/workflows/glueup-monthly-prepare.yml: prepares monthly Glue Up event artifacts from Google Drive.

## Secrets

- GOOGLE_SERVICE_ACCOUNT_JSON: service account JSON used by both apps.
- GEMINI_API_KEY: required for the Gemini bulletin workflow.
- ANTHROPIC_API_KEY: required for the Claude bulletin workflow.
- OPENAI_API_KEY: optional for Glue Up draft generation; deterministic templates work without it.
