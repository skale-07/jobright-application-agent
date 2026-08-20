import type { ServerResponse } from "node:http";
import { getConfig } from "../config/index.js";
import { probeCdpTargetsForExtension } from "../automation/extensionPreflight.js";
import { jobrightExtensionSelectorsV1 } from "../jobright/extension/selectors.js";
import type { Route } from "./routes.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * X6: JobRight-extension readiness for the console — the Settings card
 * reads this instead of the operator running jobright:ext-check. Read-only
 * (a 3s-bounded HTTP probe of the CDP target list; no browser opens).
 */
export function buildExtensionRoutes(): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/extension/status",
      handler: async ({ res }) => {
        const cfg = getConfig();
        const probe = await probeCdpTargetsForExtension(cfg.agentCdpUrl);
        json(res, 200, {
          verdict: probe.verdict,
          cdp_url: cfg.agentCdpUrl,
          cdp_reachable: probe.cdp_reachable,
          matched_targets: probe.matched_targets,
          notes: probe.notes,
          flag_enabled: cfg.jobrightAutofillEnabled,
          trigger_selectors_promoted:
            jobrightExtensionSelectorsV1.autofillTrigger.length,
          // The three-step enablement the Settings card renders. Ready
          // means EXTENSION_FIRST would actually be chosen for a live run.
          ready:
            probe.verdict === "present" &&
            cfg.jobrightAutofillEnabled &&
            jobrightExtensionSelectorsV1.autofillTrigger.length > 0,
        });
      },
    },
  ];
}
