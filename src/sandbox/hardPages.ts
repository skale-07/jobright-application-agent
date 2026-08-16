/**
 * The HARD sandbox courses (operator directive 2026-08-16: "develop more
 * difficult sandbox based on difficult artifacts the nav system struggled
 * with, and make another difficult fill application for the fill system").
 *
 * Every obstacle here is a re-creation of something a live artifact shows
 * the system actually failing or struggling at — not invented difficulty:
 *
 * /navhard (navigation course)
 *   - cookie-consent banner overlaying the page (UHM/Paycom: "Accept
 *     Cookies" bar blocked clicks under it)
 *   - decoy Apply-ish controls ("Apply filters", "How to apply") around
 *     one real "Apply now"
 *   - the real Apply opens a POPUP that starts about:blank and settles
 *     late (the JobRight popup class: "popup settled off about:blank")
 *   - the popup lands on a LEAD-CAPTURE modal asking legal name, email,
 *     phone and a consent radio — the Paycom "Getting You Started" shape.
 *     The operator's read is the design: this page IS a form with identity
 *     fields, so the FILL machinery answers it from the same profile
 *     context; navigation doesn't need its own copy of the data.
 *   - only then the application form, then a real confirmation.
 *
 * /fillhard (fill course)
 *   - the outer page has ZERO fields; the form lives in an IFRAME
 *     (embedded-board class — exercises the frame hop)
 *   - inside: a 2-page wizard whose Next flags an error banner when
 *     required fields are empty (Workday class)
 *   - a pre-filled WRONG value that must be replaced, not appended to
 *   - a virtualized combobox that renders only the first 8 of 22 options
 *     until filtered (the truncated-harvest class)
 *   - a multi-select chips control, and an Other→specify reveal
 */

export const HARD_CSS = `
  .overlay { position: fixed; left: 0; right: 0; bottom: 0; background: #232946; color: #fff; padding: 1rem; z-index: 50; }
  .overlay button { margin: 0 0 0 1rem; }
  .modal-back { position: fixed; inset: 0; background: rgba(20,20,40,0.55); z-index: 40; }
  .modal { position: fixed; top: 8%; left: 50%; transform: translateX(-50%); width: min(560px, 92vw);
           background: #fff; padding: 1rem 1.5rem 1.5rem; z-index: 45; max-height: 84vh; overflow: auto; }
  .chips label { display: inline-block; margin: 0.25rem 0.5rem 0.25rem 0; font-weight: 400; }
  .chips input { width: auto; margin-right: 0.3rem; }
  .banner-error { background: #fde8e8; color: #b00020; padding: 0.6rem 1rem; font-weight: 600; display: none; }
`;

/** /navhard — posting with cookie banner + decoys; Apply opens a late popup. */
export function navHardPostingPage(): string {
  return `
  <h1>Machine Intelligence Intern</h1>
  <p>Frobnicator Industries — Strongsville, OH. Hybrid.</p>
  <input placeholder="Search by job title, ID, or keyword" />
  <input placeholder="City, state, or country/region" />
  <button type="button" onclick="return false">Apply filters</button>
  <p class="muted">Scroll past the description… the long way, like a real posting.</p>
  ${'<p class="muted">Frobnication is the practice of collaborative excellence at scale.</p>'.repeat(6)}
  <a href="#how">How to apply</a>
  <button id="apply">Apply now</button>
  <div class="overlay" id="cookies">
    This website uses cookies to customize and improve your experience.
    <button id="accept-cookies">Accept Cookies</button>
  </div>
  <script>
    document.getElementById('accept-cookies').addEventListener('click', () => {
      document.getElementById('cookies').remove();
    });
    document.getElementById('apply').addEventListener('click', () => {
      // The popup opens BLANK and settles late — the exact class the
      // navigation telemetry calls "popup settled off about:blank".
      const w = window.open('', '_blank');
      setTimeout(() => { if (w) w.location = '/navhard/started'; }, 1200);
    });
  </script>`;
}

/** The lead-capture modal (Paycom "Getting You Started" shape). */
export function navHardLeadCapturePage(): string {
  return `
  <div class="modal-back"></div>
  <div class="modal">
    <h1>Getting You Started</h1>
    <p>Save your application, receive urgent messages from recruiters and
       track your application status.</p>
    <form method="POST" action="/navhard/continue">
      <label class="req" for="first_name">Legal First Name</label>
      <input id="first_name" name="first_name" required />
      <label class="req" for="last_name">Legal Last Name</label>
      <input id="last_name" name="last_name" required />
      <label class="req" for="email">Email Address</label>
      <input id="email" name="email" type="email" required />
      <label class="req" for="phone">Primary Phone Number</label>
      <input id="phone" name="phone" required />
      <label class="req">Do you consent to receiving text communications related to your job application?</label>
      <label style="font-weight:400"><input type="radio" name="sms_consent" value="Yes" style="width:auto" /> Yes</label>
      <label style="font-weight:400"><input type="radio" name="sms_consent" value="No" style="width:auto" /> No</label>
      <button type="submit">Continue To Application</button>
    </form>
  </div>`;
}

/** The real /navhard application, reachable only through the modal. */
export function navHardFormPage(): string {
  return `
  <h1>Application — Machine Intelligence Intern</h1>
  <form method="POST" action="/navhard/submit">
    <label class="req" for="first_name">First Name</label>
    <input id="first_name" name="first_name" required />
    <label class="req" for="last_name">Last Name</label>
    <input id="last_name" name="last_name" required />
    <label class="req" for="q_hybrid">This role is hybrid (3 days on-site). Can you commit to that schedule?</label>
    <select id="q_hybrid" name="q_hybrid" required>
      <option value="">Select...</option><option>Yes</option><option>No</option>
    </select>
    <button type="submit">Submit application</button>
  </form>`;
}

/** /fillhard — outer page: ZERO fields, the form is inside an iframe. */
export function fillHardOuterPage(): string {
  return `
  <h1>Careers at Frobnicator — Application</h1>
  <p class="muted">This employer embeds its application. The outer document has no fields at all.</p>
  <iframe src="/fillhard/embed" style="width:100%;height:1400px;border:1px solid #ccd"></iframe>`;
}

/** The embedded 2-page wizard with every fill obstacle from the artifacts. */
export function fillHardEmbedPage(): string {
  return `
  <h1>Application</h1>
  <div id="err" class="banner-error">Please fix the errors below — required fields are missing.</div>
  <form method="POST" action="/fillhard/submit" id="wizard">
    <div id="page1">
      <h2>Step 1 of 2 — About you</h2>
      <label class="req" for="first_name">First Name</label>
      <input id="first_name" name="first_name" required />
      <label class="req" for="last_name">Last Name</label>
      <input id="last_name" name="last_name" required />
      <label class="req" for="email">Email</label>
      <input id="email" name="email" type="email" value="wrong.person@example.com" required />
      <p class="muted">This email arrives PRE-FILLED with the wrong value — replacing beats appending.</p>

      <label class="req" for="q_skill">Which technology are you strongest in?</label>
      <div class="combo">
        <input id="q_skill" name="q_skill" role="combobox" aria-autocomplete="list" autocomplete="off" placeholder="Select..." />
        <div id="q_skill_list" class="combo-list" style="display:none" role="listbox"></div>
      </div>
      <p class="muted">22 options; only 8 render until you filter — like a virtualized menu.</p>

      <label>Which areas interest you? (choose all that apply)</label>
      <div class="chips">
        <label><input type="checkbox" name="area" value="Machine Learning" />Machine Learning</label>
        <label><input type="checkbox" name="area" value="Infrastructure" />Infrastructure</label>
        <label><input type="checkbox" name="area" value="Product" />Product</label>
        <label><input type="checkbox" name="area" value="Security" />Security</label>
      </div>
      <button type="button" id="next">Next</button>
    </div>
    <div id="page2" style="display:none">
      <h2>Step 2 of 2 — Screeners</h2>
      <label class="req" for="q_env">Which development environment feels most like home?</label>
      <select id="q_env" name="q_env" required>
        <option value="">Select...</option>
        <option>Terminal + Vim</option><option>VS Code</option><option>JetBrains</option><option>Other</option>
      </select>
      <div id="q_env_specify_wrap" style="display:none">
        <label for="q_env_specify">If other, please specify</label>
        <input id="q_env_specify" name="q_env_specify" />
      </div>
      <label class="req" for="q_commit">Have you ever committed directly to main on a Friday?</label>
      <select id="q_commit" name="q_commit" required>
        <option value="">Select...</option><option>Yes</option><option>No</option><option>Only with a green CI</option>
      </select>
      <label for="q_why">Why Frobnicator?</label>
      <textarea id="q_why" name="q_why" rows="3"></textarea>
      <button type="submit">Submit application</button>
    </div>
  </form>
  <script>
    const SKILLS = ['TypeScript','Python','Rust','Go','Java','Kotlin','Swift','C++','C#','Ruby','PHP','Scala','Haskell','Elixir','Erlang','Clojure','OCaml','Zig','Lua','R','Julia','Fortran'];
    const skill = document.getElementById('q_skill');
    const list = document.getElementById('q_skill_list');
    const renderList = (filter) => {
      const hits = SKILLS.filter((s) => !filter || s.toLowerCase().includes(filter.toLowerCase()));
      const windowed = hits.slice(0, 8); // virtualization: first window only
      list.innerHTML = windowed.length
        ? windowed.map((s) => '<div role="option">' + s + '</div>').join('')
        : '<div role="option">No options</div>';
      list.style.display = 'block';
    };
    skill.addEventListener('focus', () => renderList(''));
    skill.addEventListener('click', () => renderList(skill.value));
    skill.addEventListener('input', () => renderList(skill.value));
    list.addEventListener('click', (e) => {
      const t = e.target.closest('[role=option]');
      if (t && t.textContent !== 'No options') { skill.value = t.textContent; list.style.display = 'none'; }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') list.style.display = 'none'; });

    document.getElementById('q_env').addEventListener('change', (e) => {
      document.getElementById('q_env_specify_wrap').style.display =
        e.target.value === 'Other' ? 'block' : 'none';
    });

    document.getElementById('next').addEventListener('click', () => {
      const required = ['first_name','last_name','email','q_skill'];
      const missing = required.filter((id) => !document.getElementById(id).value.trim());
      const err = document.getElementById('err');
      if (missing.length > 0 || document.getElementById('email').value === 'wrong.person@example.com') {
        err.style.display = 'block';
        err.textContent = 'Please fix the errors below — ' +
          (missing.length ? 'required fields are missing.' : 'the pre-filled email must be your own.');
        return;
      }
      err.style.display = 'none';
      document.getElementById('page1').style.display = 'none';
      document.getElementById('page2').style.display = 'block';
    });
  </script>`;
}

/**
 * The email-verification wall. Shapes chosen so the REAL recovery engages:
 * `autocomplete="one-time-code"` is the generic selector portal auth
 * probes, `data-automation-id="verifyButton"` matches its submit cascade,
 * and the copy satisfies verificationEvidencePresent().
 */
export function portalVerifyPage(email: string, error?: string): string {
  return `
  <h1>Verify your email</h1>
  ${error ? `<p class="error">${error}</p>` : ""}
  <p>We've emailed a 6-digit verification code to the address you signed up with.
     Check your inbox and enter the code below to continue your application.</p>
  <p class="muted">Sent to ${email}</p>
  <form method="POST" action="/portal/verify">
    <label class="req" for="code">Verification code</label>
    <input id="code" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6" required />
    <button type="submit" data-automation-id="verifyButton">Verify</button>
  </form>
  <p class="muted">Didn't get it? The sandbox terminal always shows the code; with
     RESEND_API_KEY set it is also emailed for the full mailbox-scan rehearsal.</p>`;
}
