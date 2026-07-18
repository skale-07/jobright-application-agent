import type { Page } from "playwright";
import type { IframeInfo, VisibleLabel } from "./captureWriter.js";

/**
 * Browser-side extractors as function-expression strings.
 * Must be invoked: page.evaluate(`(${FN})()`) — otherwise Playwright returns
 * undefined (functions do not serialize across the bridge).
 */
const EXTRACT_LABELS_FN = `() => {
  const out = [];
  const nodes = Array.from(document.querySelectorAll(
    "a, button, [role='button'], input[type='submit'], input[type='button']"
  ));
  for (const el of nodes) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const text = (el.innerText || el.value || el.getAttribute("aria-label") || "")
      .replace(/\\s+/g, " ")
      .trim();
    if (!text) continue;
    const item = {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      text: text.slice(0, 200),
    };
    if (el.href) item.href = el.href;
    out.push(item);
    if (out.length >= 300) break;
  }
  return out;
}`;

const EXTRACT_IFRAMES_FN = `() => {
  return Array.from(document.querySelectorAll("iframe")).map((frame, index) => ({
    src: frame.getAttribute("src"),
    name: frame.getAttribute("name"),
    title: frame.getAttribute("title"),
    index,
  }));
}`;

const EXTRACT_ROLES_FN = `() => {
  const roles = Array.from(
    document.querySelectorAll("[role], h1, h2, h3, button, a, input, textarea, select")
  )
    .slice(0, 200)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      name: el.getAttribute("aria-label") || (el.innerText || "").slice(0, 80) || "",
    }));
  return JSON.stringify(roles, null, 2);
}`;

async function evaluateInvoked<T>(page: Page, fnExpr: string): Promise<T | undefined> {
  return page.evaluate(`(${fnExpr})()`) as Promise<T | undefined>;
}

export async function extractVisibleLabels(page: Page): Promise<VisibleLabel[]> {
  const result = await evaluateInvoked<VisibleLabel[]>(page, EXTRACT_LABELS_FN);
  return Array.isArray(result) ? result : [];
}

export async function extractIframes(page: Page): Promise<IframeInfo[]> {
  const result = await evaluateInvoked<IframeInfo[]>(page, EXTRACT_IFRAMES_FN);
  return Array.isArray(result) ? result : [];
}

export async function extractA11ySnapshot(page: Page): Promise<string> {
  try {
    const snap = await page.locator("body").ariaSnapshot();
    if (snap && snap.trim()) return snap;
  } catch {
    // fall through
  }

  try {
    const accessibility = (
      page as Page & {
        accessibility?: { snapshot: () => Promise<unknown> };
      }
    ).accessibility;
    if (accessibility?.snapshot) {
      const tree = await accessibility.snapshot();
      return JSON.stringify(tree, null, 2);
    }
  } catch {
    // fall through
  }

  const result = await evaluateInvoked<string>(page, EXTRACT_ROLES_FN);
  return typeof result === "string" ? result : "[]";
}

export async function capturePageState(page: Page): Promise<{
  url: string;
  title: string;
  domHtml: string;
  a11yText: string;
  labels: VisibleLabel[];
  iframes: IframeInfo[];
  screenshotPng: Buffer;
}> {
  const url = page.url();
  const title = await page.title();
  const domHtml = await page.content();
  const a11yText = await extractA11ySnapshot(page);
  const labels = await extractVisibleLabels(page);
  const iframes = await extractIframes(page);
  const screenshotPng = Buffer.from(
    await page.screenshot({ fullPage: true, type: "png" }),
  );
  return { url, title, domHtml, a11yText, labels, iframes, screenshotPng };
}
