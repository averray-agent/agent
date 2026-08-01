import { hasRole } from "../../auth/config.js";
import { AuthenticationError } from "../../core/errors.js";
import { normalizePosterReviewDecision } from "../../core/poster-review-service.js";

export function createPosterReviewRoutes({
  authMiddleware,
  enforceLimit,
  posterReviewService,
  rateLimitConfig,
  readJsonBody,
  respond
}) {
  return async function handlePosterReviewRoute({
    request,
    response,
    url,
    pathname
  }) {
    const submissionMatch = pathname.match(/^\/jobs\/([^/]+)\/submission$/u);
    if (request.method === "GET" && submissionMatch) {
      const auth = await authMiddleware(request, url);
      requireSiweWalletSession(auth);
      await enforceLimit(
        "external_reviews",
        auth.wallet,
        rateLimitConfig.externalReviews
      );
      respond(
        response,
        200,
        await posterReviewService.getSubmissionForReview(
          decodeURIComponent(submissionMatch[1]),
          {
            wallet: auth.wallet,
            isAdmin: hasRole(auth.claims, "admin")
          }
        )
      );
      return true;
    }

    const reviewMatch = pathname.match(/^\/jobs\/([^/]+)\/review$/u);
    if (request.method === "POST" && reviewMatch) {
      const auth = await authMiddleware(request, url);
      requireSiweWalletSession(auth);
      await enforceLimit(
        "external_reviews",
        auth.wallet,
        rateLimitConfig.externalReviews
      );
      const payload = normalizePosterReviewDecision(await readJsonBody(request));
      respond(
        response,
        200,
        await posterReviewService.reviewSubmission(
          decodeURIComponent(reviewMatch[1]),
          {
            wallet: auth.wallet,
            isAdmin: hasRole(auth.claims, "admin"),
            ...payload
          }
        )
      );
      return true;
    }

    return false;
  };
}

function requireSiweWalletSession(auth) {
  if (auth?.claims?.serviceToken === true || auth?.claims?.tokenKind === "service") {
    throw new AuthenticationError(
      "Poster review requires a SIWE wallet session.",
      "poster_review_siwe_required"
    );
  }
}
