import { apiGet } from "../api/client";
import type { ArmStatus } from "../api/types";
import { usePoll } from "./usePoll";

/**
 * Live arm status, polled so the countdown and the global banner stay in
 * sync with the server (which is the source of truth — an expired session
 * reads as disarmed on the next poll).
 */
export function useArmStatus(intervalMs = 3000): {
  status: ArmStatus | null;
  refresh: () => void;
} {
  const { data, refresh } = usePoll<ArmStatus>(
    () => apiGet<ArmStatus>("/api/automation/status"),
    intervalMs,
  );
  return { status: data ?? null, refresh };
}

export function formatCountdown(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}
