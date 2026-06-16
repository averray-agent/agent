import test from "node:test";
import assert from "node:assert/strict";

import { assertSafeAuthBrokeringPosture } from "./bootstrap.js";
import { ConfigError } from "../core/errors.js";

const enabledGateway = { isEnabled: () => true };
const disabledGateway = { isEnabled: () => false };

test("permissive auth + enabled gateway refuses to boot (pre-audit #7)", () => {
  assert.throws(
    () =>
      assertSafeAuthBrokeringPosture({
        authConfig: { permissive: true },
        gateway: enabledGateway,
        env: {}
      }),
    (error) => error instanceof ConfigError && /AUTH_MODE=permissive/.test(error.message)
  );
});

test("strict auth + enabled gateway boots cleanly", () => {
  assert.doesNotThrow(() =>
    assertSafeAuthBrokeringPosture({
      authConfig: { permissive: false },
      gateway: enabledGateway,
      env: {}
    })
  );
});

test("permissive auth + disabled gateway boots cleanly (dev default)", () => {
  assert.doesNotThrow(() =>
    assertSafeAuthBrokeringPosture({
      authConfig: { permissive: true },
      gateway: disabledGateway,
      env: {}
    })
  );
});

test("explicit AUTH_ALLOW_PERMISSIVE_BROKERING opt-in boots but warns loudly", () => {
  const warnings = [];
  assert.doesNotThrow(() =>
    assertSafeAuthBrokeringPosture({
      authConfig: { permissive: true },
      gateway: enabledGateway,
      env: { AUTH_ALLOW_PERMISSIVE_BROKERING: "1" },
      logger: { warn: (...args) => warnings.push(args) }
    })
  );
  assert.equal(warnings.length, 1, "the dangerous posture is logged, never silent");
  assert.equal(warnings[0][1], "auth.permissive_brokering_explicitly_allowed");
});

test("a non-truthy opt-in value does not disarm the guard", () => {
  assert.throws(
    () =>
      assertSafeAuthBrokeringPosture({
        authConfig: { permissive: true },
        gateway: enabledGateway,
        env: { AUTH_ALLOW_PERMISSIVE_BROKERING: "no" }
      }),
    ConfigError
  );
});
