import { hashCanonicalContent } from "../core/canonical-content.js";
import { ValidationError } from "../core/errors.js";
import {
  MCP_FAILURE_SEMANTICS_CHECKS,
  MCP_FAILURE_SEMANTICS_PROFILE_REF
} from "./verification-profile-registry.js";
import {
  EgressPolicyDeniedError,
  McpHttpStatusError,
  McpProbeTransport,
  McpProtocolError,
  ProbeTimeoutError,
  TargetAuthenticationError,
  TargetUnavailableError
} from "./mcp-probe-transport.js";

const SUITE_META = "averray/verification";
const CHECK_TIMEOUT_MS = 3_000;
const MIN_TIMEOUT_PROBE_MS = 100;

export class McpFailureSemanticsRunner {
  constructor({ transportFactory = (options) => new McpProbeTransport(options), allowInsecureHttp = false } = {}) {
    this.transportFactory = transportFactory;
    this.allowInsecureHttp = allowInsecureHttp;
  }

  validate({ profile, target, inputs, credential }) {
    if (profile?.ref !== MCP_FAILURE_SEMANTICS_PROFILE_REF) {
      throw new ValidationError(`MCP prober cannot execute profile ${profile?.ref ?? "missing"}.`);
    }
    if (inputs && Object.keys(inputs).length !== 0) {
      throw new ValidationError("mcp-failure-semantics-v1 executes the fixed suite and accepts no customer probe code or commands.");
    }
    if (target?.auth && !String(credential ?? "").trim()) {
      throw new ValidationError("The declared credentialRef requires a scoped credential for this run.");
    }
    if (!target?.auth && credential !== undefined) {
      throw new ValidationError("A scoped credential is accepted only when target.auth declares its ephemeral use.");
    }
    return true;
  }

  async run({ profile, runId, target, inputs = {}, credential, egressGrant, proxyUrl }) {
    this.validate({ profile, target, inputs, credential });
    const transport = this.transportFactory({
      endpoint: target.endpoint,
      transport: target.transport,
      proxyUrl,
      egressGrant,
      credential,
      timeoutMs: Math.min(CHECK_TIMEOUT_MS, profile.limits.timeoutMs),
      allowInsecureHttp: this.allowInsecureHttp
    });
    const checks = [];
    for (const name of MCP_FAILURE_SEMANTICS_CHECKS) {
      try {
        checks.push(await CHECKS[name]({ transport, target }));
      } catch (error) {
        if (error instanceof EgressPolicyDeniedError) {
          return platformFaultExecution({ runId, target, checks, attemptedCheck: name });
        }
        if (error instanceof TargetUnavailableError || error instanceof ProbeTimeoutError) {
          checks.push(checkResult(name, "inconclusive", "target_unreachable", "The endpoint was unreachable during this named check."));
          continue;
        }
        if (error instanceof TargetAuthenticationError || isAuthProtocolError(error)) {
          checks.push(checkResult(name, "inconclusive", "ambiguous_evidence", "The scoped endpoint authentication could not be completed."));
          continue;
        }
        checks.push(checkResult(name, "inconclusive", "runner_fault", "The fixed prober could not complete this named check."));
      }
    }

    const report = buildReport({ runId, target, checks });
    const inconclusive = checks.find((check) => check.verdict === "inconclusive");
    const common = executionIdentity({ target, report });
    if (inconclusive) {
      return {
        ...common,
        status: "inconclusive",
        reason: inconclusive.reason,
        detail: `The ${inconclusive.name} check was inconclusive; no fee is due.`
      };
    }
    return {
      ...common,
      status: "decidable",
      evidence: checks.filter((check) => check.verdict === "pass").map((check) => evidenceToken(check.name)).join(" ")
    };
  }
}

const CHECKS = Object.freeze({
  "auth-boundary": async ({ transport, target }) => {
    if (!target.auth) {
      return checkResult("auth-boundary", "pass", "no_auth_required_declared", "The endpoint declared no authenticated boundary; no protected tool claim was made.");
    }
    const session = transport.createSession({ authenticated: false });
    try {
      await session.initialize();
      const tools = await listTools(session);
      const tool = tools.find((candidate) => suiteMeta(candidate)?.authProbe?.arguments);
      if (!tool) {
        return checkResult("auth-boundary", "inconclusive", "ambiguous_evidence", "No fixed-suite authenticated tool probe annotation was declared.");
      }
      try {
        await session.request("tools/call", {
          name: tool.name,
          arguments: structuredClone(suiteMeta(tool).authProbe.arguments)
        });
        return checkResult("auth-boundary", "fail", "unauthenticated_request_served", "The declared authenticated tool served the fixed unauthenticated probe.");
      } catch (error) {
        if (error instanceof TargetAuthenticationError || isAuthProtocolError(error)) {
          return checkResult("auth-boundary", "pass", "unauthenticated_request_rejected", "The declared authenticated tool rejected the unauthenticated probe.");
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof TargetAuthenticationError || isAuthProtocolError(error)) {
        return checkResult("auth-boundary", "pass", "unauthenticated_request_rejected", "The declared authenticated boundary rejected an unauthenticated request.");
      }
      throw error;
    } finally {
      await session.close();
    }
  },

  "timeout-recovery": async ({ transport }) => withInitializedSession(transport, async (session) => {
    const tools = await listTools(session);
    const tool = tools.find((candidate) => suiteMeta(candidate)?.timeoutProbe?.arguments);
    if (!tool) return checkResult("timeout-recovery", "inconclusive", "ambiguous_evidence", "No fixed-suite timeout probe annotation was declared.");
    const startedAt = Date.now();
    try {
      await session.request("tools/call", {
        name: tool.name,
        arguments: structuredClone(suiteMeta(tool).timeoutProbe.arguments)
      }, { timeoutMs: CHECK_TIMEOUT_MS });
      return checkResult("timeout-recovery", "fail", "slow_tool_returned_success", "The annotated timeout probe returned success instead of its declared structured timeout error.");
    } catch (error) {
      if (error instanceof McpProtocolError && wellFormedProtocolError(error)) {
        if (Date.now() - startedAt < MIN_TIMEOUT_PROBE_MS) {
          return checkResult("timeout-recovery", "fail", "timeout_probe_not_exercised", "The annotated slow-tool probe returned before the fixed minimum observation window.");
        }
        try {
          await listTools(session);
        } catch (recoveryError) {
          if (recoveryError instanceof TargetUnavailableError || recoveryError instanceof ProbeTimeoutError) {
            throw recoveryError;
          }
          return checkResult("timeout-recovery", "fail", "session_not_recovered", "The slow-tool error was structured, but the MCP session did not remain usable afterward.");
        }
        return checkResult("timeout-recovery", "pass", "structured_timeout_error", `The endpoint returned a structured timeout error in ${Date.now() - startedAt}ms.`);
      }
      if (error instanceof ProbeTimeoutError) {
        return checkResult("timeout-recovery", "fail", "transport_hung", "The annotated slow tool hung beyond the fixed probe deadline.");
      }
      throw error;
    }
  }),

  "tool-schema-stability": async ({ transport }) => withInitializedSession(transport, async (session) => {
    const tools = await listTools(session);
    const candidates = tools.map((tool) => ({ tool, invalid: buildInvalidArguments(tool?.inputSchema) }));
    const selected = candidates.find(({ invalid }) => invalid !== undefined);
    const tool = selected?.tool;
    if (!tool) return checkResult("tool-schema-stability", "inconclusive", "ambiguous_evidence", "The endpoint exposed no object input schema to probe.");
    try {
      await session.request("tools/call", { name: tool.name, arguments: selected.invalid });
      return checkResult("tool-schema-stability", "fail", "malformed_input_served", "The endpoint accepted input outside the declared tool schema.");
    } catch (error) {
      if (error instanceof McpProtocolError && wellFormedProtocolError(error)) {
        return checkResult("tool-schema-stability", "pass", "malformed_input_rejected", "Malformed input was rejected with a structured MCP error.");
      }
      if (error instanceof McpHttpStatusError && error.statusCode >= 500) {
        return checkResult("tool-schema-stability", "fail", "malformed_input_crashed_transport", "Malformed input produced an HTTP server failure instead of an MCP error.");
      }
      throw error;
    }
  }),

  "destructive-action-safety": async ({ transport }) => withInitializedSession(transport, async (session) => {
    const tools = await listTools(session);
    const tool = tools.find((candidate) => candidate?.annotations?.destructiveHint === true);
    if (!tool) return checkResult("destructive-action-safety", "inconclusive", "ambiguous_evidence", "No destructive tool annotation was declared for the fixed omission probe.");
    const meta = suiteMeta(tool);
    if (!meta?.destructiveProbe?.argumentsWithoutConfirmation) {
      return checkResult("destructive-action-safety", "inconclusive", "ambiguous_evidence", "The destructive annotation omitted bounded no-confirmation probe arguments.");
    }
    try {
      await session.request("tools/call", {
        name: tool.name,
        arguments: structuredClone(meta.destructiveProbe.argumentsWithoutConfirmation)
      });
      return checkResult("destructive-action-safety", "fail", "destructive_call_without_confirmation", "The destructive tool returned success without its declared confirmation.");
    } catch (error) {
      if (error instanceof McpProtocolError && wellFormedProtocolError(error)) {
        return checkResult("destructive-action-safety", "pass", "confirmation_required", "The destructive tool rejected the fixed omission probe with a structured MCP error.");
      }
      throw error;
    }
  }),

  "error-shape-conformance": async ({ transport }) => withInitializedSession(transport, async (session) => {
    try {
      await session.request("tools/call", { name: "__averray_missing_tool_v1__", arguments: {} });
      return checkResult("error-shape-conformance", "fail", "missing_tool_served", "The endpoint served a tool name it did not declare.");
    } catch (error) {
      if (error instanceof McpHttpStatusError) {
        return checkResult("error-shape-conformance", "fail", "non_mcp_error_shape", "The endpoint returned an HTTP error instead of a well-formed MCP JSON-RPC error.");
      }
      if (!(error instanceof McpProtocolError) || !wellFormedProtocolError(error)) {
        return checkResult("error-shape-conformance", "fail", "non_mcp_error_shape", "The endpoint did not return a well-formed MCP JSON-RPC error.");
      }
      if (leaksImplementationDetail(error)) {
        return checkResult("error-shape-conformance", "fail", "implementation_detail_leak", "The MCP error exposed a stack trace, provider detail, or credential-shaped value.");
      }
      return checkResult("error-shape-conformance", "pass", "bounded_mcp_error", "The endpoint returned a bounded MCP protocol error without implementation leakage.");
    }
  })
});

async function withInitializedSession(transport, operation) {
  const session = transport.createSession({ authenticated: true });
  try {
    await session.initialize();
    return await operation(session);
  } finally {
    await session.close();
  }
}

async function listTools(session) {
  const result = await session.request("tools/list", {});
  if (!Array.isArray(result?.tools)) throw new Error("MCP tools/list omitted its tools array.");
  return result.tools;
}

function suiteMeta(tool) {
  const value = tool?._meta?.[SUITE_META];
  return value && typeof value === "object" && !Array.isArray(value) && Number(value.suiteVersion) === 1
    ? value
    : undefined;
}

function buildInvalidArguments(schema) {
  if (!schema || schema.type !== "object" || typeof schema !== "object") return undefined;
  if (schema.additionalProperties === false) return { __averray_invalid_v1: true };
  for (const name of schema.required ?? []) {
    const property = schema.properties?.[name];
    if (!property || typeof property !== "object") continue;
    if (Array.isArray(property.enum) && property.enum.length > 0) {
      let candidate = "__averray_outside_enum_v1__";
      while (property.enum.includes(candidate)) candidate += "_";
      return { [name]: candidate };
    }
    const invalidByType = {
      string: 7,
      number: "not-a-number",
      integer: "not-an-integer",
      boolean: "not-a-boolean",
      array: {},
      object: "not-an-object"
    };
    if (Object.hasOwn(invalidByType, property.type)) return { [name]: invalidByType[property.type] };
  }
  return undefined;
}

function checkResult(name, verdict, reason, detail) {
  return Object.freeze({ name, verdict, reason, detail });
}

function evidenceToken(name) {
  return `mcp_${name.replaceAll("-", "_")}_pass`;
}

function wellFormedProtocolError(error) {
  return Number.isInteger(error?.code) && typeof error?.message === "string" && error.message.trim().length > 0;
}

function isAuthProtocolError(error) {
  return error instanceof McpProtocolError && new Set([-32001, -32002]).has(error.code);
}

function leaksImplementationDetail(error) {
  const material = JSON.stringify({ message: error?.message, data: error?.data });
  return /(?:\bstack\b|traceback|\bat\s+[^\s]+\s*\([^)]*:\d+:\d+\)|authorization\s*[:=]\s*bearer|api[_-]?key|secret[_-]?access[_-]?key|sk-[a-z0-9])/iu.test(material);
}

function buildReport({ runId, target, checks }) {
  const endpoint = new URL(target.endpoint);
  return {
    schemaVersion: "averray.mcp-failure-semantics.v1",
    suite: MCP_FAILURE_SEMANTICS_PROFILE_REF,
    runId,
    observedAt: new Date().toISOString(),
    endpoint: `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`,
    transport: target.transport,
    checks: checks.map((check) => ({ ...check }))
  };
}

function executionIdentity({ target, report }) {
  return {
    report,
    artifactHash: hashCanonicalContent({ endpoint: target.endpoint, transport: target.transport }),
    sourceBinding: { method: "live_mcp_endpoint", verified: true, ref: target.endpoint },
    environment: {
      kind: "averray_mcp_prober",
      suite: MCP_FAILURE_SEMANTICS_PROFILE_REF,
      egress: "declared_endpoint_only"
    }
  };
}

function platformFaultExecution({ runId, target, checks, attemptedCheck }) {
  const report = buildReport({
    runId,
    target,
    checks: [
      ...checks,
      checkResult(attemptedCheck, "inconclusive", "runner_fault", "The prober attempted a destination outside its declared endpoint grant.")
    ]
  });
  return {
    ...executionIdentity({ target, report }),
    status: "platform_fault",
    reason: "runner_fault",
    detail: "The fixed prober attempted an undeclared destination and the egress boundary refused it. No fee is due."
  };
}
