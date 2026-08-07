import type { Db } from "../storage/db/client.js";
import { upsertJobByFingerprint } from "../jobs/repository.js";
import { getOrCreateApplicationForJob } from "../jobs/applicationDedupe.js";
import {
  transitionApplication,
  type ApplicationRow,
} from "../queue/stateMachine.js";
import { JOBRIGHT_SELECTOR_REGISTRY_VERSION } from "./selectors/v1.js";
import {
  buildJobRightDetailUrlFromId,
  isValidJobrightJobId,
  validateJobRightInspectionUrl,
} from "./jobInspectionUrl.js";
import { extractJobIdFromUrl } from "./jobDetails.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";

/**
 * Manual enqueue of JobRight jobs by detail URL or bare hex job id.
 * Does not scrape the live feed: operator-supplied refs become jobs +
 * applications in SQLite so inspect / materials:register / submit work.
 */

export type ParsedJobRightRef =
  | { ok: true; jobright_job_id: string; job_url: string; input: string }
  | { ok: false; input: string; reason: string };

export type EnqueueJobItemResult = {
  input: string;
  ok: boolean;
  jobright_job_id: string | null;
  job_url: string | null;
  job_db_id: string | null;
  application_id: string | null;
  state: string | null;
  dedupe_kind: string | null;
  error: string | null;
};

export type EnqueueJobsReport = {
  enqueued: number;
  reused: number;
  blocked: number;
  failed: number;
  applications: EnqueueJobItemResult[];
};

/**
 * Accept:
 * - bare JobRight hex id (`6a76229767a1ad0bc53c8e9f`)
 * - full detail URL (`https://jobright.ai/jobs/info/<id>`)
 * - URL with ignored query/hash
 */
export function parseJobRightRef(raw: string): ParsedJobRightRef {
  const input = raw.trim();
  if (!input) {
    return { ok: false, input, reason: "Empty job reference" };
  }

  // Bare id (not a URL)
  if (!input.includes("://") && !input.includes("/")) {
    const built = buildJobRightDetailUrlFromId(input);
    if (!built.ok) {
      return { ok: false, input, reason: built.reason };
    }
    return {
      ok: true,
      jobright_job_id: built.jobrightJobId,
      job_url: built.url,
      input,
    };
  }

  // Full / partial URL
  let href = input;
  if (!/^https?:\/\//i.test(href) && href.includes("jobright.ai")) {
    href = `https://${href.replace(/^\/+/, "")}`;
  }

  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { ok: false, input, reason: `Malformed URL: ${input}` };
  }

  const idFromPath = extractJobIdFromUrl(u.href);
  if (!idFromPath || !isValidJobrightJobId(idFromPath)) {
    return {
      ok: false,
      input,
      reason:
        "Not a JobRight job detail link or id (expect /jobs/info/<hex> or bare hex id)",
    };
  }

  const validated = validateJobRightInspectionUrl(u.href, idFromPath);
  if (!validated.ok) {
    return { ok: false, input, reason: validated.reason };
  }

  return {
    ok: true,
    jobright_job_id: validated.jobrightJobId,
    job_url: validated.url,
    input,
  };
}

/** Expand CLI/file tokens: trim, drop blanks/comments, optional comma-split. */
export function expandJobRightRefs(tokens: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    for (const part of token.split(/[,\n\r]+/)) {
      const t = part.trim();
      if (!t || t.startsWith("#")) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

function advanceNewApplicationToQueued(db: Db, app: ApplicationRow): ApplicationRow {
  // Manual operator choice → skip feed eligibility filters; walk legal edges only.
  transitionApplication(db, {
    applicationId: app.id,
    nextState: "DUPLICATE_CHECK",
    reason: "manual enqueue: dedupe pass",
  });
  transitionApplication(db, {
    applicationId: app.id,
    nextState: "ELIGIBILITY_CHECK",
    reason: "manual enqueue: operator-selected job",
  });
  return transitionApplication(db, {
    applicationId: app.id,
    nextState: "QUEUED",
    reason: "manual enqueue: ready for materials/pipeline",
  });
}

/**
 * Upsert job row + get-or-create application for one parsed JobRight ref.
 * Title/company are placeholders until inspect / pipeline enrich them;
 * jobright_job_id is the stable identity for dedupe.
 */
export function enqueueOneJobRightJob(
  db: Db,
  parsed: Extract<ParsedJobRightRef, { ok: true }>,
  options: {
    company?: string;
    role?: string;
    /** Stored on job.raw_json for pipeline submit (not the JobRight URL). */
    employerApplicationUrl?: string;
  } = {},
): EnqueueJobItemResult {
  const company =
    options.company?.trim() || "Unknown company (manual enqueue)";
  const role = options.role?.trim() || "Unknown role (manual enqueue)";
  const jobPath = new URL(parsed.job_url).pathname;

  // Validate the employer URL at ingestion — previously stored verbatim and
  // only rejected much later by the pipeline's URL gate.
  let employerUrl: string | undefined;
  let employerAts: string | undefined;
  if (options.employerApplicationUrl) {
    const detected = detectAtsFromUrl(options.employerApplicationUrl);
    if (detected.ats === null) {
      return {
        input: parsed.jobright_job_id,
        ok: false,
        jobright_job_id: parsed.jobright_job_id,
        job_url: parsed.job_url,
        job_db_id: null,
        application_id: null,
        state: null,
        dedupe_kind: null,
        error: `employer URL rejected: ${detected.failureReason}`,
      };
    }
    employerUrl = detected.normalizedUrl;
    employerAts = detected.ats;
  }

  const raw: Record<string, unknown> = {
    source: "manual_enqueue",
    jobright_job_id: parsed.jobright_job_id,
    job_url: parsed.job_url,
    job_path: jobPath,
    enqueued_at: new Date().toISOString(),
  };
  if (employerUrl) {
    raw["employer_application_url"] = employerUrl;
    raw["employer_application_ats"] = employerAts;
  }

  const job = upsertJobByFingerprint(db, {
    jobrightJobId: parsed.jobright_job_id,
    applicationUrl: parsed.job_url,
    company,
    role,
    sourceAts: "jobright",
    raw,
  });

  // If row already had richer company/role, don't overwrite with placeholders
  // in a follow-up path — upsert already merged. Re-merge employer URL into raw.
  if (employerUrl) {
    try {
      const existingRaw = db
        .prepare(`SELECT raw_json FROM jobs WHERE id = ?`)
        .get(job.id) as { raw_json: string };
      const prev = JSON.parse(existingRaw.raw_json) as Record<string, unknown>;
      prev["employer_application_url"] = employerUrl;
      prev["employer_application_ats"] = employerAts;
      prev["job_url"] = prev["job_url"] ?? parsed.job_url;
      prev["job_path"] = prev["job_path"] ?? jobPath;
      prev["jobright_job_id"] = parsed.jobright_job_id;
      db.prepare(`UPDATE jobs SET raw_json = ?, updated_at = ? WHERE id = ?`).run(
        JSON.stringify(prev),
        new Date().toISOString(),
        job.id,
      );
    } catch {
      // non-fatal
    }
  }

  const dedupe = getOrCreateApplicationForJob(db, {
    jobId: job.id,
    versions: {
      selector_registry_version: JOBRIGHT_SELECTOR_REGISTRY_VERSION,
      adapter: "jobright",
      adapter_version: 1,
      manual_enqueue: true,
    },
  });

  if (
    dedupe.kind === "ALREADY_VERIFIED_SUBMITTED" ||
    dedupe.kind === "UNCERTAIN_SUBMISSION"
  ) {
    return {
      input: parsed.input,
      ok: false,
      jobright_job_id: parsed.jobright_job_id,
      job_url: parsed.job_url,
      job_db_id: job.id,
      application_id: dedupe.applicationId,
      state: dedupe.application.state,
      dedupe_kind: dedupe.kind,
      error: `Blocked: ${dedupe.kind}`,
    };
  }

  let app = dedupe.application;
  if (dedupe.kind === "CREATED") {
    app = advanceNewApplicationToQueued(db, app);
  }

  return {
    input: parsed.input,
    ok: true,
    jobright_job_id: parsed.jobright_job_id,
    job_url: parsed.job_url,
    job_db_id: job.id,
    application_id: app.id,
    state: app.state,
    dedupe_kind: dedupe.kind,
    error: null,
  };
}

/**
 * Enqueue many JobRight refs (ids or detail URLs). Order preserved.
 * Dedupes identical refs in the input list up front.
 */
export function enqueueJobRightJobs(
  db: Db,
  refs: string[],
  options: {
    company?: string;
    role?: string;
    /** Applied to every row (only sensible when enqueuing a single job). */
    employerApplicationUrl?: string;
  } = {},
): EnqueueJobsReport {
  const expanded = expandJobRightRefs(refs);
  const applications: EnqueueJobItemResult[] = [];
  let enqueued = 0;
  let reused = 0;
  let blocked = 0;
  let failed = 0;

  for (const ref of expanded) {
    const parsed = parseJobRightRef(ref);
    if (!parsed.ok) {
      failed += 1;
      applications.push({
        input: parsed.input,
        ok: false,
        jobright_job_id: null,
        job_url: null,
        job_db_id: null,
        application_id: null,
        state: null,
        dedupe_kind: null,
        error: parsed.reason,
      });
      continue;
    }

    const item = enqueueOneJobRightJob(db, parsed, options);
    applications.push(item);
    if (!item.ok) {
      if (item.dedupe_kind?.includes("SUBMIT")) blocked += 1;
      else failed += 1;
      continue;
    }
    if (item.dedupe_kind === "CREATED") enqueued += 1;
    else reused += 1;
  }

  return { enqueued, reused, blocked, failed, applications };
}
