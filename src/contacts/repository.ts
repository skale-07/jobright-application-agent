import { randomUUID } from "node:crypto";
import type { Db } from "../storage/db/client.js";
import type { ContactSourceCategory } from "./selectors.js";

export type ContactRow = {
  id: string;
  application_id: string;
  name: string | null;
  title: string | null;
  company: string | null;
  email: string | null;
  linkedin_url: string | null;
  source_category: string | null;
  jobright_contact_id: string | null;
  jobright_context_json: string;
  created_at: string;
};

/**
 * Upsert honoring the two partial unique indexes:
 * (application_id, email) and (application_id, jobright_contact_id).
 */
export function upsertContact(
  db: Db,
  input: {
    applicationId: string;
    name?: string | null;
    title?: string | null;
    company?: string | null;
    email?: string | null;
    linkedinUrl?: string | null;
    sourceCategory: ContactSourceCategory;
    jobrightContactId?: string | null;
    context?: Record<string, unknown>;
  },
): { id: string; created: boolean } {
  const existing = db
    .prepare(
      `SELECT id FROM contacts
       WHERE application_id = ?
         AND (
           (jobright_contact_id IS NOT NULL AND jobright_contact_id = ?)
           OR (email IS NOT NULL AND email = ?)
         )
       LIMIT 1`,
    )
    .get(
      input.applicationId,
      input.jobrightContactId ?? null,
      input.email ?? null,
    ) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE contacts SET
        name = COALESCE(?, name),
        title = COALESCE(?, title),
        company = COALESCE(?, company),
        source_category = COALESCE(?, source_category),
        jobright_context_json = ?
       WHERE id = ?`,
    ).run(
      input.name ?? null,
      input.title ?? null,
      input.company ?? null,
      input.sourceCategory,
      JSON.stringify(input.context ?? {}),
      existing.id,
    );
    return { id: existing.id, created: false };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO contacts (
      id, application_id, name, title, company, email, linkedin_url,
      source_category, jobright_contact_id, jobright_context_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.applicationId,
    input.name ?? null,
    input.title ?? null,
    input.company ?? null,
    input.email ?? null,
    input.linkedinUrl ?? null,
    input.sourceCategory,
    input.jobrightContactId ?? null,
    JSON.stringify(input.context ?? {}),
    new Date().toISOString(),
  );
  return { id, created: true };
}

export function listContacts(db: Db, applicationId: string): ContactRow[] {
  return db
    .prepare(
      `SELECT * FROM contacts WHERE application_id = ? ORDER BY created_at`,
    )
    .all(applicationId) as ContactRow[];
}

export function getContact(db: Db, contactId: string): ContactRow | undefined {
  return db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(contactId) as
    | ContactRow
    | undefined;
}
