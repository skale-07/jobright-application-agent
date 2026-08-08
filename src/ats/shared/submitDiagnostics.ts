import type { Page } from "playwright";

/**
 * Pre-click diagnostics for a disabled submit control. The old behavior —
 * refusing with only "submit control disabled" — was correct but opaque:
 * an in-form email-verification step (Greenhouse "enter the code we
 * emailed you") passes the login-wall gate, passes plan verification
 * (the code input is not in the approved plan), and surfaces only as a
 * greyed-out button. This module names the cause: verification-code
 * inputs, required-but-invalid fields, and visible validation errors.
 * Read-only — it never types or clicks.
 */

export type DisabledSubmitDiagnosis = {
  verification: {
    detected: boolean;
    /** Selector that resolves the code input for the recovery layer. */
    input_selector: string | null;
    prompt_excerpt: string | null;
    /** Mailbox the page claims it mailed, when stated. */
    email_hint: string | null;
  };
  required_invalid: Array<{ label: string; name: string; type: string }>;
  visible_errors: string[];
  summary: string;
};

const CODE_INPUT_SELECTOR = [
  'input[autocomplete="one-time-code"]',
  'input[name*="verification" i]',
  'input[id*="verification" i]',
  'input[name*="security_code" i]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[placeholder*="code" i]',
  'input[aria-label*="code" i]',
].join(", ");

const VERIFICATION_TEXT =
  /(verification code|enter (?:the|your) code|sent (?:a|the|you a) (?:verification )?code|code (?:was |has been )?sent|security code|one[- ]time (?:code|passcode)|check your (?:email|inbox) for)/i;

const EMAIL_HINT =
  /(?:sent|emailed|mailed)[^.\n]{0,60}?to\s+([\w.+-]+@[\w-]+\.[\w.-]+)|([\w.+-]+@[\w-]+\.[\w.-]+)[^.\n]{0,40}?(?:for (?:a|the) (?:verification )?code)/i;

export async function diagnoseDisabledSubmit(
  page: Page,
): Promise<DisabledSubmitDiagnosis> {
  const scan = await page
    .evaluate(
      // Runs in the browser; DOM globals are typed locally (the repo's
      // tsconfig lib is ES2022-only, so no ambient DOM types here).
      ({ codeSelector }) => {
        type El = {
          getBoundingClientRect(): { width: number; height: number };
          getAttribute(name: string): string | null;
          textContent: string | null;
          tagName: string;
          id: string;
          name?: string;
          type?: string;
          checkValidity?: () => boolean;
        };
        const doc = (
          globalThis as unknown as {
            document: {
              querySelector(s: string): El | null;
              querySelectorAll(s: string): ArrayLike<El>;
              body?: { innerText?: string };
            };
          }
        ).document;
        const all = (s: string): El[] => Array.from(doc.querySelectorAll(s));
        const visible = (el: El): boolean => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const labelFor = (el: El): string => {
          if (el.id) {
            const label = doc.querySelector(
              `label[for="${el.id.replace(/"/g, '\\"')}"]`,
            );
            if (label?.textContent) return label.textContent.trim().slice(0, 120);
          }
          return (
            el.getAttribute("aria-label") ??
            el.getAttribute("placeholder") ??
            el.name ??
            el.id ??
            "?"
          ).slice(0, 120);
        };

        const codeInputs = all(codeSelector)
          .filter(visible)
          .map((el) => ({
            id: el.id || null,
            name: el.name || null,
            autocomplete: el.getAttribute("autocomplete"),
          }));

        const requiredInvalid = all(
          "input[required], select[required], textarea[required]",
        )
          .filter(visible)
          .filter((el) => {
            if (el.getAttribute("aria-invalid") === "true") return true;
            try {
              return el.checkValidity ? !el.checkValidity() : false;
            } catch {
              return false;
            }
          })
          .slice(0, 15)
          .map((el) => ({
            label: labelFor(el),
            name: el.name || el.id || "?",
            type: el.type || el.tagName.toLowerCase(),
          }));

        const errorNodes = all(
          '[role="alert"], .error, .field-error, .validation-error, [class*="error-message" i]',
        )
          .filter(visible)
          .map((el) => (el.textContent ?? "").trim())
          .filter((t) => t.length > 0 && t.length < 300)
          .slice(0, 10);

        return {
          codeInputs,
          requiredInvalid,
          errorNodes,
          bodyText: (doc.body?.innerText ?? "").slice(0, 20000),
        };
      },
      { codeSelector: CODE_INPUT_SELECTOR },
    )
    .catch(() => ({
      codeInputs: [] as Array<{ id: string | null; name: string | null; autocomplete: string | null }>,
      requiredInvalid: [] as Array<{ label: string; name: string; type: string }>,
      errorNodes: [] as string[],
      bodyText: "",
    }));

  const textMatch = scan.bodyText.match(VERIFICATION_TEXT);
  const first = scan.codeInputs[0];
  // A code input plus verification wording is high confidence; wording
  // alone (input not yet matched) still gets named in the summary.
  const detected = Boolean(first) && Boolean(textMatch);
  let inputSelector: string | null = null;
  if (first) {
    if (first.id) inputSelector = `#${first.id.replace(/([^\w-])/g, "\\$1")}`;
    else if (first.name) inputSelector = `input[name="${first.name}"]`;
    else if (first.autocomplete === "one-time-code") {
      inputSelector = 'input[autocomplete="one-time-code"]';
    }
  }
  const emailMatch = scan.bodyText.match(EMAIL_HINT);
  // Sentence-final addresses come back with the period attached.
  const emailHint =
    (emailMatch?.[1] ?? emailMatch?.[2])?.replace(/[.,;:]+$/, "") ?? null;

  const parts: string[] = [];
  if (detected) {
    parts.push(
      `email verification code required${emailHint ? ` (sent to ${emailHint})` : ""}`,
    );
  } else if (textMatch) {
    parts.push(`verification wording present ("${textMatch[0]}") but no code input matched`);
  }
  if (scan.requiredInvalid.length > 0) {
    parts.push(
      `${scan.requiredInvalid.length} required field(s) invalid: ${scan.requiredInvalid
        .map((f) => f.label)
        .slice(0, 5)
        .join(", ")}`,
    );
  }
  if (scan.errorNodes.length > 0) {
    parts.push(`visible errors: ${scan.errorNodes.slice(0, 3).join(" | ")}`);
  }
  if (parts.length === 0) {
    parts.push("no verification prompt, invalid required fields, or visible errors found");
  }

  return {
    verification: {
      detected,
      input_selector: detected ? inputSelector : null,
      prompt_excerpt: textMatch?.[0] ?? null,
      email_hint: emailHint,
    },
    required_invalid: scan.requiredInvalid,
    visible_errors: scan.errorNodes,
    summary: parts.join("; "),
  };
}
