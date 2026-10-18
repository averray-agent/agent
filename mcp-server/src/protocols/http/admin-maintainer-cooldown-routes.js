import { ValidationError } from "../../core/errors.js";
import { positiveGithubRepoId } from "../../core/maintainer-repo-claim-cap.js";

const CLEAR_PATH = /^\/admin\/maintainer-repos\/([1-9]\d*)\/cooldown\/clear$/u;

export function createAdminMaintainerCooldownRoutes({
  authMiddleware,
  readJsonBody,
  respond,
  service
}) {
  return async function handleAdminMaintainerCooldownRoute({ request, response, url, pathname }) {
    const match = pathname.match(CLEAR_PATH);
    if (!match) return false;
    if (request.method !== "POST") return false;

    const auth = await authMiddleware(request, url, { requireCapability: "jobs:lifecycle" });
    const payload = await readJsonBody(request);
    const reason = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.reason : undefined;
    if (typeof reason !== "string" || !reason.trim()) {
      throw new ValidationError("A clear reason is required.");
    }
    const repoId = positiveGithubRepoId(match[1]);
    if (!repoId) throw new ValidationError("Repository id must be a positive GitHub repository id.");
    const cleared = await service.clearMaintainerRepoCooldown({
      repoId,
      actor: auth?.wallet,
      reason
    });
    respond(response, 200, cleared);
    return true;
  };
}
