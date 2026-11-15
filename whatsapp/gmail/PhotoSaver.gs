/**
 * Save WhatsApp photos from AutoForwardText emails to Google Drive, filed by year and month.
 *
 * AutoForwardText sends each WhatsApp message as an email with a small table:
 * Name / Content / Time / Direction / Account. This script reads that table,
 * keeps the messages from the senders listed in CONFIG.SENDERS, and copies their
 * photo attachments into <year>/<month> folders on the destination drive.
 *
 * Setup: paste this file into an Apps Script project, enable the Advanced Drive
 * service (v3), fill in CONFIG, run
 * savePhotos once to approve access, then run installTrigger to repeat it
 * every 15 minutes.
 */
var CONFIG = {
  // WhatsApp senders to keep. A phone number (any formatting) or a name exactly as
  // it shows in the email's Name row.
  SENDERS: ['+12035550142'],
  // Destination folder (here, the root of the YCP shared drive), from the URL:
  // drive.google.com/drive/folders/<ID>. Photos go into <year>/<month> subfolders.
  FOLDER_ID: '0APt58RkpagPZUk9PVA',
  // Names for year/month folders that don't exist yet, as Utilities.formatDate
  // patterns. Existing folders are reused whatever their style: "11", "11 - November",
  // "November", "Nov", "2026-11" and "November 2026" all count as November.
  YEAR_FOLDER_FORMAT: 'yyyy',
  MONTH_FOLDER_FORMAT: 'MM - MMMM',
  TIME_ZONE: 'America/New_York',
  // Keep existing organization until folder names have been verified.
  CREATE_MISSING_FOLDERS: false,
  // Gmail search for the forwarded messages. Keep the window short; savePhotos
  // skips photos it has already saved, so overlap is harmless.
  QUERY: 'from:support@autoforwardtext.com subject:"New WhatsApp From" has:attachment newer_than:2d',
  // Ignore messages you sent yourself.
  INCOMING_ONLY: true,
  // Most threads to read per run.
  MAX_THREADS: 100
};

var IMAGE_EXTENSION = /\.(jpe?g|png|gif|webp|heic|heif)$/i;

/** Main entry point: run by hand or from the time trigger. */
function savePhotos(query) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return 0;
  try {
    // A time trigger passes an event object, not a Gmail search string.
    return savePhotos_(typeof query === 'string' ? query : CONFIG.QUERY);
  } finally {
    lock.releaseLock();
  }
}

function savePhotos_(query) {
  var metadata = Drive.Files.get(CONFIG.FOLDER_ID, {
    supportsAllDrives: true, fields: 'id,name,mimeType,driveId'
  });
  if (metadata.mimeType !== 'application/vnd.google-apps.folder') throw new Error('Destination must be a folder.');
  var root = driveFolder_(metadata, metadata.driveId);
  var monthFolders = {};  // "2026-11" -> { folder, saved }
  var threads = GmailApp.search(query, 0, CONFIG.MAX_THREADS);
  var count = 0;

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      // Gmail search returns whole threads, including nonmatching messages.
      var from = message.getFrom();
      var address = (from.match(/<([^<>]+)>\s*$/) || [null, from])[1].trim().toLowerCase();
      if (address !== 'support@autoforwardtext.com' || !/^New WhatsApp From /i.test(message.getSubject())) return;
      var fields = parseForwardedMessage(message.getBody());
      if (!fields.name || !isWantedSender(fields, CONFIG.SENDERS)) return;
      if (CONFIG.INCOMING_ONLY && fields.direction && !/incoming/i.test(fields.direction)) return;

      var photos = photoAttachments_(message);
      if (!photos.length) return;
      var date = forwardedDate_(fields, message.getDate());
      var month = Utilities.formatDate(date, CONFIG.TIME_ZONE, 'yyyy-MM');
      if (!monthFolders[month]) {
        var folder = monthFolder(root, date);
        monthFolders[month] = { folder: folder, saved: savedKeys_(folder) };
      }
      var folder = monthFolders[month].folder, saved = monthFolders[month].saved;

      photos.forEach(function (blob, index) {
        var key = 'gmail-message:' + message.getId() + '#' + index;
        if (saved[key]) return;
        // Upload bytes and duplicate marker together so a partial run is safe to retry.
        Drive.Files.create({
          name: photoFileName(fields, date, blob, index), parents: [folder.getId()],
          description: key + '\nFrom: ' + fields.name + (fields.content ? '\nText: ' + fields.content : '')
        }, blob.copyBlob(), { supportsAllDrives: true, fields: 'id' });
        saved[key] = true;
        count++;
      });
    });
  });

  console.log('Saved ' + count + ' new photo(s) under ' + root.getName());
  return count;
}

/** One-off catch-up over older mail, e.g. the last 90 days. */
function backfillPhotos() {
  return savePhotos(CONFIG.QUERY.replace(/newer_than:\S+/, 'newer_than:90d'));
}

/** Run savePhotos every 15 minutes. Safe to run more than once. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'savePhotos') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('savePhotos').timeBased().everyMinutes(15).create();
}

/**
 * Read the Name / Content / Time / Direction / Account table from the email HTML.
 * Each label sits in a gray cell, with its value in the next cell.
 */
function parseForwardedMessage(html) {
  var fields = {};
  var row = /<td[^>]*bgcolor\s*=\s*["']?lightgr[ae]y["']?[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/gi;
  var match;
  while ((match = row.exec(html || ''))) {
    var label = htmlToText_(match[1]).toLowerCase();
    if (label) fields[label] = htmlToText_(match[2]);
  }
  var phone = (fields.name || '').match(/\+?\d[\d\s().-]{6,}\d/);
  fields.phone = phone ? digits_(phone[0]) : '';
  fields.displayName = (fields.name || '').replace(phone ? phone[0] : '', '').trim() || fields.name || '';
  return fields;
}

/** True when the sender's phone number or name matches an entry in senders. */
function isWantedSender(fields, senders) {
  return senders.some(function (sender) {
    var wantedDigits = digits_(sender);
    if (wantedDigits.length >= 7 && fields.phone) {
      // Compare the last 10 digits so "+1 (203) 555-0142" matches "2035550142".
      return wantedDigits.slice(-10) === fields.phone.slice(-10);
    }
    var wantedName = String(sender).trim().toLowerCase();
    return wantedName !== '' &&
      (wantedName === fields.displayName.toLowerCase() || wantedName === fields.name.toLowerCase());
  });
}

/** e.g. "2026-11-14 1150 Joe 1.jpg" */
function photoFileName(fields, date, blob, index) {
  var stamp = Utilities.formatDate(date, CONFIG.TIME_ZONE, 'yyyy-MM-dd HHmm');
  var original = blob.getName() || '';
  var extension = (original.match(/\.[a-z0-9]+$/i) || [extensionFor_(blob.getContentType())])[0];
  var who = (fields.displayName || fields.phone || 'unknown').replace(/[\\/:*?"<>|]/g, '').trim();
  return stamp + ' ' + who + ' ' + (index + 1) + extension;
}

/** The <year>/<month> folder for a date, reusing existing folders or creating them. */
function monthFolder(root, date) {
  var zone = CONFIG.TIME_ZONE;
  var year = Utilities.formatDate(date, zone, 'yyyy');
  var month = Number(Utilities.formatDate(date, zone, 'M'));
  var yearName = Utilities.formatDate(date, zone, CONFIG.YEAR_FOLDER_FORMAT);
  var yearFolder = findChild_(root, function (name) { return name.trim() === year || name.trim() === yearName; }) ||
    createFolder_(root, yearName);
  return findChild_(yearFolder, function (name) { return isMonthName(name, month, year); }) ||
    createFolder_(yearFolder, Utilities.formatDate(date, zone, CONFIG.MONTH_FOLDER_FORMAT));
}

function createFolder_(parent, name) {
  if (!CONFIG.CREATE_MISSING_FOLDERS) throw new Error('No matching folder for ' + name + ' under ' + parent.getName() + '. Check the existing folder names before enabling creation.');
  return parent.createFolder(name);
}

var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

/** True when a folder name means the given month (1-12), e.g. "11", "Nov", "2026-11". */
function isMonthName(name, month, year) {
  var text = String(name).toLowerCase().replace(new RegExp('(^|[^0-9])' + year + '(?=$|[^0-9])', 'g'), '$1');
  var words = text.match(/[a-z]+/g) || [];
  var numbers = (text.match(/\d+/g) || []).map(Number);
  var monthWords = words.filter(function (word) {
    return word.length >= 3 && MONTHS.some(function (m) { return m.indexOf(word) === 0; });
  });
  // Event/date folders aren't month folders, even when their names mention a month.
  if (words.some(function (word) { return monthWords.indexOf(word) === -1 && ['photo', 'photos', 'pictures', 'images'].indexOf(word) === -1; })) return false;
  if (numbers.some(function (number) { return number !== month; })) return false;
  if (monthWords.length) {
    return monthWords.every(function (word) { return MONTHS[month - 1].indexOf(word) === 0; });
  }
  return numbers.length > 0 && numbers[0] === month;
}

function findChild_(parent, test) {
  var folders = parent.getFolders();
  var found = null;
  while (folders.hasNext()) {
    var folder = folders.next();
    if (test(folder.getName())) {
      if (found) throw new Error('Ambiguous folders under ' + parent.getName() + ': ' + found.getName() + ', ' + folder.getName());
      found = folder;
    }
  }
  return found;
}

/** Use the WhatsApp timestamp so delayed forwards land in the original month. */
function forwardedDate_(fields, fallback) {
  if (!fields.time) return fallback;
  var match = fields.time.match(/^(.+\b[AP]M)\s+([A-Za-z_]+\/[A-Za-z_\/-]+|UTC|GMT)$/i);
  try {
    return Utilities.parseDate(match ? match[1] : fields.time,
      match ? match[2] : CONFIG.TIME_ZONE, 'MMM d, yyyy h:mm a');
  } catch (error) {
    throw new Error('Cannot parse WhatsApp Time: ' + fields.time);
  }
}

/** Folder adapter using Drive API v3, including shared drives and pagination. */
function driveFolder_(metadata, driveId) {
  return {
    getId: function () { return metadata.id; },
    getName: function () { return metadata.name; },
    getFolders: function () { return driveIterator_(listDriveChildren_(metadata.id, driveId, true).map(function (f) { return driveFolder_(f, driveId); })); },
    getFiles: function () { return driveIterator_(listDriveChildren_(metadata.id, driveId, false).map(function (file) { return { getDescription: function () { return file.description || ''; } }; })); },
    createFolder: function (name) {
      var folder = Drive.Files.create({ name: name, mimeType: 'application/vnd.google-apps.folder', parents: [metadata.id] },
        null, { supportsAllDrives: true, fields: 'id,name' });
      return driveFolder_(folder, driveId);
    }
  };
}

function driveIterator_(items) {
  var index = 0;
  return { hasNext: function () { return index < items.length; }, next: function () { return items[index++]; } };
}

function listDriveChildren_(folderId, driveId, foldersOnly) {
  var files = [];
  var options = {
    q: "'" + String(folderId).replace(/['\\]/g, '\\$&') + "' in parents and trashed = false" +
      (foldersOnly ? " and mimeType = 'application/vnd.google-apps.folder'" : ''),
    supportsAllDrives: true, includeItemsFromAllDrives: true, pageSize: 1000,
    fields: 'nextPageToken,incompleteSearch,files(id,name,description)'
  };
  if (driveId) { options.corpora = 'drive'; options.driveId = driveId; }
  do {
    var page = Drive.Files.list(options);
    if (page.incompleteSearch) throw new Error('Drive returned an incomplete listing.');
    files = files.concat(page.files || []);
    options.pageToken = page.nextPageToken;
  } while (options.pageToken);
  return files;
}

/** Image attachments, including images embedded in the email body. */
function photoAttachments_(message) {
  return message.getAttachments({ includeInlineImages: true, includeAttachments: true })
    .filter(function (blob) {
      var type = (blob.getContentType() || '').toLowerCase();
      return type.indexOf('image/') === 0 || IMAGE_EXTENSION.test(blob.getName() || '');
    });
}

/** Keys of photos already in the folder, read from each file's description. */
function savedKeys_(folder) {
  var keys = {};
  var files = folder.getFiles();
  while (files.hasNext()) {
    var key = (files.next().getDescription() || '').split('\n')[0];
    if (key.indexOf('gmail-message:') === 0) keys[key] = true;
  }
  return keys;
}

function htmlToText_(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, function (_, code) { return String.fromCharCode(code); })
    .replace(/&amp;/g, '&')
    .replace(/[ \t\r]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function digits_(value) {
  return String(value).replace(/\D/g, '');
}

function extensionFor_(contentType) {
  var map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif' };
  return map[(contentType || '').toLowerCase()] || '.jpg';
}
