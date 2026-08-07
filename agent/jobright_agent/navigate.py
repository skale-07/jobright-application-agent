"""Navigation task (nav layer N-series).

Contract: one JSON navigate task on stdin (already parsed by author.main),
one navigate-shaped JSON result on stdout — schemas are authoritative on
the TypeScript side (src/agent/contract.ts agentNavigate*Schema).

Hard rules once implemented (N3): attach to the operator's CDP Chrome only
(never launch); never fill application-form fields; never click an
application Submit control (report wall="submit_risk" instead); never
leave the task's allowed_domains; stop on captcha / phone walls; on an
email-verification prompt return status="needs_input" with a `need`
payload and let the Node orchestrator service it via the Gmail tool.

This milestone ships the contract stub: a navigate-shaped error result so
the spawn/parse path is testable end to end before the browser-use loop
lands.
"""

from __future__ import annotations

import json
import sys


def _fail_navigate(reason: str, wall: str = "budget", code: int = 1) -> None:
    print(
        json.dumps(
            {
                "status": "error",
                "final_url": None,
                "wall": wall,
                "steps_used": 0,
                "domains_visited": [],
                "notes": [],
                "reason": reason,
            }
        )
    )
    sys.exit(code)


def run(task: dict) -> None:
    _fail_navigate("navigate not implemented (N1 stub)")
