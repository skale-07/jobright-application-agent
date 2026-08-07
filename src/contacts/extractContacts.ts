import fs from "node:fs";
import type { Db } from "../storage/db/client.js";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { detectAuthLossOnPage } from "../auth/authLossDetect.js";
import { logger } from "../logging/logger.js";
import { getApplication, transitionApplication } from "../queue/stateMachine.js";
import { getStoredJobInspectionTargetByApplicationId } from "../jobright/storedJobTarget.js";
import { contactsSelectorsV1, type ContactSourceCategory } from "./selectors.js";
import { upsertContact } from "./repository.js";

export type ExtractedContact = {
  name: string | null;
  title: string | null;
  company: string | null;
  jobright_contact_id: string | null;
  source_category: ContactSourceCategory;
};

export type ContactsReport = {
  application_id: string;
  extracted: number;
  created: number;
  reused: number;
  contacts: ExtractedContact[];
  source: "fixture" | "live";
  end_state: string;
  notes: string[];
};

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Pure HTML extraction of recommended contacts. Cards are classified by the
 * nearest preceding section heading (school / beyond / email).
 * Selector basis is SYNTHETIC — live JobRight markup is UNVERIFIED.
 */
export function extractContactsFromHtml(html: string): ExtractedContact[] {
  const sections: Array<{ index: number; category: ContactSourceCategory }> = [];
  for (const [category, re] of Object.entries(
    contactsSelectorsV1.sections,
  ) as Array<[ContactSourceCategory, RegExp]>) {
    const m = new RegExp(re.source, "gi");
    let hit: RegExpExecArray | null;
    while ((hit = m.exec(html)) !== null) {
      sections.push({ index: hit.index, category });
    }
  }
  sections.sort((a, b) => a.index - b.index);

  const categoryAt = (index: number): ContactSourceCategory => {
    let current: ContactSourceCategory = "unknown";
    for (const s of sections) {
      if (s.index <= index) current = s.category;
      else break;
    }
    return current;
  };

  const contacts: ExtractedContact[] = [];
  const cardRe =
    /<(div|li|article)\b[^>]*class="[^"]*contact-card[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;
  let card: RegExpExecArray | null;
  while ((card = cardRe.exec(html)) !== null) {
    const attrs = card[0].slice(0, card[0].indexOf(">") + 1);
    const body = card[2] ?? "";
    const idMatch = attrs.match(
      new RegExp(`${contactsSelectorsV1.contactIdAttr}="([^"]+)"`, "i"),
    );
    const nameMatch = body.match(
      /class="[^"]*contact-name[^"]*"[^>]*>([\s\S]*?)</i,
    );
    const titleMatch = body.match(
      /class="[^"]*contact-title[^"]*"[^>]*>([\s\S]*?)</i,
    );
    const companyMatch = body.match(
      /class="[^"]*contact-company[^"]*"[^>]*>([\s\S]*?)</i,
    );
    const name = nameMatch ? decodeHtml(stripTags(nameMatch[1] ?? "")) : null;
    if (!name) continue;
    contacts.push({
      name,
      title: titleMatch ? decodeHtml(stripTags(titleMatch[1] ?? "")) : null,
      company: companyMatch
        ? decodeHtml(stripTags(companyMatch[1] ?? ""))
        : null,
      jobright_contact_id: idMatch?.[1] ?? null,
      source_category: categoryAt(card.index),
    });
  }
  return contacts;
}

/**
 * Extract contacts for a SUBMITTED application (read-only navigation) and
 * persist them. Zero contacts is a valid outcome and completes the app.
 */
export async function runContactsExtraction(input: {
  db: Db;
  applicationId: string;
  fixtureHtmlPath?: string;
  headless?: boolean;
}): Promise<ContactsReport> {
  const { db, applicationId } = input;
  const app = getApplication(db, applicationId);
  if (!app) throw new Error(`Unknown application: ${applicationId}`);
  if (app.state !== "SUBMITTED" && app.state !== "CONTACTS_EXTRACTING") {
    throw new Error(
      `Contacts extraction requires SUBMITTED (got ${app.state})`,
    );
  }

  const notes: string[] = [];
  if (app.state === "SUBMITTED") {
    transitionApplication(db, {
      applicationId,
      nextState: "CONTACTS_EXTRACTING",
      reason: "contacts extraction started",
    });
  }

  let html: string;
  let source: "fixture" | "live";
  if (input.fixtureHtmlPath) {
    html = fs.readFileSync(input.fixtureHtmlPath, "utf8");
    source = "fixture";
  } else {
    source = "live";
    const target = getStoredJobInspectionTargetByApplicationId(
      db,
      applicationId,
    );
    if (!target.ok) {
      throw new Error(`Cannot resolve stored job: ${target.message}`);
    }
    const session = new PlaywrightServiceSession({
      service: "jobright",
      headless: input.headless ?? true,
      slowMoMs: 40,
    });
    await session.open();
    try {
      const page = await session.newPage({ purpose: "contacts_extract" });
      try {
        await page.goto(target.target.jobUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.waitForTimeout(2000);
        if (await detectAuthLossOnPage(page, "jobright")) {
          throw new Error("AUTH_REQUIRED: JobRight session expired");
        }
        html = await page.content();
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await session.close();
    }
  }

  const extracted = extractContactsFromHtml(html);
  let created = 0;
  let reused = 0;
  for (const c of extracted) {
    const result = upsertContact(db, {
      applicationId,
      name: c.name,
      title: c.title,
      company: c.company,
      sourceCategory: c.source_category,
      jobrightContactId: c.jobright_contact_id,
      context: { source, registry: "contacts-v1" },
    });
    if (result.created) created++;
    else reused++;
  }

  const endState = extracted.length > 0 ? "CONTACTS_EXTRACTED" : "COMPLETED";
  if (extracted.length === 0) {
    notes.push("zero contacts found — completing application");
  }
  transitionApplication(db, {
    applicationId,
    nextState: endState as "CONTACTS_EXTRACTED" | "COMPLETED",
    reason:
      extracted.length > 0
        ? `contacts extracted: ${extracted.length}`
        : "no contacts available",
  });

  logger.info("contacts extraction complete", {
    service: "jobright",
    action: "contacts_extract",
    metadata: { application_id: applicationId, extracted: extracted.length, source },
  });

  return {
    application_id: applicationId,
    extracted: extracted.length,
    created,
    reused,
    contacts: extracted,
    source,
    end_state: endState,
    notes,
  };
}
