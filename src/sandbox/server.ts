import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The employer sandbox — a fake company's careers site running on the
 * operator's OWN machine, for watching Dispatch work with their real
 * presets (operator directive 2026-08-15: "this was meant to be a frontend
 * generated so i can test it out myself. also craft something for
 * email/password navigation sandbox as well").
 *
 * Two flows, each an end-to-end obstacle course for a specific capability:
 *
 *   /gauntlet — the weird-questions application. Every screener question
 *   is deliberately outside the deterministic registry, so anything that
 *   fills proves the PREDICTIVE tiers with the operator's real LLM key,
 *   profile and flags — not a mock. Includes a native select with "Other",
 *   a React-select-style combobox whose options exist only after opening
 *   (exercises the harvest), an "Other reveals a specify box" behavior,
 *   and a submit that lands on a real confirmation page so the whole
 *   fill → verify → submit → verify-submission loop can run locally.
 *
 *   /portal — the email/password navigation sandbox. A job POSTING page
 *   (Apply button + search chrome, no identity fields — exercises the
 *   posting classifier and the Apply advance), behind it an account wall
 *   (Create Account / Sign In with email + password — exercises
 *   portalAuth with PORTAL_LOGIN_EMAIL/PASSWORD), and only then the
 *   application form. Accounts are held in memory; restarting the server
 *   wipes them, which is exactly what makes re-testing account CREATION
 *   trivial.
 *
 * Everything the "employer" receives is echoed to the console and written
 * under artifacts/sandbox/, so the operator can diff what the system
 * claimed it filled against what actually arrived.
 *
 * Plain Node http, zero dependencies, loopback only. This server binds
 * 127.0.0.1 and never anything else — it is a test rig, not a service.
 */

export type SandboxOptions = {
  port?: number;
  /** Where received submissions are written (default artifacts/sandbox). */
  outDir?: string;
  quiet?: boolean;
};

export type SandboxHandle = {
  port: number;
  url: string;
  close: () => Promise<void>;
  /** Accounts created through /portal this session (emails only). */
  accountEmails: () => string[];
};

type Account = { email: string; password: string };

const PAGE_CSS = `
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #17202a; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; }
  label { display: block; margin: 1rem 0 0.25rem; font-weight: 600; }
  input, select, textarea { width: 100%; padding: 0.5rem; font-size: 1rem; box-sizing: border-box; }
  button { margin-top: 1.25rem; padding: 0.6rem 1.4rem; font-size: 1rem; cursor: pointer; }
  .error { color: #b00020; font-weight: 600; }
  .muted { color: #667; font-size: 0.9rem; }
  .req::after { content: " *"; color: #b00020; }
  .combo { position: relative; }
  .combo-list { border: 1px solid #aab; max-height: 180px; overflow: auto; position: absolute; background: #fff; width: 100%; z-index: 5; }
  .combo-list [role=option] { padding: 0.4rem 0.6rem; cursor: pointer; }
  .combo-list [role=option]:hover { background: #eef; }
`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>${PAGE_CSS}</style></head><body>${body}</body></html>`;
}

/**
 * The weird-questions application. NOTHING here matches a screener
 * pattern, an answer alias, or a profile rule — by construction, a filled
 * answer came from the predictive tiers.
 */
function gauntletPage(): string {
  return page(
    "Frobnicator Industries — Apply",
    `
  <h1>Frobnicator Industries — Software Frobnicator, Intern</h1>
  <p class="muted">The weird-questions gauntlet: the deterministic system cannot answer these.</p>
  <form method="POST" action="/gauntlet/submit" enctype="multipart/form-data">
    <label class="req" for="first_name">First Name</label>
    <input id="first_name" name="first_name" required />
    <label class="req" for="last_name">Last Name</label>
    <input id="last_name" name="last_name" required />
    <label class="req" for="email">Email</label>
    <input id="email" name="email" type="email" required />
    <label for="resume">Resume</label>
    <input id="resume" name="resume" type="file" />

    <h2>Screeners no registry has seen</h2>

    <label class="req" for="q_appliance">If you were a kitchen appliance, which would you be?</label>
    <select id="q_appliance" name="q_appliance" required>
      <option value="">Select...</option>
      <option>Toaster</option><option>Blender</option><option>Rice cooker</option><option>Other</option>
    </select>

    <label class="req" for="q_cobol">Have you ever maintained a COBOL system in production?</label>
    <select id="q_cobol" name="q_cobol" required>
      <option value="">Select...</option><option>Yes</option><option>No</option>
    </select>

    <label class="req" for="q_uni">Which university do you attend? Select "Other" if not listed.</label>
    <select id="q_uni" name="q_uni" required>
      <option value="">Select...</option>
      <option>Miskatonic University</option><option>Unseen University</option><option>Other</option>
    </select>
    <div id="q_uni_specify_wrap" style="display:none">
      <label for="q_uni_specify">If other, please specify your university</label>
      <input id="q_uni_specify" name="q_uni_specify" />
    </div>

    <label class="req" for="q_tz">Which time zone will you primarily frobnicate from?</label>
    <div class="combo">
      <input id="q_tz" name="q_tz" role="combobox" aria-autocomplete="list" autocomplete="off" placeholder="Select..." />
      <div id="q_tz_list" class="combo-list" style="display:none" role="listbox"></div>
    </div>
    <p class="muted">This one renders its options only after the control opens — like a real board.</p>

    <label for="q_spirit">Describe your debugging spirit animal in one word.</label>
    <input id="q_spirit" name="q_spirit" />

    <h2>From the wild</h2>
    <p class="muted">Questions real boards asked in the operator's own runs
    (Appian, Neuralink, TransMarket, Abridge, Notion artifacts) — the exact
    shapes that parked or mis-filled live. Both classes: CLOSED (the answer
    must be one of the options) and OPEN (type anything).</p>

    <label class="req" for="w_orgs">Are you currently a member of any university organizations, such as clubs or fraternities/sororities?</label>
    <select id="w_orgs" name="w_orgs" required>
      <option value="">Select...</option><option>Yes</option><option>No</option>
    </select>

    <label class="req" for="w_major">Are you currently pursuing a Major in one of the following disciplines: Computer Science, Computer Engineering?</label>
    <select id="w_major" name="w_major" required>
      <option value="">Select...</option><option>Yes</option><option>No</option>
    </select>

    <label class="req" for="w_leadership">Have you ever held, or do you currently hold, any leadership roles through work, school clubs, or organizations?</label>
    <select id="w_leadership" name="w_leadership" required>
      <option value="">Select...</option><option>Yes</option><option>No</option>
    </select>

    <label class="req" for="w_gpa">What is your current cumulative GPA on a 4.0 scale?</label>
    <select id="w_gpa" name="w_gpa" required>
      <option value="">Select...</option>
      <option>3.7 or Higher</option><option>3.5 - 3.6</option><option>3.0 - 3.4</option>
      <option>2.5 - 2.9</option><option>2.4 or Below</option>
    </select>

    <label class="req" for="w_grad">Please select your expected graduation month and year for your current studies.</label>
    <select id="w_grad" name="w_grad" required>
      <option value="">Select...</option>
      <option>Prior to December 2025</option><option>Spring 2026</option><option>Fall 2026</option>
      <option>Spring 2027</option><option>Fall 2027</option><option>Spring 2028</option>
    </select>

    <label class="req" for="w_season">Please choose the season that most accurately reflects your availability.</label>
    <select id="w_season" name="w_season" required>
      <option value="">Select...</option>
      <option>Summer 2026</option><option>Fall 2026</option><option>Spring 2027</option>
    </select>

    <label class="req" for="w_hometown">Our employees are from all parts of the world. We love to know where our applicants are from too. Where is your hometown?</label>
    <input id="w_hometown" name="w_hometown" required />

    <label for="w_about">Tell us something about yourself that we can't find on your resume.</label>
    <textarea id="w_about" name="w_about" rows="3"></textarea>

    <label class="req" for="w_start">Ideal start date in office</label>
    <input id="w_start" name="w_start" required />

    <label for="w_ai">What are some AI specific technologies you are comfortable with?</label>
    <input id="w_ai" name="w_ai" />

    <button type="submit">Submit application</button>
  </form>
  <script>
    // Other → reveal the specify box (the cascade under test).
    document.getElementById('q_uni').addEventListener('change', (e) => {
      document.getElementById('q_uni_specify_wrap').style.display =
        e.target.value === 'Other' ? 'block' : 'none';
    });
    // A React-select-style combobox: options exist ONLY after opening.
    const TZ = ['Eastern (US)', 'Central (US)', 'Mountain (US)', 'Pacific (US)'];
    const tz = document.getElementById('q_tz');
    const list = document.getElementById('q_tz_list');
    const renderList = (filter) => {
      const items = TZ.filter((t) => !filter || t.toLowerCase().includes(filter.toLowerCase()));
      list.innerHTML = items.length
        ? items.map((t) => '<div role="option">' + t + '</div>').join('')
        : '<div role="option">No options</div>';
      list.style.display = 'block';
    };
    tz.addEventListener('focus', () => renderList(''));
    tz.addEventListener('click', () => renderList(tz.value));
    tz.addEventListener('input', () => renderList(tz.value));
    list.addEventListener('click', (e) => {
      const t = e.target.closest('[role=option]');
      if (t && t.textContent !== 'No options') { tz.value = t.textContent; list.style.display = 'none'; }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') list.style.display = 'none'; });
    document.addEventListener('click', (e) => { if (!e.target.closest('.combo')) list.style.display = 'none'; });
  </script>`,
  );
}

/** The /portal POSTING: Apply button + search chrome, zero identity fields. */
function portalPostingPage(): string {
  return page(
    "Frobnicator Careers — AI Engineer Intern",
    `
  <h1>AI Engineer Intern</h1>
  <p>Strongsville, OH — Frobnicator Industries L.E.A.D Internship Program.</p>
  <input placeholder="Search by job title, ID, or keyword" />
  <input placeholder="City, state, or country/region" />
  <p class="muted">Search chrome above is page furniture — the classifier must not call this a form.</p>
  <a href="/portal/auth"><button type="button">Apply</button></a>`,
  );
}

/** Email/password wall: Create Account or Sign In. */
function portalAuthPage(error?: string): string {
  return page(
    "Getting You Started",
    `
  <h1>Getting You Started</h1>
  <p>Save your application and track your status with an account.</p>
  ${error ? `<p class="error">${error}</p>` : ""}
  <h2>Create Account</h2>
  <form method="POST" action="/portal/create-account">
    <label class="req" for="email">Email Address</label>
    <input id="email" name="email" type="email" required />
    <label class="req" for="password">Create Password</label>
    <input id="password" name="password" type="password" required />
    <label class="req" for="verifyPassword">Confirm Password</label>
    <input id="verifyPassword" name="verifyPassword" type="password" required />
    <button type="submit">Create Account</button>
  </form>
  <h2>Sign In</h2>
  <form method="POST" action="/portal/sign-in">
    <label class="req" for="si_email">Email Address</label>
    <input id="si_email" name="email" type="email" required />
    <label class="req" for="si_password">Password</label>
    <input id="si_password" name="password" type="password" required />
    <button type="submit">Sign In</button>
  </form>`,
  );
}

/** The application form behind the wall. */
function portalFormPage(email: string): string {
  return page(
    "Frobnicator Careers — Application",
    `
  <h1>Application — AI Engineer Intern</h1>
  <p class="muted">Signed in as ${email}</p>
  <form method="POST" action="/portal/submit">
    <label class="req" for="first_name">First Name</label>
    <input id="first_name" name="first_name" required />
    <label class="req" for="last_name">Last Name</label>
    <input id="last_name" name="last_name" required />
    <label class="req" for="phone">Phone</label>
    <input id="phone" name="phone" required />
    <label class="req" for="q_relocate">Are you able to work on-site in Strongsville, OH?</label>
    <select id="q_relocate" name="q_relocate" required>
      <option value="">Select...</option><option>Yes</option><option>No</option>
    </select>
    <button type="submit">Submit application</button>
  </form>`,
  );
}

function confirmationPage(): string {
  return page(
    "Application received",
    `<h1>Thank you for applying!</h1>
     <p>Your application has been received. Our frobnication team will be in touch.</p>`,
  );
}

/** Tiny multipart/urlencoded body reader — enough for the sandbox forms. */
async function readBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const type = req.headers["content-type"] ?? "";
  const out: Record<string, string> = {};
  if (type.includes("application/x-www-form-urlencoded")) {
    for (const [k, v] of new URLSearchParams(raw.toString("utf8"))) out[k] = v;
    return out;
  }
  if (type.includes("multipart/form-data")) {
    const boundary = type.split("boundary=")[1];
    if (!boundary) return out;
    for (const part of raw.toString("latin1").split(`--${boundary}`)) {
      const nameMatch = part.match(/name="([^"]+)"/);
      if (!nameMatch?.[1]) continue;
      const fileMatch = part.match(/filename="([^"]*)"/);
      const bodyStart = part.indexOf("\r\n\r\n");
      if (bodyStart < 0) continue;
      const value = part.slice(bodyStart + 4).replace(/\r\n$/, "");
      out[nameMatch[1]] = fileMatch
        ? `<file: ${fileMatch[1] || "(none)"}, ${value.length} bytes>`
        : Buffer.from(value, "latin1").toString("utf8").trim();
    }
  }
  return out;
}

export function startEmployerSandbox(
  options: SandboxOptions = {},
): Promise<SandboxHandle> {
  const accounts = new Map<string, Account>();
  const sessions = new Map<string, string>(); // sid → email
  const outDir = options.outDir ?? path.join(process.cwd(), "artifacts", "sandbox");
  const log = (msg: string): void => {
    if (!options.quiet) console.log(`[sandbox] ${msg}`);
  };

  const record = (kind: string, data: Record<string, string>): void => {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, `${kind}-${Date.now()}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({ kind, received_at: new Date().toISOString(), data }, null, 2),
      );
      log(`${kind} submission recorded → ${file}`);
      for (const [k, v] of Object.entries(data)) log(`  ${k} = ${v.slice(0, 80)}`);
    } catch {
      // recording is best-effort; the page response is the contract
    }
  };

  const sessionEmail = (req: http.IncomingMessage): string | null => {
    const cookie = req.headers.cookie ?? "";
    const sid = cookie.match(/sandbox_sid=([a-f0-9-]+)/)?.[1];
    return sid ? (sessions.get(sid) ?? null) : null;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, html: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(html);
    };
    const redirect = (to: string, headers: Record<string, string> = {}) => {
      res.writeHead(302, { location: to, ...headers });
      res.end();
    };

    try {
      if (req.method === "GET" && url.pathname === "/") {
        send(
          200,
          page(
            "Employer sandbox",
            `<h1>Dispatch employer sandbox</h1>
             <ul>
               <li><a href="/gauntlet">/gauntlet</a> — weird-questions application (predictive tiers)</li>
               <li><a href="/portal">/portal</a> — posting → email/password wall → form (navigation + portal auth)</li>
             </ul>
             <p class="muted">Loopback only. Accounts reset when the server restarts.</p>`,
          ),
        );
      } else if (req.method === "GET" && url.pathname === "/gauntlet") {
        send(200, gauntletPage());
      } else if (req.method === "POST" && url.pathname === "/gauntlet/submit") {
        record("gauntlet", await readBody(req));
        send(200, confirmationPage());
      } else if (req.method === "GET" && url.pathname === "/portal") {
        send(200, portalPostingPage());
      } else if (req.method === "GET" && url.pathname === "/portal/auth") {
        const email = sessionEmail(req);
        if (email) redirect("/portal/form");
        else send(200, portalAuthPage());
      } else if (req.method === "POST" && url.pathname === "/portal/create-account") {
        const body = await readBody(req);
        const email = (body["email"] ?? "").toLowerCase().trim();
        if (!email || !body["password"]) {
          send(400, portalAuthPage("Email and password are required."));
        } else if (body["password"] !== body["verifyPassword"]) {
          send(400, portalAuthPage("Passwords do not match."));
        } else if (accounts.has(email)) {
          send(409, portalAuthPage("An account with this email already exists. Sign in instead."));
        } else {
          accounts.set(email, { email, password: body["password"] });
          const sid = randomUUID();
          sessions.set(sid, email);
          log(`account created: ${email}`);
          redirect("/portal/form", { "set-cookie": `sandbox_sid=${sid}; Path=/` });
        }
      } else if (req.method === "POST" && url.pathname === "/portal/sign-in") {
        const body = await readBody(req);
        const email = (body["email"] ?? "").toLowerCase().trim();
        const account = accounts.get(email);
        if (!account || account.password !== body["password"]) {
          send(401, portalAuthPage("Invalid email or password."));
        } else {
          const sid = randomUUID();
          sessions.set(sid, email);
          log(`signed in: ${email}`);
          redirect("/portal/form", { "set-cookie": `sandbox_sid=${sid}; Path=/` });
        }
      } else if (req.method === "GET" && url.pathname === "/portal/form") {
        const email = sessionEmail(req);
        if (!email) redirect("/portal/auth");
        else send(200, portalFormPage(email));
      } else if (req.method === "POST" && url.pathname === "/portal/submit") {
        const email = sessionEmail(req);
        if (!email) {
          redirect("/portal/auth");
        } else {
          const body = await readBody(req);
          record("portal", { account: email, ...body });
          send(200, confirmationPage());
        }
      } else {
        send(404, page("Not found", "<h1>404</h1>"));
      }
    } catch (err) {
      send(500, page("Error", `<h1>Sandbox error</h1><pre>${String(err)}</pre>`));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback ONLY — this is a local test rig, never a service.
    server.listen(options.port ?? 4599, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (options.port ?? 4599);
      log(`employer sandbox listening on http://localhost:${port}`);
      log(`  gauntlet: http://localhost:${port}/gauntlet`);
      log(`  portal:   http://localhost:${port}/portal`);
      resolve({
        port,
        url: `http://localhost:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        accountEmails: () => [...accounts.keys()],
      });
    });
  });
}
