"use client";

import { useEffect, useState } from "react";
import { getAuthSnapshot, onAuthChange, type AuthSnapshot } from "./token-store";
import { startBoundedSessionProbe } from "./session-probe.js";

export function useAuth(): AuthSnapshot {
  const [snapshot, setSnapshot] = useState<AuthSnapshot>(() => ({
    authenticated: false,
    checked: false,
    roles: [],
  }));

  useEffect(() => {
    const stopProbe = startBoundedSessionProbe({
      probe: getAuthSnapshot,
      // The server-rendered wall is already visible. The deadline merely
      // ensures this initial read can never keep it in an indeterminate state.
      onDeadline: () => setSnapshot({ authenticated: false, checked: true, roles: [] }),
      // Late valid sessions still upgrade the wall; they are not discarded.
      onResolved: (resolved: AuthSnapshot) => setSnapshot({ ...resolved, checked: true }),
    });
    const unsubscribe = onAuthChange(
      (resolved) => setSnapshot({ ...resolved, checked: true }),
      { emitCurrent: false }
    );
    return () => {
      stopProbe();
      unsubscribe();
    };
  }, []);

  return snapshot;
}
