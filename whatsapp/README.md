# WhatsApp Scraper

Playwright-based helper scripts for logging into WhatsApp Web and scraping image/media activity from configured channels.

## Local setup

1. Install Python dependencies in your preferred environment:

```bash
pip install playwright
playwright install chromium
```

2. Copy the example channel config and edit it locally:

```bash
cp channels.example.json channels.json
```

3. Run the login helper to create a local browser session:

```bash
python3 login.py
```

4. Run the scraper:

```bash
./run_whatsapp_scraper.sh
```

## Not committed

The following are intentionally local-only because they can contain account/session data or generated output:

- `whatsapp_session/`
- `channels.json`
- `downloaded_images/`
- `debug_output/`
- `logs/`
- screenshots and probe images
