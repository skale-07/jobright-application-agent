-- Gmail drafts tail (operator directive 2026-08-18): each VALIDATED
-- email_generations row can become ONE Gmail draft per recipient. Same
-- shape and idempotency contract as outlook_drafts; the body itself is
-- never stored here (metadata_json carries a body sha like Outlook's).
CREATE TABLE IF NOT EXISTS gmail_drafts (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  recipient_email TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(application_id, recipient_email)
);
