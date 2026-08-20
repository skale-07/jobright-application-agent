import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { getConfig } from "../../config/index.js";
import { scrubHtmlForSnapshot } from "../../applications/htmlScrub.js";
import { classifyValue, valueFingerprint } from "../../storage/fillOutcomes.js";
import { writeJsonAtomic } from "../../storage/atomicJson.js";
import { EXT_SELECTOR_REGISTRY_VERSION } from "./selectors.js";

/**
 * Headed extension-capture session (X1 of the extension-first
 * architecture; sandbox-first — the OPERATOR activates the extension by
 * hand, this module only observes). Two snapshots around the manual
 * activation produce:
 *   - before.html / after.html — value-scrubbed page snapshots
 *   - diff.json — per-field value-CLASS transitions (never raw values),
 *     plus DOM deltas (new element ids, new custom-element tags, new
 *     open shadow hosts, new frames)
 *   - selector-candidates.json — jobright-marked elements seen BEFORE
 *     activation (autofill-trigger candidates) and the post-activation
 *     deltas (panel/progress candidates), for the operator/agent to
 *     promote into src/jobright/extension/selectors.ts
 * Raw field values cross the CDP boundary into this process but are
 * reduced to classifyValue/valueFingerprint immediately; nothing raw is
 * persisted (telemetry PII rule).
 */

export type ExtCaptureFieldState = {
  field_id: string;
  field_type: string;
  value_class: string;
  fingerprint: string | null;
};

export type ExtCapturePageState = {
  fields: ExtCaptureFieldState[];
  shadow_hosts: string[];
  custom_tags: string[];
  element_ids: string[];
  frame_urls: string[];
  jobright_marked: string[];
};

export type ExtCaptureDiff = {
  field_changes: Array<{
    field_id: string;
    before_class: string;
    after_class: string;
    changed: boolean;
  }>;
  filled_count: number;
  new_element_ids: string[];
  new_custom_tags: string[];
  new_shadow_hosts: string[];
  new_frame_urls: string[];
};

export type ExtCaptureReport = {
  url: string;
  out_dir: string;
  registry: string;
  before_fields: number;
  diff: ExtCaptureDiff;
  trigger_candidates: string[];
  notes: string[];
};

// Browser-side collector, shipped as a function-expression string (repo
// convention — tsconfig has no DOM lib). Returns raw values; Node reduces
// them to classes/fingerprints before anything is persisted.
const COLLECT_FN = `() => {
  const fields = [];
  for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) {
    const id = el.id || el.getAttribute("name") || el.getAttribute("data-automation-id") || "";
    if (!id) continue;
    let value = "";
    if (el.tagName === "SELECT") {
      value = (el.selectedOptions && el.selectedOptions[0] && el.selectedOptions[0].textContent) || "";
    } else if (el.type === "checkbox" || el.type === "radio") {
      value = el.checked ? "checked" : "";
    } else {
      value = el.value || "";
    }
    fields.push({ id, type: (el.type || el.tagName).toLowerCase(), value });
  }
  const shadowHosts = [];
  const customTags = new Set();
  const jobrightMarked = [];
  for (const el of Array.from(document.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (tag.includes("-")) customTags.add(tag);
    if (el.shadowRoot) {
      shadowHosts.push(tag + (el.id ? "#" + el.id : ""));
    }
    const hint = (el.id || "") + " " + (typeof el.className === "string" ? el.className : "");
    if (/jobright/i.test(hint)) {
      jobrightMarked.push(
        tag + (el.id ? "#" + el.id : "") +
        (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : ""),
      );
    }
  }
  const ids = Array.from(document.querySelectorAll("[id]")).slice(0, 800).map((el) => el.id);
  return {
    fields: fields.slice(0, 300),
    shadowHosts: shadowHosts.slice(0, 100),
    customTags: Array.from(customTags).slice(0, 100),
    ids,
    jobrightMarked: jobrightMarked.slice(0, 50),
  };
}`;

export async function collectPageState(page: Page): Promise<ExtCapturePageState> {
  const raw = (await page.evaluate(`(${COLLECT_FN})()`)) as {
    fields: Array<{ id: string; type: string; value: string }>;
    shadowHosts: string[];
    customTags: string[];
    ids: string[];
    jobrightMarked: string[];
  };
  return {
    fields: raw.fields.map((f) => ({
      field_id: f.id,
      field_type: f.type,
      value_class: classifyValue(f.value, null),
      fingerprint: valueFingerprint(f.value, null),
    })),
    shadow_hosts: raw.shadowHosts,
    custom_tags: raw.customTags,
    element_ids: raw.ids,
    frame_urls: page.frames().map((f) => f.url()),
    jobright_marked: raw.jobrightMarked,
  };
}

export function diffPageStates(
  before: ExtCapturePageState,
  after: ExtCapturePageState,
): ExtCaptureDiff {
  const beforeById = new Map(before.fields.map((f) => [f.field_id, f]));
  const field_changes = after.fields.map((f) => {
    const prev = beforeById.get(f.field_id);
    const before_class = prev?.value_class ?? "absent";
    const changed =
      before_class !== f.value_class ||
      (prev?.fingerprint ?? null) !== f.fingerprint;
    return {
      field_id: f.field_id,
      before_class,
      after_class: f.value_class,
      changed,
    };
  });
  const newOf = (a: string[], b: string[]) => {
    const seen = new Set(a);
    return b.filter((x) => !seen.has(x));
  };
  return {
    field_changes,
    filled_count: field_changes.filter(
      (c) => c.changed && c.before_class === "empty" && c.after_class !== "empty",
    ).length,
    new_element_ids: newOf(before.element_ids, after.element_ids).slice(0, 100),
    new_custom_tags: newOf(before.custom_tags, after.custom_tags),
    new_shadow_hosts: newOf(before.shadow_hosts, after.shadow_hosts),
    new_frame_urls: newOf(before.frame_urls, after.frame_urls),
  };
}

/**
 * Run one capture around an operator-performed activation.
 * `waitForOperator` is the seam the CLI fills with an Enter-key prompt
 * and tests fill with a synthetic mutation.
 */
export async function captureExtensionSession(input: {
  page: Page;
  url: string;
  waitForOperator: () => Promise<void>;
  outDirOverride?: string;
}): Promise<ExtCaptureReport> {
  const cfg = getConfig();
  const outDir =
    input.outDirOverride ??
    path.join(cfg.artifactsDir, "ext-capture", String(Date.now()));
  fs.mkdirSync(outDir, { recursive: true });

  const beforeHtml = await input.page.content();
  const before = await collectPageState(input.page);
  fs.writeFileSync(
    path.join(outDir, "before.html"),
    scrubHtmlForSnapshot(beforeHtml),
    "utf8",
  );

  await input.waitForOperator();

  const afterHtml = await input.page.content();
  const after = await collectPageState(input.page);
  fs.writeFileSync(
    path.join(outDir, "after.html"),
    scrubHtmlForSnapshot(afterHtml),
    "utf8",
  );

  const diff = diffPageStates(before, after);
  const report: ExtCaptureReport = {
    url: input.url,
    out_dir: outDir,
    registry: EXT_SELECTOR_REGISTRY_VERSION,
    before_fields: before.fields.length,
    diff,
    // Trigger candidates come from BEFORE activation — the control the
    // operator clicked existed on the pre-activation page.
    trigger_candidates: before.jobright_marked,
    notes: [],
  };
  if (diff.filled_count === 0) {
    report.notes.push(
      "no field went empty→filled across the activation — either the extension filled nothing or its writes live in a frame this capture cannot see",
    );
  }
  if (
    before.jobright_marked.length === 0 &&
    diff.new_frame_urls.every((u) => !u.startsWith("chrome-extension://"))
  ) {
    report.notes.push(
      "no jobright-marked DOM and no chrome-extension frame observed — the panel may render in a closed shadow root or browser side panel; activation automation would need the extension-frame fallback",
    );
  }

  writeJsonAtomic(path.join(outDir, "diff.json"), {
    url: input.url,
    registry: report.registry,
    diff,
    notes: report.notes,
  });
  writeJsonAtomic(path.join(outDir, "selector-candidates.json"), {
    registry: report.registry,
    autofill_trigger_candidates: report.trigger_candidates,
    panel_candidates: {
      new_element_ids: diff.new_element_ids,
      new_custom_tags: diff.new_custom_tags,
      new_shadow_hosts: diff.new_shadow_hosts,
      new_frame_urls: diff.new_frame_urls,
    },
    promote_to: "src/jobright/extension/selectors.ts",
  });
  return report;
}
