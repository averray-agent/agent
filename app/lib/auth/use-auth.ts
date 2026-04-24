"use client";

import { useEffect, useState } from "react";
import { getAuthSnapshot, onAuthChange, type AuthSnapshot } from "./token-store";

export function useAuth(): AuthSnapshot {
  const [snapshot, setSnapshot] = useState<AuthSnapshot>(() => ({
    authenticated: false,
    roles: [],
  }));

  useEffect(() => {
    setSnapshot(getAuthSnapshot());
    return onAuthChange(setSnapshot);
  }, []);

  return snapshot;
}
