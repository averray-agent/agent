const ALLOWLIST_FALLBACK =
  "Posting requires operator enrollment while the door is allowlist-only.";

export function posterModeCopy(payload) {
  const mode = nonEmptyString(payload?.mode)?.toLowerCase() ?? null;

  if (mode === "allowlist") {
    return {
      mode,
      statement: nonEmptyString(payload?.allowlistEnrollment) ?? ALLOWLIST_FALLBACK,
      detail:
        "Enrolled wallets can post below — the draft is created first (no funds move), then your connected wallet signs the funding transactions the platform itself issues. Non-enrolled drafts are refused at submission; that refusal is the enrollment truth."
    };
  }

  if (mode === "open") {
    return {
      mode,
      statement: "Posting is open.",
      detail:
        "Create a draft below — no funds move until your connected wallet signs the funding transactions the platform itself issues."
    };
  }

  return {
    mode,
    statement: mode === "closed"
      ? "External posting is currently closed."
      : "The live posting mode is unavailable.",
    detail: "Draft submission is unavailable."
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
