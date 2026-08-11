-- Messages sent from the "Send a message" form on the marketing page.
--
-- The row is written before the notification email is attempted, and is the
-- record of the message: `emailed` and `error` describe whether the visitor's
-- message also reached the field's inbox, not whether it was received. A
-- delivery failure therefore costs a notification, never the message itself --
-- see GET /api/admin/messages for the copy staff can read either way.
CREATE TABLE contact_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  email      TEXT    NOT NULL,          -- always stored lowercased, as in players
  message    TEXT    NOT NULL,
  ip         TEXT,                      -- CF-Connecting-IP, for the rate limit
  emailed    INTEGER NOT NULL DEFAULT 0 CHECK (emailed IN (0, 1)),
  error      TEXT,                      -- why the notification did not go out
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_contact_messages_created_at ON contact_messages (created_at DESC);

-- Backs the per-IP flood check in POST /api/contact.
CREATE INDEX idx_contact_messages_ip_created ON contact_messages (ip, created_at);
