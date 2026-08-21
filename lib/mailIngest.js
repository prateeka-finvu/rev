// Pulls the latest "counts" CSV straight out of a Gmail inbox, so the
// Monthly Revenue tab can auto-refresh from whatever Metabase last emailed
// instead of requiring a manual "Choose counts file" click every day.
//
// How it decides which email is "the" counts email:
//   - Subject must contain METABASE_EMAIL_SUBJECT (case-insensitive
//     substring match — IMAP SEARCH SUBJECT is itself substring/
//     case-insensitive, so this matches Gmail's own search behavior).
//   - Only emails received within EMAIL_LOOKBACK_DAYS (default 14) are
//     considered, so a stale months-old email with a similar subject never
//     gets picked up by accident.
//   - Among matches, the one with the latest "received on" date wins (IMAP
//     returns UIDs in ascending order for a given mailbox, so the highest
//     UID among the matches is the most recent — this is the actual
//     tie-breaker the caller in server.js relies on).
//   - Must have a .csv attachment (or a text/csv one without a .csv
//     filename) — an email that matches the subject/date filter but has no
//     CSV attached is skipped, not treated as an error.
//
// Requires GMAIL_USER + GMAIL_APP_PASSWORD in .env (a 16-character Google
// "App Password", not the regular account password — see README's "Auto-pull
// counts from email" section for how to generate one).
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const DEFAULT_LOOKBACK_DAYS = 14;

// Kept short and deliberately well under ImapFlow's own 90s/300s defaults —
// this call happens synchronously in the middle of a page load, so a
// blocked network (firewall, wrong host, outage) needs to surface as a
// clear, fast error instead of leaving the browser hanging for a minute or
// more. Real Gmail connects in well under a second when reachable at all.
const CONNECTION_TIMEOUT_MS = 15 * 1000;
const GREETING_TIMEOUT_MS = 10 * 1000;
const SOCKET_TIMEOUT_MS = 30 * 1000;

// Returns { subject, date, filename, buffer } for the newest matching email
// with a CSV attachment, or null if nothing matched. Throws on a genuine
// connection/auth failure (bad app password, network down, etc.) — the
// caller distinguishes "nothing matched" (null) from "couldn't even check"
// (thrown error) so the UI can show the right message either way.
async function fetchLatestCountsEmail({ host, user, pass, subjectContains, lookbackDays }) {
  if (!user || !pass) {
    const e = new Error('Email auto-pull is not configured — set GMAIL_USER and GMAIL_APP_PASSWORD in .env');
    e.status = 400;
    throw e;
  }
  const client = new ImapFlow({
    host: host || 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - (lookbackDays || DEFAULT_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000);
      const searchCriteria = { since };
      if (subjectContains) searchCriteria.subject = subjectContains;
      const uids = await client.search(searchCriteria, { uid: true });
      if (!uids || !uids.length) return null;

      // Newest first (highest UID = most recently received in this
      // mailbox) — walk backward until we find one that actually has a CSV
      // attached, so a matching-subject email without one doesn't block an
      // older one that does.
      const sorted = uids.slice().sort((a, b) => b - a);
      for (const uid of sorted) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source, { skipHtmlToText: true, skipImageLinks: true });
        const attachments = parsed.attachments || [];
        const csvAttachment = attachments.find(a =>
          /\.csv$/i.test(a.filename || '') || a.contentType === 'text/csv'
        );
        if (csvAttachment) {
          return {
            subject: parsed.subject || '(no subject)',
            date: parsed.date || null,
            filename: csvAttachment.filename || 'counts.csv',
            buffer: csvAttachment.content
          };
        }
      }
      return null;
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch (_e) { /* already disconnected */ }
  }
}

// ImapFlow throws a bare `Error('Command failed')` for any IMAP NO/BAD
// response (auth failure, a rejected SEARCH, etc.) — the actually useful
// detail (e.g. "[AUTHENTICATIONFAILED] Invalid credentials (Failure)") is
// on `err.responseText`, not `err.message`, so a caller that only reads
// `err.message` sees nothing but "Command failed" and has no way to tell a
// bad password apart from anything else. This pulls that detail out (and
// the response status: NO vs BAD) into one readable string for API
// responses / logs.
function describeImapError(err) {
  if (!err) return 'Unknown error';
  const parts = [err.message || String(err)];
  if (err.responseStatus) parts.push('(' + err.responseStatus + ')');
  if (err.responseText) parts.push('— ' + err.responseText);
  return parts.join(' ');
}

module.exports = { fetchLatestCountsEmail, describeImapError };
