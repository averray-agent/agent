"use client";

import { useEffect } from "react";
import { mutate } from "swr";
import { startEventStream, type EventTopic } from "@/lib/events/stream";
import { useAuth } from "@/lib/auth/use-auth";

const INVALIDATE_BY_TOPIC: Partial<Record<EventTopic, string[]>> = {
  "session.claimed": ["/jobs", "/admin/jobs", "/sessions", "/admin/sessions?limit=100"],
  "session.submitted": ["/jobs", "/admin/jobs", "/sessions", "/admin/sessions?limit=100"],
  "verification.resolved": ["/jobs", "/admin/jobs", "/sessions", "/admin/sessions?limit=100", "/badges", "/audit"],
  "escrow.job_funded": ["/jobs", "/admin/jobs", "/sessions", "/admin/sessions?limit=100", "/account", "/audit"],
  "escrow.job_claimed": ["/jobs", "/admin/jobs", "/sessions", "/admin/sessions?limit=100", "/account"],
  "escrow.work_submitted": ["/jobs", "/admin/jobs", "/sessions", "/admin/sessions?limit=100"],
  "escrow.job_rejected": ["/jobs", "/admin/jobs", "/sessions", "/admin/sessions?limit=100", "/disputes", "/alerts"],
  "escrow.job_closed": ["/jobs", "/admin/jobs", "/sessions", "/admin/sessions?limit=100", "/badges", "/agents", "/audit"],
  "escrow.job_reopened": ["/jobs", "/admin/jobs", "/sessions", "/admin/sessions?limit=100"],
  "escrow.dispute_opened": ["/disputes", "/alerts", "/jobs", "/admin/jobs", "/sessions", "/admin/sessions?limit=100"],
  "escrow.dispute_resolved": ["/disputes", "/alerts", "/jobs", "/admin/jobs", "/sessions", "/admin/sessions?limit=100", "/badges", "/agents", "/audit"],
  "escrow.auto_resolved_on_timeout": ["/disputes", "/alerts", "/jobs", "/admin/jobs", "/sessions", "/admin/sessions?limit=100", "/badges", "/agents", "/audit"],
  "account.job_stake_locked": ["/account", "/sessions", "/admin/sessions?limit=100"],
  "account.job_stake_released": ["/account", "/sessions", "/admin/sessions?limit=100", "/disputes"],
  "account.job_stake_slashed": ["/account", "/agents", "/disputes"],
  "reputation.badge_minted": ["/badges", "/agents", "/audit"],
  "reputation.updated": ["/agents"],
  "reputation.slashed": ["/agents", "/disputes"],
  gap: ["/jobs", "/admin/jobs", "/sessions", "/admin/sessions?limit=100", "/badges", "/agents", "/disputes", "/audit", "/alerts"],
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
