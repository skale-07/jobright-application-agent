import type { Page } from "playwright";
import { jobrightSelectorsV1 } from "./selectors/v1.js";

export type ApplyLaunchProbe = {
  applyVisible: boolean;
  askOrionVisible: boolean;
};

/**
 * Phase 3: detect Apply with Autofill only. Do not open employer ATS yet.
 */
export async function probeApplyLauncher(page: Page): Promise<ApplyLaunchProbe> {
  const applyVisible = await page
    .getByRole(jobrightSelectorsV1.jobDetail.applyWithAutofill.role, {
      name: jobrightSelectorsV1.jobDetail.applyWithAutofill.name,
    })
    .first()
    .isVisible()
    .catch(() => false);

  const askOrionVisible = await page
    .getByRole("button", { name: jobrightSelectorsV1.feed.askOrionRole })
    .first()
    .isVisible()
    .catch(() => false);

  return { applyVisible, askOrionVisible };
}
