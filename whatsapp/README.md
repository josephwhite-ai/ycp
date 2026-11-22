# WhatsApp photo saver

Saves photos posted in the chapter's WhatsApp groups to the YCP shared drive, with no computer left running.

How it works: the AutoForwardText app on a phone in the groups forwards each WhatsApp message to Gmail as an email. A Google Apps Script checks Gmail every 15 minutes and files photos from roster members into `<year>/<month>` folders on the shared drive.

It depends on that phone staying in the groups with AutoForwardText running. Only messages forwarded after setup are captured; older history is not.

An earlier Playwright scraper for WhatsApp Web was retired in favour of this approach. It needed a browser session left open on a Mac and broke whenever WhatsApp Web's page changed. It is in git history (commit `c3c4b83`) if a one-time backfill of older photos is ever needed.

## Setup

`PhotoSaver.gs` reads the WhatsApp emails that AutoForwardText sends to Gmail. It keeps messages from phone numbers on the team roster sheet and copies their photo attachments into `<year>/<month>` folders on the YCP shared drive.

1. Create a project at script.google.com while signed in to the Gmail account that receives the emails. Paste in `PhotoSaver.gs`.
2. The allowlist comes from the team roster, the tab set by `ROSTER_SPREADSHEET_ID` and `ROSTER_SHEET_GID`. Each run reads it fresh, so adding someone to the roster is enough. The script reads columns whose header mentions phone, mobile, cell, WhatsApp or tel. If the first 10 rows have no such header, it reads phone numbers from any cell on the tab. Numbers match in any format, compared on their last 10 digits; one cell can hold several, separated by commas, semicolons, slashes or line breaks. If the tab is missing or has no numbers, the run stops instead of saving nothing. The account running the script needs at least view access to the roster. Put anyone not on the roster in `CONFIG.SENDERS`. `CONFIG.FOLDER_ID` already points at the shared drive. The account running the script needs permission to add files there and, if folder creation is enabled, permission to create folders.
3. In the Apps Script editor, click **Services +**, choose **Drive API**, and add **v3** with identifier `Drive`. Alternatively, enable the manifest in Project Settings and copy `appsscript.json`. If using a standard Google Cloud project, enable its Drive API too.
4. Run `savePhotos` once and approve the Gmail, Sheets and Drive access. Run `backfillPhotos` for the last 90 days. Each run reads at most `MAX_THREADS` threads (100 by default); a larger history needs smaller non-overlapping date windows passed to `savePhotos(query)` so the same first page is not processed repeatedly.
5. Run `installTrigger` to repeat the check every 15 minutes.

Photos go in existing year and month folders, recognizing styles such as `11`, `11 - November`, `Nov`, `2026-11`, and `November 2026`. Multiple matching folders cause an error rather than selecting one arbitrarily. Event folders such as `November Gala` and day folders such as `11-14-2026` are not treated as month folders. The actual destination naming could not be verified from this environment, so missing-folder creation is disabled by default. After verifying the names, set `CREATE_MISSING_FOLDERS: true` to create missing folders as `2026` / `11 - November`; change new-folder names with `YEAR_FOLDER_FORMAT` and `MONTH_FOLDER_FORMAT`.

Routing and filenames use the WhatsApp **Time** field converted to `CONFIG.TIME_ZONE` (`America/New_York`), falling back to the email timestamp only when the Time field is absent. A malformed Time field stops the run rather than filing the photo under a guessed month. The same date is used for historical imports.

Each saved photo records its Gmail message ID and attachment index in the Drive file's description at upload time. Reruns skip photos with the same marker in that month's folder, and a script lock prevents overlapping runs. A photo moved out of that folder (including photos uploaded by an older version directly to the root) could be saved again. Don't edit the first line of those descriptions. Image attachments include inline images, which can also include signature logos. Gmail sender and subject checks are repeated for each individual message because a search returns entire conversations.

Tests: `node --test whatsapp/PhotoSaver.test.js`.
