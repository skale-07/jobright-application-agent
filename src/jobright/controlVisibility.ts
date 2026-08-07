import type { Page } from "playwright";
import { probeApplyLauncher } from "./applyLauncher.js";
import { extractJobIdFromUrl } from "./jobDetails.js";
import { probeCoverLetterUi, probeResumeUi } from "./materials.js";
import {
  JOBRIGHT_SELECTOR_REGISTRY_VERSION,
  jobrightSelectorsV1,
} from "./selectors/v1.js";

export type ControlProbeDetail = {
  visible: boolean;
  matched_selector_name: string;
  selector_status: "REGISTRY_V1" | "UNVERIFIED_SELECTOR";
  disabled: boolean | null;
  aria_disabled: boolean | null;
  match_count: number;
  visible_button_text: string | null;
};

/** Explicit apply-control visibility — no ambiguous combined "Apply visible". */
export type JobRightApplyControlVisibility = {
  any_apply_control_visible: boolean;
  standard_apply_visible: boolean;
  apply_with_autofill_visible: boolean;
  external_apply_visible: boolean;
};

export type JobRightControlVisibility = JobRightApplyControlVisibility & {
  improve_resume_visible: boolean;
  resume_generation_status_visible: boolean;
  resume_download_visible: boolean;
  copy_cover_letter_visible: boolean;
  cover_letter_editor_visible: boolean;
  login_wall_visible: boolean;
  captcha_visible: boolean;
  skill_tag_count: number;
  details: Record<string, ControlProbeDetail>;
  selector_registry_version: number;
};

async function roleButtonProbe(
  page: Page,
  name: RegExp,
  selectorName: string,
  selectorStatus: ControlProbeDetail["selector_status"] = "REGISTRY_V1",
): Promise<ControlProbeDetail> {
  const loc = page.getByRole("button", { name });
  const match_count = await loc.count().catch(() => 0);
  const first = loc.first();
  const visible = match_count > 0 && (await first.isVisible().catch(() => false));
  let disabled: boolean | null = null;
  let aria_disabled: boolean | null = null;
  let visible_button_text: string | null = null;
  if (visible) {
    disabled = await first.isDisabled().catch(() => null);
    const aria = await first.getAttribute("aria-disabled").catch(() => null);
    aria_disabled = aria === "true" ? true : aria === "false" ? false : null;
    visible_button_text =
      (await first.textContent().catch(() => null))?.trim().slice(0, 120) ??
      null;
  }
  return {
    visible,
    matched_selector_name: selectorName,
    selector_status: selectorStatus,
    disabled,
    aria_disabled,
    match_count,
    visible_button_text,
  };
}

/**
 * Read-only control visibility. Never clicks, fills, or focuses for mutation.
 */
export async function inspectJobRightControlVisibility(
  page: Page,
): Promise<JobRightControlVisibility> {
  const apply = await probeApplyLauncher(page);
  const resume = await probeResumeUi(page);
  const cover = await probeCoverLetterUi(page);

  const applyAutofill = await roleButtonProbe(
    page,
    jobrightSelectorsV1.jobDetail.applyWithAutofill.name,
    "jobDetail.applyWithAutofill",
  );
  const improve = await roleButtonProbe(
    page,
    jobrightSelectorsV1.jobDetail.improveResume.name,
    "jobDetail.improveResume",
  );
  const copyCover = await roleButtonProbe(
    page,
    jobrightSelectorsV1.jobDetail.copyCoverLetter.name,
    "jobDetail.copyCoverLetter",
  );

  // Standard Apply only — exact "Apply" label, not autofill
  const standardApply = await roleButtonProbe(
    page,
    /^apply$/i,
    "button[name=/^apply$/i]",
    "UNVERIFIED_SELECTOR",
  );

  const downloadLoc = page.getByRole("button", {
    name: /download.*resume|download pdf|save resume/i,
  });
  const downloadCount = await downloadLoc.count().catch(() => 0);
  const resume_download_visible =
    downloadCount > 0 &&
    (await downloadLoc.first().isVisible().catch(() => false));

  const editorVisible = cover.editorVisible;
  const skill_tag_count = resume.skillTagCount;
  const resume_generation_status_visible = skill_tag_count > 0;

  const atsLinkCount = await page
    .locator(jobrightSelectorsV1.navigation.externalAtsAnchors)
    .count()
    .catch(() => 0);
  const external_apply_visible = atsLinkCount > 0;

  const apply_with_autofill_visible =
    apply.applyVisible || applyAutofill.visible;
  const standard_apply_visible = standardApply.visible;
  const any_apply_control_visible =
    standard_apply_visible ||
    apply_with_autofill_visible ||
    external_apply_visible;

  const bodyText = (await page.locator("body").innerText().catch(() => ""))
    .slice(0, 4000)
    .toLowerCase();
  const login_wall_visible =
    /sign in|log in|session expired|please log in/.test(bodyText) &&
    bodyText.length < 2500;
  const captcha_visible = /captcha|i'?m not a robot|recaptcha|hcaptcha/.test(
    bodyText,
  );

  return {
    any_apply_control_visible,
    standard_apply_visible,
    apply_with_autofill_visible,
    external_apply_visible,
    improve_resume_visible: resume.improveResumeVisible || improve.visible,
    resume_generation_status_visible,
    resume_download_visible,
    copy_cover_letter_visible:
      cover.copyButtonVisible || copyCover.visible,
    cover_letter_editor_visible: editorVisible,
    login_wall_visible,
    captcha_visible,
    skill_tag_count,
    details: {
      apply_with_autofill: applyAutofill,
      improve_resume: improve,
      copy_cover_letter: copyCover,
      standard_apply: standardApply,
      resume_download: {
        visible: resume_download_visible,
        matched_selector_name: "button[name=/download.*resume/i]",
        selector_status: "UNVERIFIED_SELECTOR",
        disabled: null,
        aria_disabled: null,
        match_count: downloadCount,
        visible_button_text: null,
      },
      external_apply: {
        visible: external_apply_visible,
        matched_selector_name: "a[href*=greenhouse|lever|workday|ashby]",
        selector_status: "UNVERIFIED_SELECTOR",
        disabled: null,
        aria_disabled: null,
        match_count: atsLinkCount,
        visible_button_text: null,
      },
    },
    selector_registry_version: JOBRIGHT_SELECTOR_REGISTRY_VERSION,
  };
}

export async function readVisibleJobIdentity(page: Page): Promise<{
  finalUrl: string;
  parsedJobrightJobId: string | null;
  visibleCompany: string | null;
  visibleRole: string | null;
  pageTitle: string | null;
}> {
  const finalUrl = page.url();
  let parsedJobrightJobId = extractJobIdFromUrl(finalUrl);

  if (!parsedJobrightJobId) {
    const fromAttr = await page
      .locator("[data-jobright-job-id]")
      .first()
      .getAttribute("data-jobright-job-id")
      .catch(() => null);
    if (fromAttr) parsedJobrightJobId = fromAttr.trim();
  }

  const visibleRole =
    (
      await page
        .locator(jobrightSelectorsV1.feed.jobTitle)
        .first()
        .textContent()
        .catch(() => null)
    )?.trim() ?? null;
  const visibleCompany =
    (
      await page
        .locator(jobrightSelectorsV1.feed.companyName)
        .first()
        .textContent()
        .catch(() => null)
    )?.trim() ?? null;

  const pageTitle = (await page.title().catch(() => null))?.trim() ?? null;

  return {
    finalUrl,
    parsedJobrightJobId,
    visibleCompany,
    visibleRole,
    pageTitle,
  };
}
