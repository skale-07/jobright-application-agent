import { withPublicUrlPage } from "../src/browser/fixtureSession.js";

async function main(): Promise<void> {
  await withPublicUrlPage(
    "https://job-boards.greenhouse.io/simplifyjobsintegrationsandbox/jobs/4344358003",
    async (page) => {
    await page.waitForTimeout(4000);
    const files = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = globalThis as any;
      return [...g.document.querySelectorAll("input[type=file]")].map(
        (el: {
          id: string;
          className: string;
          getAttribute: (n: string) => string | null;
          parentElement?: { innerHTML?: string } | null;
          closest: (s: string) => { textContent?: string | null } | null;
        }) => {
          const style = g.getComputedStyle(el);
          return {
            id: el.id,
            name: el.getAttribute("name"),
            accept: el.getAttribute("accept"),
            className: el.className,
            aria: el.getAttribute("aria-label"),
            dataTestId: el.getAttribute("data-testid"),
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            parentSnippet: el.parentElement?.innerHTML?.slice(0, 200) ?? "",
            nearbyText:
              el.closest("div,label,section,fieldset")?.textContent?.slice(
                0,
                160,
              ) ?? "",
          };
        },
      );
    });
    console.log(JSON.stringify({ count: files.length, files }, null, 2));
    },
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
