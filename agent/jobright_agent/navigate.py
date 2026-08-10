"""Navigation task (nav layer N3).

Contract: one JSON navigate task (parsed by author.main), one
navigate-shaped JSON result on stdout — schemas authoritative on the
TypeScript side (src/agent/contract.ts agentNavigate*Schema).

Hard rules, enforced here by prompt AND mechanically where the pinned
browser-use version allows, and re-checked on the Node side either way:
- Attach to the operator's CDP Chrome only (never launch a browser).
- Never fill application-form fields; never click an application Submit
  control — report wall="submit_risk" instead.
- Never leave the task's allowed_domains.
- Stop on CAPTCHA (wall="captcha") and phone verification (wall="phone_otp").
- On an email-verification prompt: status="needs_input" with a `need`
  payload; the Node orchestrator services it via the Gmail tool and
  re-invokes with `resume` populated (this process never reads mail).

The sidecar's self-report carries no validation level: the Node side
validates the result shape, rejects off-domain/jobright final URLs, and
only a deterministic URL store + detectAtsFromUrl verdict counts as nav
success.

LLM key: environment at spawn time only (OPENAI_API_KEY); never stored or
echoed. browser-use is pinned in pyproject; all browser-use usage stays in
this module.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from urllib.parse import urlparse

_WALLS = ("none", "auth", "captcha", "phone_otp", "budget", "submit_risk")


def _emit(result: dict, code: int = 0) -> None:
    print(json.dumps(result))
    sys.exit(code)


_PROGRESS_CAP = 400
_progress_count = 0


def _progress(event: str, **fields) -> None:
    """NDJSON progress on STDERR — telemetry only, never the result.

    The stdout one-JSON contract is untouched; the Node side tails these
    lines live ({"jaa_progress":1,...}) for run-log streaming and the
    per-run agent trace. Hard rules: never include typed values, secrets,
    or model thoughts here — actions, hosts, and timings only. Capped so
    a thrashing agent can't flood the pipe.
    """
    global _progress_count
    if _progress_count >= _PROGRESS_CAP:
        return
    _progress_count += 1
    try:
        line = json.dumps({"jaa_progress": 1, "event": event, "t": round(time.time(), 3), **fields})
        print(line, file=sys.stderr, flush=True)
    except Exception:  # noqa: BLE001 — progress must never kill the task
        pass


def _fail_navigate(reason: str, wall: str = "budget", code: int = 1) -> None:
    # The reason ALSO rides in notes: a zero-step failure whose cause lives
    # only in `reason` proved undiagnosable from the nav artifact alone
    # (three live runs shipped with empty notes).
    _emit(
        {
            "status": "error",
            "final_url": None,
            "wall": wall if wall in _WALLS else "budget",
            "steps_used": 0,
            "domains_visited": [],
            "notes": [reason[:490]],
            "reason": reason,
        },
        code,
    )


def _host(url: str) -> str:
    try:
        return urlparse(url).hostname or ""
    except ValueError:
        return ""


def _in_allowed(url: str, allowed: list[str]) -> bool:
    host = _host(url)
    return any(host == d or host.endswith("." + d) for d in allowed)


def _goal_prompt(task: dict) -> str:
    creds = task.get("credentials") or {}
    cred_rule = (
        "An account credential is available; if the site demands sign-in, sign in "
        "with the provided username/password. If it demands account CREATION, create "
        "the account with exactly those credentials."
        if creds.get("available")
        else "No account credential is available. If the site demands sign-in or "
        "account creation, STOP and finish with the exact text WALL_AUTH."
    )
    gmail_rule = (
        "If the site says it emailed a verification code or link, STOP and finish "
        "with the exact text NEED_EMAIL_VERIFICATION followed by the email address "
        "it says it mailed."
        if task.get("gmail_available")
        else "If the site says it emailed a verification code or link, STOP and "
        "finish with the exact text WALL_AUTH."
    )
    return (
        f"{task['goal']}\n\n"
        "HARD RULES — violating any of these is failure:\n"
        f"1. Stay strictly on these domains: {', '.join(task['allowed_domains'])}. "
        "Never navigate elsewhere.\n"
        "2. NEVER type into application-form fields (name, email, resume, questions) "
        "and NEVER click a Submit/Apply-final control on an application form. If the "
        "only way forward is submitting an application, STOP and finish with the "
        "exact text WALL_SUBMIT_RISK.\n"
        "3. If you meet a CAPTCHA or robot check, STOP and finish with the exact "
        "text WALL_CAPTCHA.\n"
        "4. If you meet phone/SMS verification, STOP and finish with the exact text "
        "WALL_PHONE.\n"
        f"5. {cred_rule}\n"
        f"6. {gmail_rule}\n"
        "7. When the employer application FORM PAGE is visible (form fields present, "
        "no wall), STOP and finish with the exact text FORM_REACHED followed by the "
        "page URL.\n"
    )


def _classify(final_text: str) -> tuple[str, str]:
    """Map the agent's final report onto (status, wall)."""
    t = (final_text or "").upper()
    if "FORM_REACHED" in t:
        return "ok", "none"
    if "NEED_EMAIL_VERIFICATION" in t:
        return "needs_input", "auth"
    if "WALL_CAPTCHA" in t:
        return "error", "captcha"
    if "WALL_PHONE" in t:
        return "error", "phone_otp"
    if "WALL_SUBMIT_RISK" in t:
        return "error", "submit_risk"
    if "WALL_AUTH" in t:
        return "error", "auth"
    return "error", "budget"


def _extract_email(final_text: str) -> str:
    import re

    m = re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", final_text or "")
    return m.group(0) if m else ""


async def _navigate(task: dict) -> dict:
    from browser_use import Agent, Browser  # type: ignore[import-not-found]

    _progress("imports_ready")
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY not set in the sidecar environment")

    from browser_use.llm import ChatOpenAI  # type: ignore[import-not-found]

    llm = ChatOpenAI(model=os.environ.get("NAV_AGENT_MODEL", "gpt-5-mini"))
    _progress("browser_attaching", cdp_host=_host(task["cdp_url"]) or task["cdp_url"][:40])
    browser = Browser(cdp_url=task["cdp_url"])

    resume = task.get("resume")
    start_url = task["start_url"]
    goal = _goal_prompt(task)
    if resume:
        injected = resume["injected"]
        start_url = resume["prior_final_url"]
        if injected["kind"] == "verification_code":
            goal = (
                f"Continue a paused flow at {start_url}. Enter the verification code "
                f"{injected['code']} into the code prompt, confirm it, then continue.\n\n"
                + goal
            )
        else:
            if not _in_allowed(injected["url"], task["allowed_domains"]):
                raise RuntimeError("magic link outside allowed domains")
            start_url = injected["url"]
            goal = (
                f"Open the verification link you are starting on, then continue.\n\n"
                + goal
            )

    creds = task.get("credentials") or {}
    sensitive = (
        {"nav_username": creds.get("username", ""), "nav_password": creds.get("password", "")}
        if creds.get("available")
        else None
    )

    started = time.monotonic()
    notes: list[str] = []
    agent_kwargs: dict = {
        "task": f"Start at {start_url}.\n\n{goal}",
        "llm": llm,
        "browser": browser,
    }
    if sensitive:
        # browser-use substitutes placeholders so raw secrets stay out of
        # the LLM transcript where supported.
        try:
            agent_kwargs["sensitive_data"] = sensitive
        except Exception:  # noqa: BLE001
            pass

    # Per-step telemetry (scrubbed): action names + destination host only —
    # never typed values, never model thoughts. The callback API is
    # version-sensitive across browser-use releases, so registration is
    # best-effort; without it the heartbeats above still bound the silence.
    step_counter = {"i": 0}

    def _on_step(*cb_args, **cb_kwargs) -> None:  # noqa: ANN002, ANN003
        try:
            step_counter["i"] += 1
            actions: list[str] = []
            url_host = ""
            for a in cb_args:
                model_output = getattr(a, "model_output", None) or (
                    a if hasattr(a, "action") else None
                )
                acts = getattr(model_output, "action", None)
                if isinstance(acts, list):
                    for act in acts[:4]:
                        try:
                            dumped = act.model_dump(exclude_none=True)
                            actions.extend(list(dumped.keys())[:2])
                        except Exception:  # noqa: BLE001
                            actions.append(type(act).__name__)
                state_url = getattr(a, "url", None)
                if isinstance(state_url, str) and state_url.startswith("http"):
                    url_host = _host(state_url)
            _progress(
                "step",
                i=step_counter["i"],
                actions=actions[:6],
                host=url_host,
                elapsed_ms=int((time.monotonic() - started) * 1000),
            )
        except Exception:  # noqa: BLE001 — telemetry must never break a step
            pass

    try:
        agent_kwargs["register_new_step_callback"] = _on_step
        agent = Agent(**agent_kwargs)
    except TypeError:
        agent_kwargs.pop("register_new_step_callback", None)
        notes.append("step telemetry unavailable (browser-use version lacks step callback)")
        agent = Agent(**agent_kwargs)
    _progress("agent_running", max_steps=int(task["max_steps"]))
    try:
        history = await asyncio.wait_for(
            agent.run(max_steps=int(task["max_steps"])),
            timeout=task["timeout_ms"] / 1000,
        )
    finally:
        try:
            await browser.close()  # disconnect only — CDP Chrome stays up
        except Exception:  # noqa: BLE001
            pass

    urls: list[str] = []
    steps_used = 0
    final_text = ""
    try:
        # Only web URLs count for the domain audit — about:blank /
        # chrome:// / data: tabs are browser furniture, not navigation.
        urls = [
            u
            for u in (history.urls() or [])
            if isinstance(u, str) and u.startswith(("http://", "https://"))
        ]
        steps_used = len(history.history)
        final_text = str(history.final_result() or "")
    except Exception as exc:  # noqa: BLE001
        notes.append(f"history introspection failed: {exc}")

    elapsed = time.monotonic() - started
    off_domain = [u for u in urls if u and not _in_allowed(u, task["allowed_domains"])]
    if off_domain:
        notes.append(f"agent visited off-domain URLs: {len(off_domain)} — result demoted")
        return {
            "status": "error",
            "final_url": None,
            "wall": "budget",
            "steps_used": steps_used,
            "domains_visited": sorted({_host(u) for u in urls if u}),
            "notes": notes[:20],
            "reason": "allowed_domains violated",
        }

    status, wall = _classify(final_text)
    final_url = urls[-1] if urls else None
    if status == "ok" and (not final_url or not _in_allowed(final_url, task["allowed_domains"])):
        status, wall = "error", "budget"
        notes.append("FORM_REACHED without a usable on-domain final URL")

    notes.append(f"elapsed {elapsed:.0f}s, steps {steps_used}")
    result: dict = {
        "status": status,
        "final_url": final_url if status != "error" or final_url else None,
        "wall": wall,
        "steps_used": steps_used,
        "domains_visited": sorted({_host(u) for u in urls if u})[:50],
        "notes": notes[:20],
    }
    if status == "needs_input":
        result["need"] = {
            "kind": "verification_email",
            "sent_to": _extract_email(final_text),
            "requested_at": __import__("datetime").datetime.now(
                __import__("datetime").timezone.utc
            ).isoformat(),
        }
    if status == "error":
        result["reason"] = f"agent stopped: {wall}"
    return result


def run(task: dict) -> None:
    try:
        import browser_use  # noqa: F401
    except ImportError:
        _fail_navigate("browser-use not installed")
        return

    for key in ("goal", "start_url", "cdp_url", "allowed_domains", "max_steps", "timeout_ms"):
        if key not in task:
            _fail_navigate(f"task missing {key}")
            return

    _progress("sidecar_spawned", start_host=_host(task.get("start_url", "")))
    try:
        result = asyncio.run(_navigate(task))
    except asyncio.TimeoutError:
        _fail_navigate("agent wall-clock timeout", wall="budget")
        return
    except Exception as exc:  # noqa: BLE001 — sidecar reports, TS side decides
        _fail_navigate(f"navigate failed: {exc}")
        return

    _emit(result)
