"""Agent-assisted adapter authoring (Phase 6 J1).

Contract: exactly one JSON task on stdin, exactly one JSON result on stdout.
Task and result schemas are defined (and zod-validated) on the TypeScript
side in src/agent/contract.ts — that side is authoritative.

This module is INERT by default:
- browser-use is not installed by npm; the operator creates the venv
  (`python -m venv .venv && .venv/Scripts/pip install -e .` on Windows).
- Without browser-use importable, it exits non-zero with a machine-readable
  error result instead of doing anything.
- It attaches to the operator's debug Chrome over CDP (never launches one),
  reads the page, and emits selector candidates. It never fills, never
  submits, and never touches application state — promotion of its output
  into fixtures is a separate human step.
- LLM keys are never stored here; the operator passes them via environment
  variables at run time only.
"""

from __future__ import annotations

import asyncio
import json
import sys


def _fail(reason: str, code: int = 1) -> None:
    print(json.dumps({"status": "error", "reason": reason, "field_candidates": [], "warnings": []}))
    sys.exit(code)


def main() -> None:
    raw = sys.stdin.read()
    try:
        task = json.loads(raw)
    except json.JSONDecodeError:
        _fail("stdin was not valid JSON")
        return

    if task.get("task_version") != 1:
        _fail(f"unsupported task_version: {task.get('task_version')!r}")
        return

    task_type = task.get("task_type", "author")
    if task_type == "locate_field":
        # HTML-payload analysis — stdlib only, no browser, no browser-use.
        try:
            print(json.dumps(_locate_field(task)))
        except Exception as exc:  # noqa: BLE001
            _fail(f"locate_field failed: {exc}")
        return
    if task_type == "navigate":
        # Navigation results are navigate-shaped (see agentNavigateResultSchema)
        # — never the field-candidate shape _fail() emits.
        from . import navigate

        navigate.run(task)
        return
    if task_type != "author":
        _fail(f"unsupported task_type: {task_type!r}")
        return

    url = task.get("url")
    cdp_url = task.get("cdp_url")
    if not isinstance(url, str) or not isinstance(cdp_url, str):
        _fail("task must include url and cdp_url strings")
        return

    try:
        import browser_use  # noqa: F401
    except ImportError:
        _fail("browser-use not installed")
        return

    try:
        result = asyncio.run(_author(task))
    except Exception as exc:  # noqa: BLE001 — sidecar reports, TS side decides
        _fail(f"authoring failed: {exc}")
        return

    print(json.dumps(result))


async def _author(task: dict) -> dict:
    """Read-only field discovery on the page at task['url'].

    Uses browser-use's Browser attached to the operator's Chrome via
    task['cdp_url']. Emits candidate selectors per visible form field for a
    human to review and promote. Intentionally minimal: J1 is an authoring
    aid, not an autonomous agent loop.
    """
    from browser_use import Browser  # type: ignore[import-not-found]

    browser = Browser(cdp_url=task["cdp_url"])
    warnings: list[str] = []
    candidates: list[dict] = []

    page = await browser.new_page(task["url"])
    try:
        # Field discovery via the DOM directly — deterministic, no LLM call.
        fields = await page.evaluate(
            """
            () => Array.from(
              document.querySelectorAll("input, textarea, select")
            ).filter(el => el.type !== "hidden").map(el => {
              const label = el.labels && el.labels[0]
                ? el.labels[0].textContent.trim()
                : (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || el.id || "");
              const sel = [];
              if (el.id) sel.push("#" + el.id);
              if (el.name) sel.push(`[name="${el.name}"]`);
              if (el.getAttribute("aria-label")) sel.push(`[aria-label="${el.getAttribute("aria-label")}"]`);
              return {
                label,
                type: el.tagName === "TEXTAREA" ? "textarea"
                  : el.tagName === "SELECT" ? "select" : (el.type || "text"),
                selector_candidates: sel,
                confidence: sel.length >= 2 ? 0.8 : sel.length === 1 ? 0.5 : 0.2,
              };
            })
            """
        )
        candidates = [f for f in fields if f.get("selector_candidates")]
        skipped = len(fields) - len(candidates)
        if skipped:
            warnings.append(f"{skipped} field(s) had no stable selector candidates")
    finally:
        await browser.close()

    return {
        "status": "ok",
        "field_candidates": candidates,
        "warnings": warnings,
    }


_CONTROL_RE = None  # compiled lazily


def _normalize(text: str) -> set[str]:
    import re

    return {t for t in re.split(r"[^a-z0-9]+", text.lower()) if len(t) > 1}


def _locate_field(task: dict) -> dict:
    """Rank form controls in the supplied HTML by label similarity.

    Deterministic token-overlap scoring — the escalation seam, not an agent
    loop. A future J2 task type may put browser-use's semantic matching
    behind the same contract; the TS side treats both identically.
    """
    import re

    label = task.get("field_label")
    field_type = task.get("field_type", "text")
    html = task.get("html")
    if not isinstance(label, str) or not isinstance(html, str):
        raise ValueError("locate_field requires field_label and html strings")

    wanted = _normalize(label)
    if not wanted:
        raise ValueError("field_label has no comparable tokens")

    tag_re = re.compile(r"<(input|textarea|select)\b([^>]*)>", re.I)
    attr_re = re.compile(r'([a-zA-Z-]+)\s*=\s*"([^"]*)"')

    # label[for] map for better evidence
    label_for: dict[str, str] = {}
    for m in re.finditer(r'<label\b[^>]*for="([^"]+)"[^>]*>([\s\S]*?)</label>', html, re.I):
        label_for[m.group(1)] = re.sub(r"<[^>]+>", " ", m.group(2)).strip()

    candidates = []
    for m in tag_re.finditer(html):
        tag = m.group(1).lower()
        attrs = dict(attr_re.findall(m.group(2)))
        if attrs.get("type", "").lower() in ("hidden", "submit", "button", "image"):
            continue
        el_type = (
            "textarea" if tag == "textarea"
            else "select" if tag == "select"
            else attrs.get("type", "text").lower()
        )
        evidence_parts = [
            label_for.get(attrs.get("id", ""), ""),
            attrs.get("aria-label", ""),
            attrs.get("placeholder", ""),
            attrs.get("name", ""),
            attrs.get("id", ""),
        ]
        tokens: set[str] = set()
        for part in evidence_parts:
            tokens |= _normalize(part)
        if not tokens:
            continue
        overlap = len(wanted & tokens) / len(wanted)
        type_bonus = 0.15 if el_type == str(field_type).lower() else 0.0
        score = round(min(1.0, overlap + type_bonus), 3)
        if score < 0.34:
            continue
        selectors = []
        if attrs.get("id"):
            selectors.append("#" + attrs["id"])
        if attrs.get("name"):
            selectors.append(f'[name="{attrs["name"]}"]')
        if attrs.get("aria-label"):
            selectors.append(f'[aria-label="{attrs["aria-label"]}"]')
        if not selectors:
            continue
        candidates.append({
            "label": label,
            "type": el_type,
            "selector_candidates": selectors,
            "confidence": score,
        })

    candidates.sort(key=lambda c: c["confidence"], reverse=True)
    return {
        "status": "ok",
        "field_candidates": candidates[:5],
        "warnings": [] if candidates else [f"no candidates scored >= 0.34 for {label!r}"],
    }


if __name__ == "__main__":
    main()
