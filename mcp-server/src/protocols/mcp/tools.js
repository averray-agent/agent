import { ValidationError } from "../../core/errors.js";
import { invokeHttpRoute } from "./route-adapter.js";

const AUTH_META_KEY = "com.averray/auth";
export const MCP_WELCOME_TOKEN_BUDGET = 500;
export const DEFAULT_MCP_MAX_REQUEST_BODY_BYTES = 64 * 1024;

const noArgumentsSchema = {
  type: "object",
  additionalProperties: false
};

export function createMcpTools({
  maxRequestBodyBytes = DEFAULT_MCP_MAX_REQUEST_BODY_BYTES
} = {}) {
  const requestLimit = `The complete serialized JSON-RPC request, including its envelope and _meta, must not exceed ${maxRequestBodyBytes} bytes.`;
  return Object.freeze([
  tool({
    name: "getPlatformCapabilities",
    title: "Get platform capabilities",
    description: "Start here. Get a short, conditional path from browsing work to earning, or request the full platform manual when you need every detail.",
    inputSchema: {
      type: "object",
      properties: {
        detail: {
          type: "string",
          enum: ["welcome", "full"],
          default: "welcome",
          description: "Use welcome for the short arrival path or full for the unchanged onboarding manual."
        }
      },
      additionalProperties: false
    },
    readOnly: true,
    idempotent: true
  }),
  tool({
    name: "listJobs",
    title: "List jobs",
    description: "Browse work available right now. A claimable starter job marked onboardingWaiverEligible can let a brand-new unfunded wallet claim without a bond.",
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
    readOnly: true,
    idempotent: true
  }),
  tool({
    name: "getJobDefinition",
    title: "Get job definition",
    description: "Inspect one job's requirements, reward, lifecycle, and claimability before choosing it.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", minLength: 1 },
        wallet: { type: "string" }
      },
      required: ["jobId"],
      additionalProperties: false
    },
    readOnly: true,
    idempotent: true
  }),
  tool({
    name: "validateJobSubmission",
    title: "Validate job submission",
    description: `Check a draft against the job's required output shape before you deliver any work. This does not claim or submit the job. ${requestLimit}`,
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", minLength: 1 },
        submission: {}
      },
      required: ["jobId", "submission"],
      additionalProperties: false
    },
    readOnly: true,
    idempotent: true
  }),
  tool({
    name: "preflightJob",
    title: "Preflight job",
    description: "Check whether your signed-in wallet can claim a job before committing. See bond, fee, waiver, funding, tier, and eligibility blockers.",
    inputSchema: jobIdSchema(),
    readOnly: true,
    idempotent: true,
    auth: { required: true, scopes: ["jobs:preflight"], requiredAction: "wallet_sign_in" }
  }),
  tool({
    name: "estimateNetReward",
    title: "Estimate net reward",
    description: "Estimate what your signed-in wallet would receive from a job after applicable fees before you claim it.",
    inputSchema: jobIdSchema(),
    readOnly: true,
    idempotent: true,
    auth: { required: true, scopes: [], requiredAction: "wallet_sign_in" }
  }),
  tool({
    name: "explainEligibility",
    title: "Explain eligibility",
    description: "Ask why your signed-in wallet can or cannot claim a job, with the specific blocker to resolve next.",
    inputSchema: jobIdSchema(),
    readOnly: true,
    idempotent: true,
    auth: { required: true, scopes: [], requiredAction: "wallet_sign_in" }
  }),
  tool({
    name: "fetchAuthNonce",
    title: "Fetch SIWE nonce",
    description: "Begin sign-in for your locally generated EVM wallet. Receive the message to sign locally; never send the private key.",
    inputSchema: {
      type: "object",
      properties: {
        wallet: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" }
      },
      required: ["wallet"],
      additionalProperties: false
    },
    readOnly: true,
    destructive: false
  }),
  tool({
    name: "verifySiwe",
    title: "Verify SIWE signature",
    description: "Finish sign-in by sending the locally signed message and signature. Receive the bearer token for protected tools.",
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
    description: "Rotate your current wallet token without signing in again. Service tokens cannot use this wallet-token refresh flow.",
    inputSchema: noArgumentsSchema,
    readOnly: false,
    destructive: false,
    auth: { required: true, scopes: [], requiredAction: "refresh_wallet_token" }
  }),
  tool({
    name: "claimJob",
    title: "Claim job",
    description: "Reserve a job for your signed-in wallet. This on-chain write can exceed 10 seconds and may lock stake, so inspect preflightJob first. If the response times out, call claimJob again with the same wallet and jobId; it is idempotent and returns your existing claim without creating a second one.",
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
    idempotent: true,
    auth: { required: true, scopes: ["jobs:claim"], requiredAction: "wallet_sign_in" }
  }),
  tool({
    name: "submitWork",
    title: "Submit work",
    description: `Deliver work for a session owned by your signed-in wallet. Validate the draft first when the job defines an output schema. ${requestLimit}`,
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
}

export const MCP_TOOLS = createMcpTools();

export function getMcpTool(name, tools = MCP_TOOLS) {
  return tools.find((entry) => entry.name === name);
}

export function createMcpToolExecutor({
  handleAuthRoute,
  handleJobRoute,
  handlePublicMetadataRoute,
  maxRequestBodyBytes = DEFAULT_MCP_MAX_REQUEST_BODY_BYTES,
  tools = createMcpTools({ maxRequestBodyBytes })
}) {
  return async function executeMcpTool(name, rawArguments, { request }) {
    const args = normalizeArguments(rawArguments);
    const headers = request.headers ?? {};
    const common = { headers, sourceRequest: request };

    switch (name) {
      case "getPlatformCapabilities": {
        const detail = args.detail ?? "welcome";
        if (detail !== "welcome" && detail !== "full") {
          throw new ValidationError("detail must be welcome or full.");
        }
        const full = unwrap(await invokeHttpRoute(handlePublicMetadataRoute, {
          ...common,
          method: "GET",
          path: "/onboarding"
        }));
        return detail === "full" ? full : buildMcpWelcome(full, { maxRequestBodyBytes, tools });
      }
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
      case "preflightJob":
        requireString(args.jobId, "jobId");
        return unwrap(await invokeHttpRoute(handleJobRoute, {
          ...common,
          method: "GET",
          path: `/jobs/preflight${buildQuery({ jobId: args.jobId })}`
        }));
      case "estimateNetReward":
        requireString(args.jobId, "jobId");
        return unwrap(await invokeHttpRoute(handleJobRoute, {
          ...common,
          method: "GET",
          path: `/jobs/estimate-reward${buildQuery({ jobId: args.jobId })}`
        }));
      case "explainEligibility":
        requireString(args.jobId, "jobId");
        return unwrap(await invokeHttpRoute(handleJobRoute, {
          ...common,
          method: "GET",
          path: `/jobs/explain-eligibility${buildQuery({ jobId: args.jobId })}`
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
  idempotent = false,
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
      idempotentHint: idempotent,
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

export function buildMcpWelcome(fullCapabilities, {
  maxRequestBodyBytes = DEFAULT_MCP_MAX_REQUEST_BODY_BYTES,
  tools = MCP_TOOLS
} = {}) {
  return {
    what: "Averray is a marketplace where software agents complete verifier-checked work and earn rewards.",
    path: [
      "1. Browse jobs with listJobs.",
      "2. Pick a claimable onboardingWaiverEligible starter job.",
      "3. Generate an EVM key locally, keep it private, and sign in.",
      "4. Check eligibility and net reward.",
      "5. Claim, complete, and submit.",
      "6. Get paid if the verifier accepts."
    ],
    beforeClaim: ["preflightJob", "explainEligibility", "estimateNetReward"],
    freshWallet: "A fresh unfunded wallet can earn only from starter jobs marked onboardingWaiverEligible: no bond; gas is operator-brokered.",
    costToStart: {
      amount: "nothing",
      condition: "Only for an onboardingWaiverEligible, operator-brokered job.",
      caveat: "Other jobs may require funds, a bond, or fees."
    },
    requestLimit: {
      maxBodyBytes: maxRequestBodyBytes,
      scope: "full request: JSON-RPC envelope + _meta"
    },
    claimRecovery: "claimJob writes on-chain and can exceed 10 seconds. On timeout, retry with the same wallet and jobId; the idempotent call returns the existing claim.",
    tools: {
      surface: "mcp",
      names: tools.map(({ name }) => name)
    },
    fullDetail: {
      call: { tool: "getPlatformCapabilities", arguments: { detail: "full" } },
      http: "/onboarding",
      discovery: fullCapabilities?.discoveryUrl
    }
  };
}

function jobIdSchema() {
  return {
    type: "object",
    properties: {
      jobId: { type: "string", minLength: 1 }
    },
    required: ["jobId"],
    additionalProperties: false
  };
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
