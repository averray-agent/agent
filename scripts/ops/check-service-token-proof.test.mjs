import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkServiceTokenProof } from "./check-service-token-proof.mjs";

const API_BASE_URL = "https://api.example.test";
const ADMIN_TOKEN = "admin-token";
const SUBJECT = "0x1111111111111111111111111111111111111111";
const GRANT_ID = "grant-hosted-proof";

test("checkServiceTokenProof issues, uses, revokes, and redacts a scoped token", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "service-token-proof-"));
  const evidenceFile = join(tmp, "evidence.json");
  const serviceToken = "eyJservice.token.raw";
  const { fetch, calls } = fakeServiceTokenFetch({ serviceToken });

  const evidence = await checkServiceTokenProof({
    env: {
      ADMIN_JWT: ADMIN_TOKEN,
      API_BASE_URL,
      SERVICE_TOKEN_PROOF_SUBJECT: SUBJECT,
      SERVICE_TOKEN_PROOF_CAPABILITIES: "jobs:recommend",
      SERVICE_TOKEN_PROOF_DENIED_PATHS: "/account,/admin/status",
      SERVICE_TOKEN_PROOF_IDEMPOTENCY_KEY: "proof-key",
      SERVICE_TOKEN_PROOF_EVIDENCE_FILE: evidenceFile
    },
    fetchImpl: fetch,
    log: () => {},
    now: () => new Date("2026-05-16T12:00:00.000Z")
  });

  assert.equal(evidence.status, "passed");
  assert.equal(evidence.issue.grantId, GRANT_ID);
  assert.equal(evidence.revoke.grantStatus, "revoked");
  assert.equal(evidence.deniedAfterRevoke.status, 403);
  assert.equal(evidence.list.tokenPresent, false);

  const issueCall = calls.find((call) => call.method === "POST" && call.url === `${API_BASE_URL}/admin/service-tokens`);
  assert.deepEqual(issueCall.body, {
    subject: SUBJECT,
    capabilities: ["jobs:recommend"],
    scope: "hosted-smoke-service-token-proof",
    note: "hosted service-token proof",
    tokenTtlSeconds: 600,
    idempotencyKey: "proof-key:issue"
  });

  const revokeCall = calls.find((call) => call.method === "POST" && call.url === `${API_BASE_URL}/admin/service-tokens/${GRANT_ID}/revoke`);
  assert.deepEqual(revokeCall.body, {
    note: "hosted service-token proof complete",
    idempotencyKey: `proof-key:revoke:${GRANT_ID}`
  });

  const evidenceText = await readFile(evidenceFile, "utf8");
  assert.doesNotMatch(evidenceText, /eyJservice\.token\.raw/u);
  assert.doesNotMatch(evidenceText, new RegExp(ADMIN_TOKEN, "u"));
  assert.equal(JSON.parse(evidenceText).serviceSession.capabilityGrantId, GRANT_ID);
});

test("checkServiceTokenProof fails closed before network calls without ADMIN_JWT", async () => {
  const calls = [];

  await assert.rejects(
    () => checkServiceTokenProof({
      env: { API_BASE_URL },
      fetchImpl: async (...args) => {
        calls.push(args);
        throw new Error("should not fetch");
      },
      log: () => {}
    }),
    /requires ADMIN_JWT/u
  );

  assert.equal(calls.length, 0);
});

test("checkServiceTokenProof requires an admin role and grant/read/revoke capabilities", async () => {
  const { fetch } = fakeServiceTokenFetch({
    adminSession: {
      wallet: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
      roles: [],
      capabilities: ["admin:capabilities:read", "admin:capabilities:grant", "admin:capabilities:revoke", "jobs:recommend"]
    }
  });

  await assert.rejects(
    () => checkServiceTokenProof({
      env: { ADMIN_JWT: ADMIN_TOKEN, API_BASE_URL, SERVICE_TOKEN_PROOF_SUBJECT: SUBJECT },
      fetchImpl: fetch,
      log: () => {}
    }),
    /admin token must include admin role/u
  );
});

test("checkServiceTokenProof revokes during cleanup when a post-issue check fails", async () => {
  const { fetch, calls } = fakeServiceTokenFetch({ failServiceSession: true });

  await assert.rejects(
    () => checkServiceTokenProof({
      env: {
        ADMIN_JWT: ADMIN_TOKEN,
        API_BASE_URL,
        SERVICE_TOKEN_PROOF_SUBJECT: SUBJECT,
        SERVICE_TOKEN_PROOF_IDEMPOTENCY_KEY: "cleanup-key"
      },
      fetchImpl: fetch,
      log: () => {}
    }),
    /auth\/session returned HTTP 500/u
  );

  const revokeCalls = calls.filter((call) => call.method === "POST" && call.url === `${API_BASE_URL}/admin/service-tokens/${GRANT_ID}/revoke`);
  assert.equal(revokeCalls.length, 1);
  assert.equal(revokeCalls[0].body.idempotencyKey, `cleanup-key:revoke:${GRANT_ID}`);
});

test("checkServiceTokenProof rejects list projections that expose token bytes", async () => {
  const { fetch } = fakeServiceTokenFetch({ listLeaksToken: true });

  await assert.rejects(
    () => checkServiceTokenProof({
      env: { ADMIN_JWT: ADMIN_TOKEN, API_BASE_URL, SERVICE_TOKEN_PROOF_SUBJECT: SUBJECT },
      fetchImpl: fetch,
      log: () => {}
    }),
    /must not expose raw token/u
  );
});

function fakeServiceTokenFetch({
  serviceToken = "service-token-secret",
  adminSession = defaultAdminSession(),
  failServiceSession = false,
  listLeaksToken = false
} = {}) {
  const calls = [];
  let revoked = false;

  const fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const call = {
      method,
      url: String(url),
      authorization: normalizeHeaders(options.headers).authorization,
      body: options.body ? JSON.parse(options.body) : undefined
    };
    calls.push(call);

    if (call.url === `${API_BASE_URL}/auth/session` && call.authorization === `Bearer ${ADMIN_TOKEN}`) {
      return json(adminSession);
    }

    if (call.url === `${API_BASE_URL}/admin/service-tokens` && method === "POST") {
      return json({
        token: serviceToken,
        tokenType: "Bearer",
        tokenKind: "service",
        tokenAvailable: true,
        wallet: SUBJECT,
        capabilities: ["jobs:recommend"],
        expiresAt: "2026-05-16T12:10:00.000Z",
        grant: {
          id: GRANT_ID,
          subject: SUBJECT,
          status: "active",
          issuedAt: "2026-05-16T12:00:00.000Z"
        }
      }, 201);
    }

    if (call.url === `${API_BASE_URL}/auth/session` && call.authorization === `Bearer ${serviceToken}`) {
      if (failServiceSession) {
        return text("boom", 500);
      }
      return json({
        wallet: SUBJECT,
        tokenKind: "service",
        serviceToken: true,
        capabilityGrantId: GRANT_ID,
        capabilities: revoked ? [] : ["jobs:recommend"],
        roles: []
      });
    }

    if (call.url === `${API_BASE_URL}/jobs/recommendations` && call.authorization === `Bearer ${serviceToken}`) {
      return json({ jobs: [] }, revoked ? 403 : 200);
    }

    if ((call.url === `${API_BASE_URL}/account` || call.url === `${API_BASE_URL}/admin/status`) && call.authorization === `Bearer ${serviceToken}`) {
      return json({ error: "missing_capability" }, 403);
    }

    if (call.url === `${API_BASE_URL}/admin/service-tokens/${GRANT_ID}/revoke` && method === "POST") {
      revoked = true;
      return json({
        tokenKind: "service",
        tokenAvailable: false,
        status: "revoked",
        alreadyRevoked: false,
        grant: {
          id: GRANT_ID,
          subject: SUBJECT,
          status: "revoked",
          revokedAt: "2026-05-16T12:01:00.000Z"
        }
      });
    }

    if (call.url === `${API_BASE_URL}/admin/service-tokens?subject=${encodeURIComponent(SUBJECT)}&status=revoked&limit=5`) {
      return json({
        items: [{
          tokenKind: "service",
          tokenAvailable: false,
          ...(listLeaksToken ? { token: serviceToken } : {}),
          grant: {
            id: GRANT_ID,
            subject: SUBJECT,
            status: "revoked"
          }
        }],
        limit: 5,
        offset: 0
      });
    }

    return text(`unexpected ${method} ${call.url}`, 404);
  };

  return { fetch, calls };
}

function defaultAdminSession() {
  return {
    wallet: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
    roles: ["admin", "verifier"],
    capabilities: [
      "admin:capabilities:read",
      "admin:capabilities:grant",
      "admin:capabilities:revoke",
      "jobs:recommend"
    ]
  };
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function json(body, status = 200) {
  return text(JSON.stringify(body), status);
}

function text(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body
  };
}
