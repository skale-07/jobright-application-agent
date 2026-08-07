/**
 * One-shot diagnostic: live Greenhouse job-boards form control shapes.
 * Usage: npx tsx scripts/diag-gh-controls.ts [url]
 *
 * Note: page.evaluate bodies must stay free of TS toolchain helpers —
 * use string-serialized pure JS only.
 */
import { chromium } from "playwright";

const url =
  process.argv[2] ??
  "https://job-boards.greenhouse.io/simplifyjobsintegrationsandbox/jobs/4344358003";

const DUMP_FN = `() => {
  const snap = (el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      id: el.id || null,
      name: el.getAttribute("name"),
      type: el.getAttribute("type"),
      role: el.getAttribute("role"),
      ariaLabel: el.getAttribute("aria-label"),
      ariaHaspopup: el.getAttribute("aria-haspopup"),
      ariaAutocomplete: el.getAttribute("aria-autocomplete"),
      ariaExpanded: el.getAttribute("aria-expanded"),
      ariaControls: el.getAttribute("aria-controls"),
      className: String(el.className || "").slice(0, 140),
      placeholder: el.getAttribute("placeholder"),
      text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 100),
      visible: r.width > 0 && r.height > 0,
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };

  const combos = [
    ...document.querySelectorAll(
      '[role=combobox], [aria-haspopup=listbox], [class*="select__control"], [class*="select-control"], [class*="react-select"]',
    ),
  ].map(snap);

  const selects = [...document.querySelectorAll("select")].map((el) => ({
    ...snap(el),
    options: [...el.options].slice(0, 15).map((o) => (o.textContent || "").trim()),
  }));

  const files = [...document.querySelectorAll('input[type="file"]')].map((el) => ({
    ...snap(el),
    accept: el.getAttribute("accept"),
    parentClasses: el.parentElement
      ? String(el.parentElement.className).slice(0, 120)
      : "",
    parentHtml: el.parentElement
      ? el.parentElement.innerHTML.slice(0, 400)
      : "",
  }));

  const inputs = [...document.querySelectorAll("input:not([type=hidden])")]
    .filter((el) => el.getAttribute("type") !== "file")
    .slice(0, 50)
    .map(snap);

  const selectish = [
    ...document.querySelectorAll(
      "button, [role=button], input, div[class*='select'], span[class*='select']",
    ),
  ]
    .filter((el) => {
      const t =
        (el.getAttribute("placeholder") || "") + " " + (el.textContent || "");
      const r = el.getBoundingClientRect();
      return /select|country|degree|education/i.test(t) && r.width > 40;
    })
    .slice(0, 30)
    .map((el) => ({ ...snap(el), outer: el.outerHTML.slice(0, 280) }));

  // label -> nearby control map for key fields
  const labelMap = [];
  for (const lab of document.querySelectorAll("label")) {
    const text = (lab.textContent || "").replace(/\\s+/g, " ").trim();
    if (!/country|phone|school|degree|discipline|resume|cover|linkedin|authorized|gender|start|end/i.test(text))
      continue;
    const forId = lab.getAttribute("for");
    let target = forId ? document.getElementById(forId) : null;
    if (!target) {
      target = lab.querySelector("input, select, button, [role=combobox]") ||
        lab.parentElement?.querySelector("input, select, button, [role=combobox]");
    }
    labelMap.push({
      label: text.slice(0, 80),
      forId,
      control: target ? snap(target) : null,
      parentHtml: (lab.parentElement?.innerHTML || "").slice(0, 350),
    });
  }

  return {
    title: document.title,
    combos,
    selects,
    files,
    inputs,
    selectish,
    labelMap,
  };
}`;

const OPEN_STATE_FN = `() => {
  const listboxes = [...document.querySelectorAll('[role="listbox"], [class*="menu"], ul')]
    .slice(0, 15)
    .map((el) => ({
      role: el.getAttribute("role"),
      className: String(el.className).slice(0, 100),
      childCount: el.children.length,
      text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200),
      outer: el.outerHTML.slice(0, 350),
    }));
  const options = [...document.querySelectorAll('[role="option"], li, [class*="option"]')]
    .slice(0, 25)
    .map((el) => ({
      role: el.getAttribute("role"),
      class: String(el.className).slice(0, 80),
      text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80),
    }));
  return { listboxes, options };
}`;

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4_000);

  // String form is an expression; IIFE so Playwright serializes the return value.
  const data = await page.evaluate(`(${DUMP_FN})()`);
  console.log(JSON.stringify(data, null, 2));

  // Open first visible combobox / Select trigger
  const triggers = [
    page.locator('[role="combobox"]').first(),
    page.getByText("Select...", { exact: false }).first(),
    page.locator("select").first(),
  ];
  for (const t of triggers) {
    if ((await t.count().catch(() => 0)) === 0) continue;
    try {
      await t.click({ timeout: 4_000 });
      await page.waitForTimeout(800);
      console.log("\n--- after open click ---\n");
      console.log(
        JSON.stringify(await page.evaluate(`(${OPEN_STATE_FN})()`), null, 2),
      );
      await page.keyboard.press("Escape");
      break;
    } catch {
      // try next
    }
  }

  // Also try label-driven Country open
  try {
    const country = page.getByLabel(/country/i).first();
    if ((await country.count()) > 0) {
      await country.click({ timeout: 3_000 });
      await page.waitForTimeout(600);
      console.log("\n--- after Country label click ---\n");
      console.log(
        JSON.stringify(await page.evaluate(`(${OPEN_STATE_FN})()`), null, 2),
      );
    }
  } catch (e) {
    console.log("country open failed", String(e));
  }

  console.log(
    "\nfile inputs:",
    await page.locator('input[type="file"]').count(),
  );

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
