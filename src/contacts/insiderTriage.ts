import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { detectAuthLossOnPage } from "../auth/authLossDetect.js";
import { getStoredJobInspectionTargetByApplicationId } from "../jobright/storedJobTarget.js";
import { upsertContact } from "./repository.js";
import {
  INSIDER_SELECTOR_REGISTRY_VERSION,
  insiderSelectorsV1,
  type ContactSourceCategory,
} from "./selectors.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";

/**
 * Insider Connection email triage (operator directive 2026-08-18).
 *
 * On a JobRight job page, the "Insider Connection" area recommends people.
 * The triage opens ONLY the "From Your School" and "Beyond Your Network"
 * panels (never "From Your Previous Company"), clicks each person's email
 * icon, and reads the outcome popup:
 *   - "Contact Info Found!"  → click "Connect Now", scrape the EMAIL
 *     ADDRESS ONLY from the "Connect Via Email" modal, then click Cancel.
 *   - "Contact Info Not Found!" → close and continue to the next person.
 * The deliverable is the deduped list of emails for the outreach step.
 *
 * Hard rules:
 *   - "Start Email" is NEVER clicked — the only controls this module ever
 *     clicks are panel expanders, email icons, "Connect Now", "Cancel",
 *     and popup close buttons. JobRight sending mail on the operator's
 *     behalf is exactly the class of action the drafts-only invariant
 *     exists to prevent.
 *   - ONLY the email address is scraped from the modal. The drafted
 *     subject/body JobRight pre-writes is never captured or persisted.
 *   - Jobs with no insider panels skip cleanly (skipped reason, no error).
 *   - Bounded: at most maxPeople lookups per run; every wait has a
 *     timeout; one pass, no retries per person.
 */

export type InsiderPersonOutcome = {
  category: ContactSourceCategory;
  index: number;
  outcome: "email_found" | "not_found" | "popup_timeout" | "modal_timeout";
};

export type InsiderTriageReport = {
  emails: string[];
  people_checked: number;
  found: number;
  not_found: number;
  skipped_reason: string | null;
  per_person: InsiderPersonOutcome[];
  notes: string[];
  registry: string;
};

const PANEL_ATTR = "data-dispatch-insider-panel";
const EMAIL_BTN_ATTR = "data-dispatch-insider-email";

/**
 * Tag the target panels and their per-person email-icon buttons with data
 * attributes so subsequent clicks are plain CSS lookups. Runs in the page:
 * live JobRight markup is UNVERIFIED, so classification leans on visible
 * copy (panel headings) and structure (icon-button pairs — the email icon
 * renders LEFT of the LinkedIn icon in every screenshot) rather than
 * class names.
 */
// Browser-side, shipped as a function-expression string (repo convention —
// tsconfig has no DOM lib). Invoked as (FN)(argsJson).
const TAG_PANELS_FN = `(args) => {
  const expandRe = new RegExp(args.expandSrc, "i");
  const results = [];
  for (const el of Array.from(
    document.querySelectorAll("[" + args.panelAttr + "], [" + args.emailBtnAttr + "]"),
  )) {
    el.removeAttribute(args.panelAttr);
    el.removeAttribute(args.emailBtnAttr);
  }
  const clickables = (root) =>
    Array.from(root.querySelectorAll('button, a, [role="button"]'));
  const hintOf = (el) =>
    ((el.getAttribute("aria-label") || "") + " " + (el.className || "") + " " + (el.title || "")).toLowerCase();
  for (const def of args.panelDefs) {
    const headingRe = new RegExp(def.headingSrc, "i");
    const matches = Array.from(document.querySelectorAll("*")).filter(
      (el) =>
        headingRe.test(el.textContent || "") &&
        (el.textContent || "").trim().length < 60,
    );
    const heading = matches[matches.length - 1];
    if (!heading) continue;
    const foreign = [/from your previous company/i].concat(
      args.panelDefs
        .filter((d) => d.category !== def.category)
        .map((d) => new RegExp(d.headingSrc, "i")),
    );
    let panel = null;
    let cursor = heading;
    for (let hops = 0; hops < 6 && cursor && cursor.parentElement; hops += 1) {
      const candidate = cursor.parentElement;
      const text = candidate.textContent || "";
      if (foreign.some((re) => re.test(text))) break;
      cursor = candidate;
      if (clickables(candidate).length > 0) panel = candidate;
    }
    if (!panel) continue;
    panel.setAttribute(args.panelAttr, def.category);
    const icons = clickables(panel).filter((el) => {
      const label = hintOf(el);
      const text = (el.textContent || "").trim();
      if (expandRe.test(text)) return false;
      if (/linkedin/.test(label)) return false;
      const iconish = el.querySelector("svg, img") !== null || text.length === 0;
      return /mail|email|envelope/.test(label) || (iconish && text.length <= 2);
    });
    const withHint = icons.filter((el) => /mail|email|envelope/.test(hintOf(el)));
    const chosen = withHint.length > 0 ? withHint : icons.filter((_, i) => i % 2 === 0);
    chosen.forEach((el, i) => {
      el.setAttribute(args.emailBtnAttr, def.category + ":" + i);
    });
    results.push({ category: def.category, buttons: chosen.length });
  }
  return results;
}`;

/**
 * Tag the target panels and their per-person email-icon buttons with data
 * attributes so subsequent clicks are plain CSS lookups. Classification
 * leans on visible copy (panel headings) and structure (icon-button pairs
 * — the email icon renders LEFT of the LinkedIn icon in every screenshot)
 * because live JobRight markup is UNVERIFIED.
 */
async function tagPanelsAndEmailButtons(
  page: Page,
): Promise<Array<{ category: string; buttons: number }>> {
  const args = {
    panelDefs: insiderSelectorsV1.panels.map((p) => ({
      category: p.category,
      headingSrc: p.heading.source,
    })),
    panelAttr: PANEL_ATTR,
    emailBtnAttr: EMAIL_BTN_ATTR,
    expandSrc: insiderSelectorsV1.expandButton.source,
  };
  return page.evaluate(
    `(${TAG_PANELS_FN})(${JSON.stringify(args)})`,
  ) as Promise<Array<{ category: string; buttons: number }>>;
}

/** Best-effort close of whichever popup/modal is on top. Never sends. */
async function closeTopLayer(page: Page): Promise<void> {
  const cancel = page
    .getByText(insiderSelectorsV1.cancelButton)
    .last();
  if ((await cancel.count().catch(() => 0)) > 0) {
    await cancel.click({ timeout: 1_500 }).catch(() => undefined);
    return;
  }
  const closeBtn = page
    .locator('[aria-label*="close" i], [class*="close" i]')
    .last();
  if ((await closeBtn.count().catch(() => 0)) > 0) {
    await closeBtn.click({ timeout: 1_500 }).catch(() => undefined);
    return;
  }
  await page.keyboard.press("Escape").catch(() => undefined);
}

/**
 * Scrape ONLY the email address out of the "Connect Via Email" modal:
 * every input value and the modal text run through the email pattern,
 * first plausible non-excluded hit wins. Subject and drafted body are
 * never returned.
 */
const SCRAPE_MODAL_FN = `(modalSrc) => {
  const modalRe = new RegExp(modalSrc, "i");
  const heading = Array.from(document.querySelectorAll("*")).find(
    (el) =>
      modalRe.test(el.textContent || "") &&
      (el.textContent || "").trim().length < 120,
  );
  let modal = heading || null;
  for (let hops = 0; hops < 6 && modal && modal.parentElement; hops += 1) {
    modal = modal.parentElement;
    if (modal.querySelectorAll("input, textarea, [contenteditable]").length > 0) break;
  }
  const root = modal || document.body;
  const values = Array.from(root.querySelectorAll("input, textarea")).map(
    (i) => i.value || "",
  );
  return values.concat([root.innerText || ""]);
}`;

async function scrapeModalEmail(
  page: Page,
  exclude: Set<string>,
): Promise<string | null> {
  const texts = (await page.evaluate(
    `(${SCRAPE_MODAL_FN})(${JSON.stringify(insiderSelectorsV1.emailModal.source)})`,
  )) as string[];
  for (const t of texts) {
    for (const m of t.matchAll(new RegExp(insiderSelectorsV1.emailPattern))) {
      const email = m[0].toLowerCase();
      if (!exclude.has(email)) return email;
    }
  }
  return null;
}

export async function triageInsiderEmails(
  page: Page,
  opts?: {
    maxPeople?: number;
    /** Operator-owned addresses that must never count as a contact. */
    excludeEmails?: string[];
    popupTimeoutMs?: number;
  },
): Promise<InsiderTriageReport> {
  const maxPeople = opts?.maxPeople ?? 12;
  const popupTimeout = opts?.popupTimeoutMs ?? 8_000;
  const exclude = new Set(
    (opts?.excludeEmails ?? []).map((e) => e.toLowerCase()),
  );
  const report: InsiderTriageReport = {
    emails: [],
    people_checked: 0,
    found: 0,
    not_found: 0,
    skipped_reason: null,
    per_person: [],
    notes: [],
    registry: INSIDER_SELECTOR_REGISTRY_VERSION,
  };

  // Pass 1: tag panel containers, then expand each panel with ITS OWN
  // expander — a global "View" click could hit the excluded
  // previous-company panel, so every click stays scoped to a tagged
  // container. An already-expanded panel simply has no expander.
  let panels = await tagPanelsAndEmailButtons(page);
  for (const p of panels) {
    const expander = page
      .locator(`[${PANEL_ATTR}="${p.category}"]`)
      .locator('button, a, [role="button"]')
      .filter({ hasText: insiderSelectorsV1.expandButton })
      .first();
    if ((await expander.count().catch(() => 0)) > 0) {
      await expander.click({ timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }
  // Pass 2: re-tag now that rows are visible.
  panels = await tagPanelsAndEmailButtons(page);
  if (panels.length === 0 || panels.every((p) => p.buttons === 0)) {
    report.skipped_reason =
      "no Insider Connection people in the school/beyond panels — triage skipped";
    return report;
  }
  report.notes.push(
    ...panels.map((p) => `${p.category}: ${p.buttons} people to check`),
  );

  for (const panel of panels) {
    for (let i = 0; i < panel.buttons; i += 1) {
      if (report.people_checked >= maxPeople) {
        report.notes.push(`stopped at the ${maxPeople}-person cap`);
        return report;
      }
      const btn = page.locator(
        `[${EMAIL_BTN_ATTR}="${panel.category}:${i}"]`,
      );
      if ((await btn.count().catch(() => 0)) === 0) continue;
      report.people_checked += 1;
      await btn.first().click({ timeout: 3_000 }).catch(() => undefined);

      const found = page.getByText(insiderSelectorsV1.foundPopup).first();
      const notFound = page
        .getByText(insiderSelectorsV1.notFoundPopup)
        .first();
      // Both branches carry their own catch so the race's loser can never
      // surface an unhandled rejection when its timeout fires later.
      const outcome = await Promise.race([
        found
          .waitFor({ state: "visible", timeout: popupTimeout })
          .then(() => "found" as const)
          .catch(() => "timeout" as const),
        notFound
          .waitFor({ state: "visible", timeout: popupTimeout })
          .then(() => "not_found" as const)
          .catch(() => "timeout" as const),
      ]);

      if (outcome === "timeout") {
        report.per_person.push({
          category: panel.category as ContactSourceCategory,
          index: i,
          outcome: "popup_timeout",
        });
        continue;
      }
      if (outcome === "not_found") {
        report.not_found += 1;
        report.per_person.push({
          category: panel.category as ContactSourceCategory,
          index: i,
          outcome: "not_found",
        });
        await closeTopLayer(page);
        continue;
      }

      // Found → Connect Now → modal → scrape email ONLY → Cancel.
      await page
        .getByText(insiderSelectorsV1.connectNow)
        .first()
        .click({ timeout: 3_000 })
        .catch(() => undefined);
      const modal = page.getByText(insiderSelectorsV1.emailModal).first();
      const modalUp = await modal
        .waitFor({ state: "visible", timeout: popupTimeout })
        .then(() => true)
        .catch(() => false);
      if (!modalUp) {
        report.per_person.push({
          category: panel.category as ContactSourceCategory,
          index: i,
          outcome: "modal_timeout",
        });
        await closeTopLayer(page);
        continue;
      }
      const email = await scrapeModalEmail(page, exclude);
      if (email && !report.emails.includes(email)) {
        report.emails.push(email);
      }
      report.found += email ? 1 : 0;
      report.per_person.push({
        category: panel.category as ContactSourceCategory,
        index: i,
        outcome: email ? "email_found" : "modal_timeout",
      });
      // Cancel closes the modal. Start Email is never a click target —
      // see insiderSelectorsV1.startEmailButton, kept only as a guard.
      await closeTopLayer(page);
      await page.waitForTimeout(250);
      await closeTopLayer(page);
    }
  }
  return report;
}

/** Redact for artifacts: first char + domain survive, rest masked. */
export function redactEmailForArtifact(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local[0]}***@${domain}`;
}

/**
 * Live orchestrator: navigate the operator's JobRight session to the
 * stored job page for an application, run the triage, persist each email
 * as a contact row (email + source category ONLY — nothing else is
 * scraped), and write a REDACTED artifact. Gated by
 * LINKEDIN_ENRICHMENT_ENABLED — each icon click spends a JobRight
 * contact-lookup credit on the operator's account.
 */
export async function runInsiderTriage(input: {
  db: Db;
  applicationId: string;
  headless?: boolean;
}): Promise<InsiderTriageReport> {
  const cfg = getConfig();
  if (!cfg.linkedinEnrichmentEnabled) {
    throw new Error(
      "LINKEDIN_ENRICHMENT_ENABLED is not enabled — insider triage spends JobRight contact-lookup credits",
    );
  }
  const target = getStoredJobInspectionTargetByApplicationId(
    input.db,
    input.applicationId,
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
  let report: InsiderTriageReport;
  try {
    const page = await session.newPage({ purpose: "insider_triage" });
    try {
      await page.goto(target.target.jobUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(2_000);
      if (await detectAuthLossOnPage(page, "jobright")) {
        throw new Error("AUTH_REQUIRED: JobRight session expired");
      }
      report = await triageInsiderEmails(page, {
        excludeEmails: [cfg.portalLoginEmail ?? ""].filter(Boolean),
      });
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await session.close();
  }

  for (const email of report.emails) {
    upsertContact(input.db, {
      applicationId: input.applicationId,
      email,
      sourceCategory: "email",
      context: { source: "insider_triage", registry: report.registry },
    });
  }

  const dir = path.join(cfg.artifactsDir, "contacts");
  fs.mkdirSync(dir, { recursive: true });
  const artifactPath = path.join(dir, `insider-triage-${Date.now()}.json`);
  writeJsonAtomic(artifactPath, {
    application_id: input.applicationId,
    people_checked: report.people_checked,
    found: report.found,
    not_found: report.not_found,
    skipped_reason: report.skipped_reason,
    // Third-party addresses never land in a pushed artifact un-redacted;
    // the full list lives in the contacts table (data/, never committed).
    emails_redacted: report.emails.map(redactEmailForArtifact),
    per_person: report.per_person,
    notes: report.notes,
    registry: report.registry,
  });
  logger.info("insider triage finished", {
    service: "contacts",
    action: "insider_triage",
    metadata: {
      application_id: input.applicationId,
      people_checked: report.people_checked,
      emails: report.emails.length,
      skipped: report.skipped_reason !== null,
    },
  });
  return report;
}
