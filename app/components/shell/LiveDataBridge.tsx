"use client";

import { useEffect } from "react";
import { mutate } from "swr";
import { startEventStream, type EventTopic } from "@/lib/events/stream";
import { useAuth } from "@/lib/auth/use-auth";

const INVALIDATE_BY_TOPIC: Partial<Record<EventTopic, string[]>> = {
  "session.claimed": ["/jobs", "/sessions"],
  "session.submitted": ["/jobs", "/sessions"],
  "verification.resolved": ["/jobs", "/sessions", "/badges", "/audit"],
  "escrow.job_funded": ["/jobs", "/sessions", "/account", "/audit"],
  "escrow.job_claimed": ["/jobs", "/sessions", "/account"],
  "escrow.work_submitted": ["/jobs", "/sessions"],
  "escrow.job_rejected": ["/jobs", "/sessions", "/disputes", "/alerts"],
  "escrow.job_closed": ["/jobs", "/sessions", "/badges", "/agents", "/audit"],
  "escrow.job_reopened": ["/jobs", "/sessions"],
  "escrow.dispute_opened": ["/disputes", "/alerts", "/jobs", "/sessions"],
  "account.job_stake_locked": ["/account", "/sessions"],
  "account.job_stake_released": ["/account", "/sessions", "/disputes"],
  "account.job_stake_slashed": ["/account", "/agents", "/disputes"],
  "reputation.badge_minted": ["/badges", "/agents", "/audit"],
  "reputation.updated": ["/agents"],
  "reputation.slashed": ["/agents", "/disputes"],
  gap: ["/jobs", "/sessions", "/badges", "/agents", "/disputes", "/audit", "/alerts"],
};

export function LiveDataBridge() {
  const auth = useAuth();

  useEffect(() => {
    if (!auth.authenticated) return undefined;
    return startEventStream({
      wallet: auth.wallet,
      onEvent: ({ topic }) => {
        for (const key of INVALIDATE_BY_TOPIC[topic] ?? []) {
          mutate(key);
        }
      },
      onGap: () => {
        for (const key of INVALIDATE_BY_TOPIC.gap ?? []) {
          mutate(key);
        }
      },
    });
  }, [auth.authenticated, auth.wallet]);

  return null;
}
