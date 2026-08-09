import type { Locator, Page } from "playwright";

/**
 * Resume-upload resolution + commit detection shared by the Ashby/Lever
 * adapters, porting the patterns Greenhouse already proved live:
 *
 * - resolve with a short attached-wait (SPA upload zones mount late), an
 *   Escape first (an open combobox/menu can swallow the interaction), a
 *   keyword fallback over all file inputs, a lone-input fallback (bounded,
 *   logged), and ONE retry — "sometimes it doesn't upload" is usually a
 *   one-shot `count() === 0` against a not-yet-mounted input;
 * - verify accepting any of: the input's file list, a filename chip in the
 *   page text, or the input having unmounted after setInputFiles (dropzone
 *   UIs replace the input with a chip on success). Requiring the input to
 *   stay attached forever is how a successful upload reads as a failure.
 *
 * On a miss, every file input on the page is inventoried into the evidence
 * string so the fill/submit report shows what was actually there.
 */

export type FileInputInventoryEntry = {
  frame: string;
  id: string | null;
  name: string | null;
};

export async function inventoryFileInputs(
  page: Page,
): Promise<FileInputInventoryEntry[]> {
  const out: FileInputInventoryEntry[] = [];
  for (const frame of page.frames()) {
    const handles = frame.locator("input[type='file']");
    const n = await handles.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const h = handles.nth(i);
      out.push({
        frame: frame.url(),
        id: await h.getAttribute("id").catch(() => null),
        name: await h.getAttribute("name").catch(() => null),
      });
    }
  }
  return out;
}

export type ResolveFileInputResult =
  | { found: true; input: Locator; via: string; notes: string[] }
  | { found: false; notes: string[]; inventory: FileInputInventoryEntry[] };

async function tryResolveOnce(
  page: Page,
  opts: { css: string; keywordPattern: RegExp },
  notes: string[],
): Promise<{ input: Locator; via: string } | null> {
  // Primary: the ATS's own selector, with a short attached-wait for SPAs.
  const primary = page.locator(opts.css).first();
  try {
    await primary.waitFor({ state: "attached", timeout: 3_000 });
    return { input: primary, via: "primary" };
  } catch {
    notes.push("primary resume selector not attached within 3s");
  }

  // Keyword fallback: any file input whose name/id looks resume-ish.
  const all = page.locator("input[type='file']");
  const n = await all.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const candidate = all.nth(i);
    const id = (await candidate.getAttribute("id").catch(() => null)) ?? "";
    const name = (await candidate.getAttribute("name").catch(() => null)) ?? "";
    if (opts.keywordPattern.test(id) || opts.keywordPattern.test(name)) {
      notes.push(`resolved by keyword fallback (id="${id}", name="${name}")`);
      return { input: candidate, via: "keyword" };
    }
  }

  // Lone-input fallback: exactly one file input on the page — take it, loudly.
  if (n === 1) {
    const only = all.first();
    const id = (await only.getAttribute("id").catch(() => null)) ?? "";
    const name = (await only.getAttribute("name").catch(() => null)) ?? "";
    notes.push(
      `resolved as the only file input on the page (id="${id}", name="${name}")`,
    );
    return { input: only, via: "lone-input" };
  }
  return null;
}

export async function resolveResumeFileInput(
  page: Page,
  opts: {
    css: string;
    keywordPattern?: RegExp;
    /** Retry delay when the first pass misses (SPA mount race). 0 = no retry. */
    retryAfterMs?: number;
  },
): Promise<ResolveFileInputResult> {
  const notes: string[] = [];
  const keywordPattern = opts.keywordPattern ?? /resume|cv/i;

  // An open menu/combobox can hold focus and portal over the upload zone.
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(100);

  let hit = await tryResolveOnce(page, { css: opts.css, keywordPattern }, notes);
  if (!hit && (opts.retryAfterMs ?? 1_500) > 0) {
    notes.push(`retrying resolve after ${opts.retryAfterMs ?? 1_500}ms`);
    await page.waitForTimeout(opts.retryAfterMs ?? 1_500);
    hit = await tryResolveOnce(page, { css: opts.css, keywordPattern }, notes);
  }
  if (hit) return { found: true, input: hit.input, via: hit.via, notes };

  const inventory = await inventoryFileInputs(page).catch(
    () => [] as FileInputInventoryEntry[],
  );
  notes.push(`no resume file input; ${inventory.length} file inputs on page`);
  return { found: false, notes, inventory };
}

export type UploadCommitCheck = {
  verified: boolean;
  evidence: string;
};

/**
 * Did the upload commit? Any ONE of the signals is enough — mirroring the
 * Greenhouse job-boards behavior where success UNMOUNTS the input and
 * renders a filename chip. The input staying attached with an empty file
 * list and no chip is the only combination that reads as failure.
 */
export async function detectUploadCommit(
  page: Page,
  input: Locator,
  expected: { filename: string; sizeBytes: number },
): Promise<UploadCommitCheck> {
  // NOTE: locator.evaluate(fn, ARG, OPTIONS) — the timeout must be the
  // THIRD argument, or a detached input (dropzone unmounted it — the
  // success case!) blocks for the default 30s.
  let files: Array<{ name: string; size: number }> = [];
  try {
    files = await input.evaluate(
      (el: { files?: ArrayLike<{ name: string; size: number }> | null }) => {
        const list = el.files ? Array.from(el.files) : [];
        return list.map((f) => ({ name: f.name, size: f.size }));
      },
      undefined,
      { timeout: 2_000 },
    );
  } catch {
    files = [];
  }
  const inputFilesMatch =
    files.some((f) => f.name === expected.filename) ||
    files.some((f) => f.size === expected.sizeBytes);

  // Give dropzone UIs a beat to swap the input for a chip. count() is the
  // detachment probe — it resolves immediately for a removed element where
  // an evaluate would wait for it to reappear.
  await page.waitForTimeout(350);
  const stillAttached = (await input.count().catch(() => 0)) > 0;

  const stem = expected.filename.replace(/\.[^.]+$/, "");
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const chipVisible =
    bodyText.includes(expected.filename) ||
    (stem.length >= 12 && bodyText.includes(stem.slice(0, 24)));

  const verified =
    inputFilesMatch || chipVisible || (!stillAttached && files.length === 0);
  return {
    verified,
    evidence: `input files: ${JSON.stringify(files)}; stillAttached=${stillAttached}; chip=${chipVisible}`,
  };
}
