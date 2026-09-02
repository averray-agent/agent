export const SHARE_SURFACES = Object.freeze({
  agent: "agent",
  session: "session",
  dispute: "dispute",
  policy: "policy"
});

export function buildShareHref(appPath, origin) {
  const path = String(appPath ?? "").trim();
  if (path !== "/share" && !path.startsWith("/share?")) return null;
  const base = String(origin ?? "").replace(/\/+$/u, "");
  return base ? `${base}${path}` : path;
}

export function labelForShareSurface(surface) {
  switch (surface) {
    case SHARE_SURFACES.agent:
      return "Agent profile";
    case SHARE_SURFACES.session:
      return "Session audit trail";
    case SHARE_SURFACES.dispute:
      return "Dispute snapshot";
    case SHARE_SURFACES.policy:
      return "Policy snapshot";
    default:
      return "Read-only snapshot";
  }
}
