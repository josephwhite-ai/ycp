// Run with: node --test whatsapp/gmail/PhotoSaver.test.js
// Loads PhotoSaver.gs into a sandbox with fake Gmail and Drive services.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync(__dirname + '/PhotoSaver.gs', 'utf8');

function email(name, content, direction = 'Incoming', time = 'Nov 14, 2026 11:50 AM America/New_York') {
  return `<h1>New WhatsApp Message</h1>
    <table width="70%"><tbody>
      <tr><td bgcolor="lightgray">Name</td></tr>
      <tr><td>${name}</td></tr>
      <tr><td bgcolor="lightgray">Content</td></tr>
      <tr><td>${content}</td></tr>
      <tr><td bgcolor="lightgray">Time</td></tr>
      <tr><td>${time}</td></tr>
      <tr><td bgcolor="lightgray">Direction</td></tr>
      <tr><td>${direction}</td></tr>
      <tr><td bgcolor="lightgray">Account</td></tr>
      <tr><td><a href="tel:(443)%20465-7439" value="+14434657439">+14434657439</a></td></tr>
    </tbody></table>`;
}

const blob = (name, type) => ({
  getName: () => name, getContentType: () => type,
  copyBlob() { return { ...this, setName(n) { this.name = n; return this; } }; }
});

// In-memory Drive folder tree.
let folderSequence = 0;
function folderNode(name, created) {
  const node = {
    id: 'folder-' + ++folderSequence, name, files: [], children: [],
    getName: () => name,
    getFolders() { let i = 0; return { hasNext: () => i < node.children.length, next: () => node.children[i++] }; },
    createFolder(n) { const child = folderNode(n, created); node.children.push(child); return child; },
    getFiles() { let i = 0; return { hasNext: () => i < node.files.length, next: () => node.files[i++] }; },
    createFile(b) {
      const f = { name: b.name, folder: node, description: '', getDescription() { return this.description; }, setDescription(d) { this.description = d; } };
      node.files.push(f); created.push(f); return f;
    }
  };
  return node;
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
// Match the Apps Script timezone semantics rather than the host timezone.
function formatDate(date, zone, pattern) {
  const pad = n => String(n).padStart(2, '0');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23'
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return pattern.replace(/yyyy|MMMM|MM|M|dd|HHmm/g, token => ({
    yyyy: parts.year, MMMM: MONTH_NAMES[parts.month - 1], MM: pad(parts.month),
    M: parts.month, dd: pad(parts.day), HHmm: pad(parts.hour) + pad(parts.minute)
  })[token]);
}

function parseDate(text, zone, pattern) {
  assert.equal(pattern, 'MMM d, yyyy h:mm a');
  const local = new Date(text + ' UTC');
  if (Number.isNaN(local.getTime())) throw new Error('Invalid date');
  const formatted = formatDate(local, zone, 'yyyy-MM-dd HHmm');
  const [date, time] = formatted.split(' ');
  const asUTC = new Date(date + 'T' + time.slice(0, 2) + ':' + time.slice(2) + ':00Z');
  return new Date(local.getTime() * 2 - asUTC.getTime());
}

function setup(messages, buildTree = () => {}, { pageSize = 1000 } = {}) {
  const created = [];
  const root = folderNode('YCP', created);
  root.id = '0APt58RkpagPZUk9PVA';
  buildTree(root);
  created.length = 0;
  const folders = () => {
    const all = [];
    function walk(node) { all.push(node); node.children.forEach(walk); }
    walk(root);
    return all;
  };
  const metadata = node => ({ id: node.id, name: node.name, mimeType: 'application/vnd.google-apps.folder', driveId: root.id });
  const searches = [];
  const ctx = {
    console: { log() {} },
    Drive: { Files: {
      get(id, options) {
        assert.equal(options.supportsAllDrives, true);
        return metadata(folders().find(f => f.id === id));
      },
      list(options) {
        assert.equal(options.supportsAllDrives, true);
        assert.equal(options.includeItemsFromAllDrives, true);
        assert.equal(options.corpora, 'drive');
        assert.equal(options.driveId, root.id);
        const parent = folders().find(f => f.id === options.q.match(/^'([^']+)'/)[1]);
        const items = parent.children.map(metadata).concat(options.q.includes('mimeType =') ? [] : parent.files);
        const offset = Number(options.pageToken || 0);
        return { files: items.slice(offset, offset + pageSize), nextPageToken: offset + pageSize < items.length ? String(offset + pageSize) : undefined };
      },
      create(data, bytes, options) {
        assert.equal(options.supportsAllDrives, true);
        const parent = folders().find(f => f.id === data.parents[0]);
        if (data.mimeType === 'application/vnd.google-apps.folder') return metadata(parent.createFolder(data.name));
        assert.ok(bytes, 'photo bytes are included');
        assert.match(data.description, /^gmail-message:/, 'marker is saved atomically with the photo');
        const file = parent.createFile({ name: data.name });
        file.setDescription(data.description);
        return { id: 'file-' + created.length };
      }
    } },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    GmailApp: { search: query => { assert.equal(typeof query, 'string'); searches.push(query); return [{ getMessages: () => messages }]; } },
    Session: { getScriptTimeZone: () => 'UTC' },
    Utilities: { formatDate, parseDate }
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { ctx, created, root, searches };
}

const NOV_14 = new Date(Date.UTC(2026, 10, 14, 16, 50));

const message = (id, html, attachments, date = NOV_14) => ({
  getId: () => id, getBody: () => html, getDate: () => date, getAttachments: () => attachments,
  getFrom: () => 'AutoForwardText <support@autoforwardtext.com>', getSubject: () => 'New WhatsApp From Joe'
});

test('parses the AutoForwardText table, including Gmail-style tel links', () => {
  const { ctx } = setup([]);
  const fields = ctx.parseForwardedMessage(email('Joe <a href="tel:(203)%20555-0142" value="+12035550142">+12035550142</a>', 'Feel free &amp; post'));
  assert.equal(fields.name, 'Joe +12035550142');
  assert.equal(fields.displayName, 'Joe');
  assert.equal(fields.phone, '12035550142');
  assert.equal(fields.content, 'Feel free & post');
  assert.equal(fields.direction, 'Incoming');
  assert.equal(fields.account, '+14434657439');
});

test('matches senders by phone in any format, or by name', () => {
  const { ctx } = setup([]);
  const fields = ctx.parseForwardedMessage(email('Joe +12035550142', 'hi'));
  assert.ok(ctx.isWantedSender(fields, ['(203) 555-0142']));
  assert.ok(ctx.isWantedSender(fields, ['joe']));
  assert.ok(!ctx.isWantedSender(fields, ['+12035550000', 'Ann']));
});

test('recognises month folder names in common styles', () => {
  const { ctx } = setup([]);
  for (const name of ['11', '11 - November', 'November', 'nov', '2026-11', 'November 2026', '2026_11 Nov photos'])
    assert.ok(ctx.isMonthName(name, 11, '2026'), name);
  for (const name of ['1', '10', '01 - January', 'Photos', '2026', 'Nov - Dec', 'November Gala', '11-14-2026', 'November 2025', '10 November'])
    assert.ok(!ctx.isMonthName(name, 11, '2026'), name);
  assert.ok(ctx.isMonthName('01 - January', 1, '2026'));
  assert.ok(ctx.isMonthName('May', 5, '2026'));
});

test('saves only image attachments from wanted, incoming senders, once, into existing month folders', () => {
  const messages = [
    message('m1', email('Joe +12035550142', 'photos'), [blob('IMG_1.jpeg', 'image/jpeg'), blob('notes.pdf', 'application/pdf'), blob('', 'image/png')]),
    message('m2', email('Ann +12035550000', 'not wanted'), [blob('a.jpg', 'image/jpeg')]),
    message('m3', email('Joe +12035550142', 'mine', 'Outgoing'), [blob('b.jpg', 'image/jpeg')])
  ];
  let november;
  const { ctx, created, root } = setup(messages, root => {
    const y2026 = root.createFolder('2026');
    y2026.createFolder('10 October');
    november = y2026.createFolder('11 November');
    november.createFile({ name: 'already.jpg' }).setDescription('gmail-message:m1#0\nFrom: Joe');
  });
  ctx.CONFIG.SENDERS = ['+1 203 555 0142'];
  assert.equal(ctx.savePhotos(), 1);
  assert.deepEqual(created.map(f => f.name), ['2026-11-14 1150 Joe 2.png']);
  assert.equal(created[0].folder, november);
  assert.match(created[0].description, /^gmail-message:m1#1\nFrom: Joe \+12035550142\nText: photos$/);
  assert.equal(root.children.length, 1, 'no new year folder');
  assert.equal(ctx.savePhotos(), 0, 'second run finds nothing new');
});

test('creates missing year and month folders', () => {
  const jan = new Date(Date.UTC(2027, 0, 2, 9, 5));
  const { ctx, created, root } = setup([message('m9', email('Joe +12035550142', '', 'Incoming', 'Jan 2, 2027 4:05 AM America/New_York'), [blob('x.jpg', 'image/jpeg')], jan)],
    root => root.createFolder('2026').createFolder('11 - November'));
  ctx.CONFIG.CREATE_MISSING_FOLDERS = true;
  assert.equal(ctx.savePhotos(), 1);
  assert.deepEqual(root.children.map(c => c.name), ['2026', '2027']);
  assert.deepEqual(root.children[1].children.map(c => c.name), ['01 - January']);
  assert.equal(created[0].folder, root.children[1].children[0]);
  assert.equal(created[0].name, '2027-01-02 0405 Joe 1.jpg');
});

test('uses the WhatsApp month even when forwarded in a different month', () => {
  const forwarded = message('late', email('Joe +12035550142', 'photos'), [blob('x.jpg', 'image/jpeg')], new Date('2026-12-01T12:00:00Z'));
  const { ctx, created } = setup([forwarded], root => root.createFolder('2026').createFolder('November'));
  assert.equal(ctx.savePhotos(), 1);
  assert.equal(created[0].folder.name, 'November');
});

test('uses New York year/month across UTC New Year and accepts a trigger event', () => {
  const forwarded = message('year-boundary', email('Joe +12035550142', '', 'Incoming', ''), [blob('x.jpg', 'image/jpeg')], new Date('2027-01-01T02:00:00Z'));
  const { ctx, created, searches } = setup([forwarded], root => root.createFolder('2026').createFolder('12'));
  assert.equal(ctx.savePhotos({ triggerUid: '123' }), 1);
  assert.equal(created[0].folder.name, '12');
  assert.equal(created[0].name, '2026-12-31 2100 Joe 1.jpg');
  assert.equal(searches[0], ctx.CONFIG.QUERY);
});

test('does not create missing or ambiguous month folders by default', () => {
  const messages = [message('m1', email('Joe +12035550142', ''), [blob('x.jpg', 'image/jpeg')])];
  const missing = setup(messages, root => root.createFolder('2026').createFolder('October'));
  assert.throws(() => missing.ctx.savePhotos(), /No matching folder/);
  assert.equal(missing.created.length, 0);
  const ambiguous = setup(messages, root => {
    const year = root.createFolder('2026'); year.createFolder('November'); year.createFolder('11');
  });
  assert.throws(() => ambiguous.ctx.savePhotos(), /Ambiguous folders/);
  assert.equal(ambiguous.created.length, 0);
});

test('checks individual message sender and subject inside Gmail threads', () => {
  const original = message('other', email('Joe', ''), [blob('x.jpg', 'image/jpeg')]);
  const messages = [
    { ...original, getFrom: () => 'wrong@example.com' },
    { ...original, getSubject: () => 'Other subject' }
  ];
  const { ctx, created } = setup(messages);
  assert.equal(ctx.savePhotos(), 0);
  assert.equal(created.length, 0);
});

test('paginates folder and saved-photo listings without duplicate uploads', () => {
  const messages = [message('paged', email('Joe +12035550142', ''), [blob('x.jpg', 'image/jpeg')])];
  const { ctx, created } = setup(messages, root => {
    const year = root.createFolder('2026'); year.createFolder('October');
    const november = year.createFolder('November');
    november.createFile({ name: 'other.jpg' }).setDescription('something else');
    november.createFile({ name: 'already.jpg' }).setDescription('gmail-message:paged#0');
  }, { pageSize: 1 });
  assert.equal(ctx.savePhotos(), 0);
  assert.equal(created.length, 0);
});
