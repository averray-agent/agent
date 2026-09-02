"use client";

import { useEffect } from "react";
import { startAuthRefreshManager } from "@/lib/auth/auth-refresh-manager";

/**
 * Mounts the background JWT refresh manager once per authed app instance.
 *
 * Boot is decoupled from <LiveDataBridge /> because the refresh manager is
 * useful even before the event stream connects (and survives a stream that
 * fails to connect). Both components are mounted from the authed layout.
 */
export function AuthRefreshBridge() {
  useEffect(() => {
    const stop = startAuthRefreshManager();
    return stop;
  }, []);
  return null;
}
