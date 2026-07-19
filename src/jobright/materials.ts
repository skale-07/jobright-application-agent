import type { Page } from "playwright";
import { jobrightSelectorsV1 } from "./selectors/v1.js";

export type CoverLetterUiState =
  | "NOT_REQUESTED"
  | "OPTIONAL"
  | "REQUIRED"
  | "GENERATED"
  | "DOWNLOADED"
  | "FAILED";

export type CoverLetterPolicy = {
  generate_when_required: boolean;
  generate_when_optional: boolean;
};

export function detectCoverLetterState(input: {
  copyButtonVisible: boolean;
  editorVisible: boolean;
  requiredByPolicy?: boolean;
}): CoverLetterUiState {
  if (input.copyButtonVisible || input.editorVisible) return "GENERATED";
  if (input.requiredByPolicy) return "REQUIRED";
  return "NOT_REQUESTED";
}

export async function probeCoverLetterUi(page: Page): Promise<{
  copyButtonVisible: boolean;
  editorVisible: boolean;
  state: CoverLetterUiState;
}> {
  const copyButtonVisible = await page
    .getByRole(jobrightSelectorsV1.jobDetail.copyCoverLetter.role, {
      name: jobrightSelectorsV1.jobDetail.copyCoverLetter.name,
    })
    .first()
    .isVisible()
    .catch(() => false);

  const editorVisible = await page
    .locator(jobrightSelectorsV1.jobDetail.coverLetterEditor)
    .first()
    .isVisible()
    .catch(() => false);

  return {
    copyButtonVisible,
    editorVisible,
    state: detectCoverLetterState({ copyButtonVisible, editorVisible }),
  };
}

export async function probeResumeUi(page: Page): Promise<{
  improveResumeVisible: boolean;
  skillTagCount: number;
}> {
  const improveResumeVisible = await page
    .getByRole(jobrightSelectorsV1.jobDetail.improveResume.role, {
      name: jobrightSelectorsV1.jobDetail.improveResume.name,
    })
    .first()
    .isVisible()
    .catch(() => false);

  const skillTagCount = await page
    .locator(jobrightSelectorsV1.jobDetail.skillTag)
    .count()
    .catch(() => 0);

  return { improveResumeVisible, skillTagCount };
}

/**
 * Best-effort: click Improve My Resume.
 * Prefer downloadAndVerifyResume for full download → verify → persist.
 */
export async function clickImproveResume(page: Page): Promise<{ clicked: boolean }> {
  const btn = page.getByRole(jobrightSelectorsV1.jobDetail.improveResume.role, {
    name: jobrightSelectorsV1.jobDetail.improveResume.name,
  });
  if (!(await btn.first().isVisible().catch(() => false))) {
    return { clicked: false };
  }
  await btn.first().click();
  return { clicked: true };
}

export {
  downloadAndVerifyResume,
  resumeIdempotencyKey,
  saveVerifiedResume,
  verifyResumePdfBuffer,
  verifyResumePdfFile,
  MIN_RESUME_PDF_BYTES,
  type ResumeDownloadOptions,
  type ResumeDownloadResult,
} from "./resumeDownload.js";
