# YCP Automation Monorepo

This repository contains automation projects for YCP workflows.

## Apps

- bulletins/: existing bulletin PDF event-extraction scripts.
- glueup/: Glue Up event-page and campaign preparation agent.
- webflow/: work on the Central Connecticut chapter page of the national Webflow site.
- whatsapp/: Apps Script that saves WhatsApp photos, forwarded to Gmail, into the shared drive.

## Workflows

- .github/workflows/ocr-pdf-gemini.yml: runs the Gemini bulletin extractor.
- .github/workflows/ocr-pdf-claude.yml: runs the Claude bulletin extractor.
- .github/workflows/glueup-monthly-prepare.yml: prepares monthly Glue Up event artifacts from Google Drive.
- .github/workflows/webflow-pages.yml: syncs the chapter leaders from a Google Sheet and publishes them with the Webflow embed script to GitHub Pages.

## Secrets

- GOOGLE_SERVICE_ACCOUNT_JSON: service account JSON used by the bulletin, Glue Up and Webflow leaders workflows.
- LEADERS_SHEET_ID (repository variable, not a secret): Google Sheet the Webflow leaders are published from.
- GEMINI_API_KEY: used for the Gemini bulletin workflow and Glue Up content generation, proofreading, and image selection.
- ANTHROPIC_API_KEY: required for the Claude bulletin workflow.
