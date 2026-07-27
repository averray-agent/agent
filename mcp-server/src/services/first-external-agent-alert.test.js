import assert from "node:assert/strict";
import test from "node:test";

import { EventBus } from "../core/event-bus.js";
import { ConfigError } from "../core/errors.js";
import { MemoryStateStore } from "../core/state-store.js";
import {
  FirstExternalAgentAlertService,
  isExternalAgentJobId,
  loadFirstExternalAgentAlertConfig,
} from "./first-external-agent-alert.js";

const WALLET = "0x1234567890123456789012345678901234567890";

function settlementEvent(overrides = {}) {
  return {
    id: "settlement-session-1",
    topic: "settlement.session_resolved",
    wallet: WALLET,
    jobId: "github-external-job-1",
    sessionId: "session-1",
    timestamp: "2026-07-27T10:00:00.000Z",
    data: { status: "resolved", outcome: "approved" },
    ...overrides,
  };
}

function makeHarness({
  fetchImpl = async () => ({ ok: true, status: 200 }),
  stateStore = new MemoryStateStore(),
} = {}) {
  const eventBus = new EventBus({ eventStore: stateStore });
  const logs = [];
  const service = new FirstExternalAgentAlertService(
    stateStore,
    eventBus,
    {
      enabled: true,
      webhookUrl: "https://alerts.example.test/webhook",
      environment: "mainnet",
      fetchImpl,
      now: () => new Date("2026-07-27T10:01:00.000Z"),
      logger: {
        info(fields, message) {
          logs.push({ level: "info", fields, message });
        },
        warn(fields, message) {
          logs.push({ level: "warn", fields, message });
        },
      },
    }
  );
  return { eventBus, logs, service, stateStore };
}

test("worker-canary settlements never fire the external-agent webhook", async () => {
  const requests = [];
  const { eventBus, service, stateStore } = makeHarness({
    fetchImpl: async (...args) => {
      requests.push(args);
      return { ok: true, status: 200 };
    },
  });
  service.start();
  await service.flush();

  eventBus.publish(settlementEvent({
    jobId: "worker-canary-1785151678417",
  }));
  await service.flush();

  assert.equal(requests.length, 0);
  assert.equal(
    (await stateStore.getServiceState("first-external-agent-alert"))?.sentAt,
    undefined
  );
});

test("first external settlement posts once and persists restart-safe evidence", async () => {
  const requests = [];
  const stateStore = new MemoryStateStore();
  const first = makeHarness({
    stateStore,
    fetchImpl: async (url, request) => {
      requests.push({ url, request });
      return { ok: true, status: 200 };
    },
  });
  first.service.start();
  await first.service.flush();
  first.eventBus.publish(settlementEvent());
  await first.service.flush();

  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0].request.body);
  assert.equal(payload.event, "first_external_agent_settled");
  assert.equal(payload.environment, "mainnet");
  assert.equal(payload.jobId, "github-external-job-1");
  assert.equal(payload.sessionId, "session-1");
  assert.equal(payload.wallet, WALLET);
  assert.match(payload.text, /First external agent settlement/u);

  const evidence = await stateStore.getServiceState("first-external-agent-alert");
  assert.equal(evidence.sentAt, "2026-07-27T10:01:00.000Z");
  assert.equal(evidence.firstExternalSettlement.jobId, "github-external-job-1");
  assert.equal(evidence.firstExternalSettlement.observedVia, "live_event");
  first.service.stop();

  const restarted = makeHarness({ stateStore, fetchImpl: first.service.fetchImpl });
  restarted.service.start();
  await restarted.service.flush();
  restarted.eventBus.publish(settlementEvent({
    id: "settlement-session-2",
    jobId: "another-external-job",
    sessionId: "session-2",
  }));
  await restarted.service.flush();

  assert.equal(requests.length, 1);
});

test("failed delivery remains unmarked and the next settlement retries", async () => {
  let attempts = 0;
  const { eventBus, logs, service, stateStore } = makeHarness({
    fetchImpl: async () => {
      attempts += 1;
      return { ok: attempts > 1, status: attempts > 1 ? 200 : 503 };
    },
  });
  service.start();
  await service.flush();

  eventBus.publish(settlementEvent());
  await service.flush();
  assert.equal(attempts, 1);
  assert.equal(
    (await stateStore.getServiceState("first-external-agent-alert"))?.sentAt,
    undefined
  );
  assert(logs.some((entry) => (
    entry.level === "warn"
    && entry.message === "first_external_agent_alert.delivery_failed"
  )));

  eventBus.publish(settlementEvent({
    id: "settlement-session-2",
    jobId: "external-job-2",
    sessionId: "session-2",
  }));
  await service.flush();

  assert.equal(attempts, 2);
  assert.equal(
    (await stateStore.getServiceState("first-external-agent-alert"))
      .firstExternalSettlement.jobId,
    "external-job-2"
  );
});

test("startup does not reinterpret historical smoke settlements as external agents", async () => {
  const requests = [];
  const { service } = makeHarness({
    fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return { ok: true, status: 200 };
    },
  });

  service.start();
  await service.flush();

  assert.equal(requests.length, 0);
});

test("alert configuration is opt-in and fails fast without a webhook", () => {
  assert.deepEqual(loadFirstExternalAgentAlertConfig({}), {
    enabled: false,
    webhookUrl: "",
    environment: "production",
  });
  assert.throws(
    () => loadFirstExternalAgentAlertConfig({
      FIRST_EXTERNAL_AGENT_ALERT_ENABLED: "true",
    }),
    (error) => error instanceof ConfigError && /ALERT_WEBHOOK_URL/u.test(error.message)
  );
  assert.deepEqual(loadFirstExternalAgentAlertConfig({
    FIRST_EXTERNAL_AGENT_ALERT_ENABLED: "1",
    ALERT_WEBHOOK_URL: " https://alerts.example.test/hook ",
    DEPLOYMENT_PROFILE: "mainnet",
  }), {
    enabled: true,
    webhookUrl: "https://alerts.example.test/hook",
    environment: "mainnet",
  });
});

test("external classification follows job id rather than wallet identity", () => {
  assert.equal(isExternalAgentJobId("worker-canary-123"), false);
  assert.equal(isExternalAgentJobId("external-job-123"), true);
  assert.equal(isExternalAgentJobId(""), false);
});
