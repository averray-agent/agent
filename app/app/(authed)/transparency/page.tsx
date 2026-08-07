"use client";

import {
  TransparencyAuthorizationState,
  TransparencyPanel,
  TransparencyRequestState,
} from "@/components/transparency/TransparencyPanel";
import { useTransparency } from "@/lib/api/hooks";
import { transparencyAccessState } from "@/lib/api/transparency-access";
import { useAuth } from "@/lib/auth/use-auth";

export default function TransparencyPage() {
  const transparency = useTransparency();
  const auth = useAuth();
  // Authorization is its own state. A 401/403 from /transparency means
  // this session may not read the page — not that the read failed. Only
  // a non-auth error (or a missing payload) is a read failure, and that
  // still renders the unchanged `no read` state.
  const access = transparencyAccessState({ request: transparency, auth });

  if (access.kind === "unauthorized") {
    return <TransparencyAuthorizationState access={access} />;
  }
  if (access.kind === "loading") {
    return <TransparencyRequestState state="loading" />;
  }
  if (access.kind === "unavailable" || !transparency.data) {
    return <TransparencyRequestState state="fallback" />;
  }
  return <TransparencyPanel data={transparency.data} />;
}
