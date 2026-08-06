import { ValidationError } from "../../core/errors.js";
import { invokeHttpRoute } from "./route-adapter.js";

const AUTH_META_KEY = "com.averray/auth";

const noArgumentsSchema = {
  type: "object",
  additionalProperties: false
};

export const MCP_TOOLS = Object.freeze([
  tool({
    name: "getPlatformCapabilities",
    title: "Get platform capabilities",
    description: "Return Averray's live onboarding, authentication, and execution capabilities.",
    inputSchema: noArgumentsSchema,
    readOnly: true
  }),
  tool({
    name: "listJobs",
    title: "List jobs",
    description: "List the active job catalog. Filters map directly to GET /jobs.",
    inputSchema: {
      type: "object",
      properties: {
        wallet: { type: "string", description: "Optional wallet used to project wallet-specific claimability." },
        format: { type: "string", enum: ["compact", "full"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
        source: { type: "string" },
        category: { type: "string" },
        state: { type: "string" }
      },
      additionalProperties: false
    },
    readOnly: true
  }),
  tool({
    name: "getJobDefinition",
    title: "Get job definition",
    description: "Return one public job definition by id.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", minLength: 1 },
        wallet: { type: "string" }
      },
      required: ["jobId"],
      additionalProperties: false
    },
    readOnly: true
  }),
  tool({
    name: "validateJobSubmission",
    title: "Validate job submission",
    description: "Validate a draft submission against the job's output schema without claiming or submitting.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", minLength: 1 },
        submission: {}
      },
      required: ["jobId", "submission"],
      additionalProperties: false
    },
    readOnly: true
  }),
  tool({
    name: "fetchAuthNonce",
    title: "Fetch SIWE nonce",
    description: "Create the same SIWE challenge returned by POST /auth/nonce.",
    inputSchema: {
      type: "object",
      properties: {
        wallet: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }
      },
      required: ["wallet"],
      additionalProperties: false
    },
    readOnly: false,
    destructive: false
  }),
  tool({
    name: "verifySiwe",
    title: "Verify SIWE signature",
    description: "Submit a signed SIWE message and receive the same bearer token returned by POST /auth/verify.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: 4096 },
        signature: { type: "string", minLength: 130, maxLength: 134 }
      },
      required: ["message", "signature"],
      additionalProperties: false
    },
    readOnly: false,
    destructive: false
  }),
  tool({
    name: "refreshAuthToken",
    title: "Refresh wallet token",
    description: "Rotate the current wallet bearer token through the same path as POST /auth/refresh. Requires authentication; service tokens are not refreshable.",
    inputSchema: noArgumentsSchema,
    readOnly: false,
    destructive: true,
    auth: { required: true, scopes: [], requiredAction: "refresh_wallet_token" }
  }),
  tool({
    name: "claimJob",
    title: "Claim job",
    description: "Claim a job for the authenticated wallet. Requires authentication with scope jobs:claim.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", minLength: 1 },
        idempotencyKey: { type: "string", minLength: 1 }
      },
      required: ["jobId"],
      additionalProperties: false
    },
    readOnly: false,
    destructive: false,
    auth: { required: true, scopes: ["jobs:claim"], requiredAction: "wallet_sign_in" }
  }),
  tool({
    name: "submitWork",
    title: "Submit work",
    description: "Submit work for a session owned by the authenticated wallet. Requires authentication with scope jobs:submit.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1 },
        submission: {},
        evidence: { type: "string" }
      },
      required: ["sessionId"],
      additionalProperties: false
    },
    readOnly: false,
    destructive: false,
    auth: { required: true, scopes: ["jobs:submit"], requiredAction: "wallet_sign_in" }
  })
]);

export function getMcpTool(name) {
  return MCP_TOOLS.find((entry) => entry.name === name);
}

export function createMcpToolExecutor({
  handleAuthRoute,
  handleJobRoute,
  handlePublicMetadataRoute
}) {
  return async function executeMcpTool(name, rawArguments, { request }) {
    const args = normalizeArguments(rawArguments);
    const headers = request.headers ?? {};
    const common = { headers, sourceRequest: request };

    switch (name) {
      case "getPlatformCapabilities":
        return unwrap(await invokeHttpRoute(handlePublicMetadataRoute, {
          ...common,
          method: "GET",
          path: "/onboarding"
        }));
      case "listJobs":
        return unwrap(await invokeHttpRoute(handleJobRoute, {
          ...common,
          method: "GET",
          path: `/jobs${buildQuery(args)}`
        }));
      case "getJobDefinition":
        requireString(args.jobId, "jobId");
        return unwrap(await invokeHttpRoute(handleJobRoute, {
          ...common,
          method: "GET",
          path: `/jobs/definition${buildQuery({ jobId: args.jobId, wallet: args.wallet })}`
        }));
      case "validateJobSubmission":
        requireString(args.jobId, "jobId");
        if (!Object.hasOwn(args, "submission")) {
          throw new ValidationError("submission is required.");
        }
        return unwrap(await invokeHttpRoute(handleJobRoute, {
          ...common,
          body: { jobId: args.jobId, submission: args.submission },
          method: "POST",
          path: "/jobs/validate-submission"
        }));
      case "fetchAuthNonce":
        requireString(args.wallet, "wallet");
        return unwrap(await invokeHttpRoute(handleAuthRoute, {
          ...common,
          body: { wallet: args.wallet },
          method: "POST",
          path: "/auth/nonce"
        }));
      case "verifySiwe":
        requireString(args.message, "message");
        requireString(args.signature, "signature");
        return unwrap(await invokeHttpRoute(handleAuthRoute, {
          ...common,
          body: { message: args.message, signature: args.signature },
          method: "POST",
          path: "/auth/verify"
        }));
      case "refreshAuthToken":
        return unwrap(await invokeHttpRoute(handleAuthRoute, {
          ...common,
          headers: { ...headers, cookie: undefined },
          body: {},
          method: "POST",
          path: "/auth/refresh"
        }));
      case "claimJob":
        requireString(args.jobId, "jobId");
        return unwrap(await invokeHttpRoute(handleJobRoute, {
          ...common,
          body: { jobId: args.jobId, idempotencyKey: args.idempotencyKey },
          method: "POST",
          path: "/jobs/claim"
        }));
      case "submitWork":
        requireString(args.sessionId, "sessionId");
        return unwrap(await invokeHttpRoute(handleJobRoute, {
          ...common,
          body: {
            sessionId: args.sessionId,
            ...(Object.hasOwn(args, "submission") ? { submission: args.submission } : {}),
            ...(Object.hasOwn(args, "evidence") ? { evidence: args.evidence } : {})
          },
          method: "POST",
          path: "/jobs/submit"
        }));
      default:
        throw new ValidationError(`Unknown tool: ${name}`);
    }
  };
}

function tool({
  auth = { required: false, scopes: [] },
  description,
  destructive = false,
  inputSchema,
  name,
  readOnly,
  title
}) {
  return Object.freeze({
    name,
    title,
    description,
    inputSchema,
    annotations: {
      title,
      readOnlyHint: readOnly,
      destructiveHint: destructive,
      idempotentHint: false,
      openWorldHint: false
    },
    _meta: {
      [AUTH_META_KEY]: {
        scheme: "SIWE_JWT",
        required: auth.required === true,
        scopes: auth.scopes ?? [],
        ...(auth.requiredAction ? { requiredAction: auth.requiredAction } : {})
      }
    }
  });
}

function normalizeArguments(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Tool arguments must be an object.");
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${name} is required.`);
  }
}

function buildQuery(values) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(name, String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

function unwrap(result) {
  if (result.statusCode >= 400) {
    throw new ValidationError(result.body?.message ?? `HTTP handler returned ${result.statusCode}.`, result.body);
  }
  return result.body;
}
