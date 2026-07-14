const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// IMAP fetches take a few seconds; cache briefly so tapping around the
// author area stays snappy.
const CACHE_TTL_MS = 2 * 60 * 1000;
let cache = { at: 0, data: null };

// Split a reply into the reader's own words and the quoted original email,
// so the portal can show the note up front and the context on demand.
// Gmail wraps its "On <date> <sender> wrote:" attribution across lines, so
// match it in the full text rather than line by line.
function splitReplyText(text) {
  const t = String(text || '').replace(/\r/g, '');
  const markers = [
    t.search(/\n\s*On [\s\S]{0,200}?wrote:\s*\n/), // Gmail/Apple Mail attribution
    t.search(/\n\s*-{3,}\s*Original Message\s*-{3,}/i), // Outlook style
    t.search(/\n\s*>/), // first quoted line
  ].filter((i) => i >= 0);
  const idx = markers.length ? Math.min(...markers) : -1;

  const own = (idx >= 0 ? t.slice(0, idx) : t)
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
  const quoted = idx >= 0
    ? t.slice(idx)
        .split('\n')
        .map((l) => l.replace(/^\s*>+\s?/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500)
    : '';
  return { own, quoted };
}

async function fetchInboxMessages() {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    return { enabled: false, messages: [] };
  }
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });

  await client.connect();
  const messages = [];
  const lock = await client.getMailboxLock('INBOX');
  try {
    const total = client.mailbox.exists;
    if (total > 0) {
      const start = Math.max(1, total - 49); // most recent 50
      for await (const msg of client.fetch(`${start}:*`, { source: true, flags: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const from = parsed.from?.value?.[0] || {};
          const { own, quoted } = splitReplyText(parsed.text);
          messages.push({
            id: msg.uid,
            fromName: from.name || from.address || 'Someone',
            fromAddress: (from.address || '').toLowerCase(),
            messageId: parsed.messageId || null, // for threading replies
            subject: parsed.subject || '(no subject)',
            date: parsed.date ? parsed.date.toISOString() : null,
            text: own,
            quoted,
            unread: !(msg.flags && msg.flags.has('\\Seen')),
          });
        } catch (err) {
          console.error('[inbox] failed to parse a message:', err.message);
        }
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  // Hide the blog's own outgoing mail (e.g. if the blog address subscribed to
  // itself) and automated system mail (Google security alerts, bounces, etc.) -
  // this view is only for real notes from readers.
  const isAutomated = (addr) =>
    /no-?reply|mailer-daemon|postmaster|notifications?@/.test(addr) ||
    addr.endsWith('@accounts.google.com') ||
    addr.endsWith('@google.com');
  const filtered = messages
    .filter((m) => m.fromAddress !== GMAIL_USER.toLowerCase() && !isAutomated(m.fromAddress))
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  console.log(`[inbox] fetched ${messages.length} message(s), ${filtered.length} from readers`);
  const data = { enabled: true, messages: filtered };
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { fetchInboxMessages };
