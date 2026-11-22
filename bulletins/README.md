# Bulletin event extraction (legacy)

The repository's first project. Given a parish bulletin PDF, a script asks an LLM for the event announcements and saves them as a bulleted list in a text file in a Drive folder. Large PDFs are split into 10 MB chunks first.

There are two versions with the same inputs and output, one per provider:

- `extract_and_write_gemini.py`, run by `.github/workflows/ocr-pdf-gemini.yml` (needs `GEMINI_API_KEY`)
- `extract_and_write_claude.py`, run by `.github/workflows/ocr-pdf-claude.yml` (needs `ANTHROPIC_API_KEY`)

Both workflows are started by hand (or through the GitHub API) with the PDF's URL, the Drive folder ID and a base name for the output file. Both also need `GOOGLE_SERVICE_ACCOUNT_JSON`.

```bash
pip install -r requirements.txt
python extract_and_write_gemini.py "<pdf url>" "<drive folder id>" "<output base name>"
```

**Status:** kept running, not developed further. It has no tests; CI only checks that the scripts compile and their dependencies install. If it's picked up again, the obvious first step is to merge the two scripts into one with a `--provider` option.
