/**
 * Auth-policy v1 (PR #159) adapter for the operator app.
 *
 * The backend exposes the platform's full capability matrix via
 * `GET /auth/session`:
 *
 *   {
 *     wallet, roles, capabilities,
 *     capabilityMatrix: {
 *       version, base, roles, routes, routeRules,
 *       uiControls: { "<control-name>": ["<required-cap>", ...] },
 *       automationActions: { ... }
 *     }
 *   }
 *
 * The operator app uses this to disable buttons whose required
 * capabilities the signed-in viewer doesn't hold — so a viewer
 * without `jobs:lifecycle` sees Pause/Archive/Reopen rendered
 * disabled with a "you don't have this capability" hint, instead
 * of clicking and getting a 403 from the backend.
 */

export interface CapabilityMatrix {
  version: string;
  base: string[];
  roles: Record<string, string[]>;
  uiControls: Record<string, string[]>;
  automationActions: Record<string, string[]>;
}

export interface AuthSession {
  wallet: string;
  roles: string[];
  capabilities: string[];
  capabilityMatrix: CapabilityMatrix;
}

/** Parse the `/auth/session` payload. Returns `undefined` for missing
 *  / malformed responses so callers can treat "unauthenticated" and
 *  "not loaded yet" the same way. */
export function buildAuthSession(payload: unknown): AuthSession | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const wallet = text(root.wallet);
  if (!wallet) return undefined;
  const matrix = buildCapabilityMatrix(root.capabilityMatrix);
  return {
    wallet,
    roles: stringArray(root.roles),
    capabilities: stringArray(root.capabilities),
    capabilityMatrix: matrix,
  };
}

function buildCapabilityMatrix(raw: unknown): CapabilityMatrix {
  const record = asRecord(raw);
  if (!record) {
    return {
      version: "0",
      base: [],
      roles: {},
      uiControls: {},
      automationActions: {},
    };
  }
  return {
    version: text(record.version, "0"),
    base: stringArray(record.base),
    roles: stringMap(record.roles),
    uiControls: stringMap(record.uiControls),
    automationActions: stringMap(record.automationActions),
  };
}

export interface ControlGate {
  /** True when the viewer can fire this control. False when missing
   *  capabilities (or when the session itself isn't loaded yet). */
  allowed: boolean;
  /** Capabilities the control needs (from the matrix). Empty array
   *  for unknown controls — those are treated as allowed by default
   *  so a new control name doesn't silently break. */
  required: string[];
  /** Capabilities the viewer is missing relative to `required`. */
  missing: string[];
  /** Human-readable hint suitable for a button's `title` attribute. */
  reason?: string;
}

/**
 * Decide whether the current viewer can use a control.
 *
 * `controlName` matches a key in `capabilityMatrix.uiControls`
 * (e.g. `admin.jobs.lifecycle`, `admin.jobs.fireRecurring`). Unknown
 * control names default to allowed — the matrix is the source of
 * truth and an unmapped control means there's no gate to enforce.
 */
export function canUseControl(
  session: AuthSession | undefined,
  controlName: string
): ControlGate {
  if (!session) {
    return {
      allowed: false,
      required: [],
      missing: [],
      reason: "Sign in to enable operator actions",
    };
  }
  const required = session.capabilityMatrix.uiControls[controlName] ?? [];
  if (required.length === 0) {
    // No mapping → no gate. Lets new controls land additively.
    return { allowed: true, required: [], missing: [] };
  }
  const have = new Set(session.capabilities);
  const missing = required.filter((cap) => !have.has(cap));
  if (missing.length === 0) {
    return { allowed: true, required, missing: [] };
  }
  return {
    allowed: false,
    required,
    missing,
    reason: `Missing capability: ${missing.join(", ")}`,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      out.push(entry.trim());
    }
  }
  return out;
}

function stringMap(value: unknown): Record<string, string[]> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(record)) {
    out[key] = stringArray(raw);
  }
  return out;
}
