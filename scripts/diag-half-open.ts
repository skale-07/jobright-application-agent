import fs from "node:fs";
import path from "node:path";
import { withFixtureHtmlPage } from "../src/browser/fixtureSession.js";
import {
  greenhouseVerifyFromPlan,
  type FieldMeta,
} from "../src/ats/greenhouse/fill.js";
import {
  detectControlKind,
  readComboboxValue,
} from "../src/ats/greenhouse/comboboxFill.js";

const fixtureHtml = fs.readFileSync(
  path.join(
    "tests/fixtures/ats/greenhouse-combobox/dom.sanitized.html",
  ),
  "utf8",
);

await withFixtureHtmlPage(fixtureHtml, async (page) => {
  const loc = page.locator("#work_auth");
  await loc.click();
  await loc.fill("Yes");
  console.log("inputValue", await loc.inputValue());
  console.log("kind", await detectControlKind(loc));
  console.log("read", await readComboboxValue(loc));
  const meta = new Map<string, FieldMeta>([
    ["work_auth", { type: "text", inputId: "work_auth" }],
  ]);
  const verify = await greenhouseVerifyFromPlan(
    page,
    [
      {
        field_id: "work_auth",
        label: "Are you legally authorized to work?",
        type: "text",
        canonical_field: "work_authorization",
        action: "FILL",
        approved: true,
        value: "Yes",
        reason: "t",
      },
    ],
    meta,
  );
  console.log(JSON.stringify(verify, null, 2));
});
