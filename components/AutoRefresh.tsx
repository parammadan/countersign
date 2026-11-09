"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { startPolling } from "./poll";

/** Re-fetches the page's server data every few seconds while `active` and the tab is visible, so a status
 *  change (the client signs, the firm countersigns) shows up without a reload. Renders nothing. */
export function AutoRefresh({ active, intervalMs = 5000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    return startPolling(() => router.refresh(), intervalMs, document);
  }, [active, intervalMs, router]);
  return null;
}
