const CONTROL_LOCKED_COPY = new Map([
  ["admin.capabilities.view", "Grant feed locked for this session."],
  ["admin.capabilities.grant", "Grant controls locked for this session."],
  ["admin.capabilities.revoke", "Grant controls locked for this session."],
  ["admin.jobs.lifecycle", "Lifecycle controls locked for this session."],
]);

/**
 * Capability identifiers are an internal policy contract, not useful UI copy.
 * Keep the refusal human and session-scoped without suggesting that a viewer
 * can grant itself a role it will never hold.
 */
export function controlLockedReason(controlName) {
  return CONTROL_LOCKED_COPY.get(String(controlName ?? ""))
    ?? "This control is locked for this session.";
}
