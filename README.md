# YCP Automation Monorepo

This repository contains automation projects for YCP workflows.

## Apps

- bulletins/: existing bulletin PDF event-extraction scripts.
- glueup/: Glue Up event-page and campaign preparation agent.
- whatsapp/: WhatsApp Web media scraper and login helpers.

## Workflows

- .github/workflows/ocr-pdf-gemini.yml: runs the Gemini bulletin extractor.
- .github/workflows/ocr-pdf-claude.yml: runs the Claude bulletin extractor.
- .github/workflows/glueup-monthly-prepare.yml: prepares monthly Glue Up event artifacts from Google Drive.

## Secrets

- GOOGLE_SERVICE_ACCOUNT_JSON: service account JSON used by both apps.
- GEMINI_API_KEY: used for the Gemini bulletin workflow and Glue Up content generation, proofreading, and image selection.
- ANTHROPIC_API_KEY: required for the Claude bulletin workflow.
