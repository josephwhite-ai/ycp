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

## Gmail photo saver (Apps Script)

`gmail/PhotoSaver.gs` reads the WhatsApp emails that AutoForwardText sends to Gmail. It keeps messages from the senders in `CONFIG.SENDERS` and copies their photo attachments into `<year>/<month>` folders on the YCP shared drive.

1. Create a project at script.google.com while signed in to the Gmail account that receives the emails. Paste in `PhotoSaver.gs`.
2. Fill in `CONFIG.SENDERS` (phone numbers or exact display names from the Name row). The current phone number is from the sample email; replace it with your desired sender list. `CONFIG.FOLDER_ID` already points at the shared drive. The account running the script needs permission to add files there and, if folder creation is enabled, permission to create folders.
3. In the Apps Script editor, click **Services +**, choose **Drive API**, and add **v3** with identifier `Drive`. Alternatively, enable the manifest in Project Settings and copy `gmail/appsscript.json`. If using a standard Google Cloud project, enable its Drive API too.
4. Run `savePhotos` once and approve the Gmail and Drive access. Run `backfillPhotos` for the last 90 days. Each run reads at most `MAX_THREADS` threads (100 by default); a larger history needs smaller non-overlapping date windows passed to `savePhotos(query)` so the same first page is not processed repeatedly.
5. Run `installTrigger` to repeat the check every 15 minutes.

Photos go in existing year and month folders, recognizing styles such as `11`, `11 - November`, `Nov`, `2026-11`, and `November 2026`. Multiple matching folders cause an error rather than selecting one arbitrarily. Event folders such as `November Gala` and day folders such as `11-14-2026` are not treated as month folders. The actual destination naming could not be verified from this environment, so missing-folder creation is disabled by default. After verifying the names, set `CREATE_MISSING_FOLDERS: true` to create missing folders as `2026` / `11 - November`; change new-folder names with `YEAR_FOLDER_FORMAT` and `MONTH_FOLDER_FORMAT`.

Routing and filenames use the WhatsApp **Time** field converted to `CONFIG.TIME_ZONE` (`America/New_York`), falling back to the email timestamp only when the Time field is absent. A malformed Time field stops the run rather than filing the photo under a guessed month. The same date is used for historical imports.

Each saved photo records its Gmail message ID and attachment index in the Drive file's description at upload time. Reruns skip photos with the same marker in that month's folder, and a script lock prevents overlapping runs. A photo moved out of that folder (including photos uploaded by an older version directly to the root) could be saved again. Don't edit the first line of those descriptions. Image attachments include inline images, which can also include signature logos. Gmail sender and subject checks are repeated for each individual message because a search returns entire conversations.

Tests: `node --test whatsapp/gmail/PhotoSaver.test.js`.
