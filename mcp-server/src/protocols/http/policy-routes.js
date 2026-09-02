import { ValidationError } from "../../core/errors.js";

export function createPolicyRoutes({
  authMiddleware,
  buildPolicyProposal,
  eventBus,
  findPolicy,
  listPolicies,
  policyService,
  readJsonBody,
  respond,
}) {
  return async function handlePolicyRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/policies") {
      await authMiddleware(request, url);
      respond(response, 200, listPolicies());
      return true;
    }

    if (request.method === "POST" && pathname === "/policies") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      const payload = await readJsonBody(request);
      const proposal = buildPolicyProposal(payload, auth);
      // Package G — PolicyService.propose updates the cache synchronously
      // and enqueues a write-through persist against the state-store.
      policyService.propose(proposal);
      eventBus?.publish({
        id: `policy-proposal-${proposal.id}-${Date.now()}`,
        topic: "policy.proposed",
        wallet: auth.wallet,
        wallets: [auth.wallet],
        timestamp: new Date().toISOString(),
        data: { tag: proposal.tag, status: proposal.state }
      });
      respond(response, 201, proposal);
      return true;
    }

    if (request.method === "GET" && pathname.startsWith("/policies/")) {
      await authMiddleware(request, url);
      const tag = decodeURIComponent(pathname.slice("/policies/".length));
      if (!tag) {
        throw new ValidationError("policy tag path segment is required.");
      }
      const policy = findPolicy(tag);
      if (!policy) {
        respond(response, 404, { status: "not_found", tag });
        return true;
      }
      respond(response, 200, policy);
      return true;
    }

    return false;
  };
}
