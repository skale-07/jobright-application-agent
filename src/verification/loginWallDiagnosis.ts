import type { Page } from "playwright";

/**
 * Structured, human-readable diagnosis of an employer login wall
 * (operator request 2026-08-12: "add more detailed logging/detection so
 * you and I can break down what's really happening when it hits a login
 * wall"). Zero mutation — this only reads the page.
 *
 * The value is the SHAPE: which inputs exist, which submit control, what
 * federated buttons are offered, whether a create-account route is
 * present, and whether the page is reporting an error. Every live wall we
 * park on writes one of these into the nav report, so the next fix is
 * driven by the actual DOM instead of a guess.
 *
 * Selectors here are intentionally generic (type/name/autocomplete +
 * accessible names), because this runs on ANY employer portal — Amazon,
 * ByteDance, Workday tenants — not one known vendor.
 */

export type LoginWallDiagnosis = {
  url: string;
  host: string;
  /** Inputs the page exposes, by role. */
  fields: {
    email: boolean;
    password: boolean;
    confirmPassword: boolean;
    otherVisibleInputs: number;
  };
  /** Accessible names of the submit-ish controls, in DOM order (capped). */
  submitControls: string[];
  /** "Login with Google/Apple/LinkedIn/Amazon" style buttons. */
  federatedProviders: string[];
  /** A visible route to account creation ("Create an Amazon.jobs account"). */
  createAccountRoute: string | null;
  /** Page text that reads like a rejected credential / needs-verification. */
  errorText: string | null;
  /** What the flow should do next, derived from the above. */
  classification:
    | "sign_in_form"
    | "create_account_form"
    | "federated_only"
    | "credentials_rejected"
    | "no_form_found";
};

const FEDERATED_RE =
  /(sign|log)\s?in with|continue with|login with|use your .{0,40}account/i;
const CREATE_ROUTE_RE =
  /create an? .{0,40}account|create account|sign up|new to /i;
const ERROR_RE =
  /incorrect|invalid|doesn'?t match|does not match|no account|can'?t find|couldn'?t find|not recognized|try again|must be verified|verify your email|wrong password/i;

export async function diagnoseLoginWall(page: Page): Promise<LoginWallDiagnosis> {
  const url = page.url();
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }

  const visible = async (selector: string): Promise<boolean> => {
    const loc = page.locator(selector).first();
    return (
      (await loc.count().catch(() => 0)) > 0 &&
      (await loc.isVisible().catch(() => false))
    );
  };

  const email = await visible(
    "input[type='email'], input[name*='email' i], input[id*='email' i], input[autocomplete='username'], input[name*='user' i]",
  );
  const passwordLocs = page.locator("input[type='password']");
  const passwordCount = await passwordLocs.count().catch(() => 0);
  const confirmPassword = passwordCount > 1;

  const otherVisibleInputs = await page
    .locator("input:not([type='hidden'])")
    .count()
    .catch(() => 0);

  const names = async (role: "button" | "link"): Promise<string[]> => {
    const out: string[] = [];
    const all = await page.getByRole(role).all().catch(() => []);
    for (const el of all.slice(0, 40)) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const text = ((await el.textContent().catch(() => null)) ?? "").trim();
      const aria = ((await el.getAttribute("aria-label").catch(() => null)) ?? "").trim();
      const name = (text || aria).replace(/\s+/g, " ").slice(0, 60);
      if (name) out.push(name);
    }
    return out;
  };
  const buttonNames = await names("button");
  const linkNames = await names("link");
  const allNames = [...buttonNames, ...linkNames];

  const submitControls = buttonNames
    .filter((n) => /sign in|log ?in|continue|submit|next|create account/i.test(n))
    .slice(0, 6);
  const federatedProviders = allNames
    .filter((n) => FEDERATED_RE.test(n))
    .slice(0, 6);
  const createAccountRoute =
    allNames.find((n) => CREATE_ROUTE_RE.test(n) && !FEDERATED_RE.test(n)) ?? null;

  const bodyText = await page
    .innerText("body", { timeout: 3_000 })
    .then((t) => t.slice(0, 3_000))
    .catch(() => "");
  const errorMatch = bodyText.match(ERROR_RE);
  const errorText = errorMatch
    ? bodyText
        .slice(Math.max(0, (errorMatch.index ?? 0) - 60), (errorMatch.index ?? 0) + 120)
        .replace(/\s+/g, " ")
        .trim()
    : null;

  const hasPassword = passwordCount > 0;
  const classification: LoginWallDiagnosis["classification"] = errorText
    ? "credentials_rejected"
    : confirmPassword
      ? "create_account_form"
      : email && hasPassword
        ? "sign_in_form"
        : federatedProviders.length > 0
          ? "federated_only"
          : "no_form_found";

  return {
    url,
    host,
    fields: { email, password: hasPassword, confirmPassword, otherVisibleInputs },
    submitControls,
    federatedProviders,
    createAccountRoute,
    errorText,
    classification,
  };
}

/** One-line human summary for logs and nav-report notes. */
export function summarizeLoginWall(d: LoginWallDiagnosis): string {
  const bits = [
    `login wall on ${d.host}: ${d.classification}`,
    `fields[email=${d.fields.email} password=${d.fields.password} confirm=${d.fields.confirmPassword}]`,
  ];
  if (d.submitControls.length > 0) {
    bits.push(`submit=[${d.submitControls.join(" | ")}]`);
  }
  if (d.federatedProviders.length > 0) {
    bits.push(`federated=[${d.federatedProviders.join(" | ")}]`);
  }
  if (d.createAccountRoute) bits.push(`create-route="${d.createAccountRoute}"`);
  if (d.errorText) bits.push(`error="${d.errorText.slice(0, 120)}"`);
  return bits.join("; ");
}
