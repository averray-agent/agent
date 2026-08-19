import assert from "node:assert/strict";
import test from "node:test";

import { authorizeDockerRequest } from "../../deploy/witness-docker-proxy/policy.mjs";

const RUNTIME_ROOT = "/srv/agent-stack-mainnet/witness-runtime";
const IMAGE = "averray-witness-preflight:test";

function createBody() {
  return {
    Image: IMAGE,
    User: "65532:65532",
    Cmd: ["/bin/sh", "-lc", "exec /bin/sh -lc \"$AVERRAY_WITNESS_COMMAND\""],
    WorkingDir: "/workspace",
    Env: ["HOME=/tmp", "CI=1", "AVERRAY_WITNESS_COMMAND=npm test"],
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges"],
      Devices: [],
      DeviceRequests: [],
      Mounts: [],
      VolumesFrom: [],
      PublishAllPorts: false,
      PortBindings: {},
      PidsLimit: 512,
      Memory: 4 * 1024 * 1024 * 1024,
      NanoCpus: 4_000_000_000,
      Binds: [`${RUNTIME_ROOT}/run-one:/workspace:rw`],
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=1024m" }
    },
    NetworkingConfig: { EndpointsConfig: {} }
  };
}

function authorize(method, url, body, allowedContainerRefs = new Set()) {
  return authorizeDockerRequest({
    method,
    url,
    body: body === undefined ? undefined : JSON.stringify(body),
    runtimeRoot: RUNTIME_ROOT,
    containerPrefix: "averray-witness-",
    allowedImage: IMAGE,
    allowedContainerRefs
  });
}

test("proxy permits only the bounded Witness container lifecycle", () => {
  const createdName = "averray-witness-run-one";
  const createdRefs = new Set([createdName]);
  assert.equal(authorize("GET", "/v1.52/_ping").allowed, true);
  assert.equal(authorize("GET", `/v1.52/images/${encodeURIComponent(IMAGE)}/json`).allowed, true);
  assert.equal(authorize("POST", `/v1.52/containers/create?name=${createdName}`, createBody()).allowed, true);
  assert.equal(authorize("POST", `/v1.52/containers/${createdName}/start`, undefined, createdRefs).allowed, true);
  assert.equal(authorize("POST", `/v1.52/containers/${createdName}/attach`, undefined, createdRefs).allowed, true);
  assert.equal(authorize("GET", `/v1.52/containers/${createdName}/json`, undefined, createdRefs).allowed, true);
  assert.equal(authorize("DELETE", `/v1.52/containers/${createdName}?force=1`, undefined, createdRefs).allowed, true);
});

test("proxy refuses exec and arbitrary-container lifecycle endpoints", () => {
  const createdId = "a".repeat(64);
  assert.equal(authorize("POST", `/v1.52/containers/${createdId}/attach`, undefined, new Set([createdId])).allowed, true);
  assert.equal(authorize("POST", `/v1.52/containers/${createdId}/wait?condition=next-exit`, undefined, new Set([createdId])).allowed, true);
  assert.equal(authorize("POST", `/v1.52/containers/${createdId}/wait?condition=removed`, undefined, new Set([createdId])).allowed, false);
  assert.equal(authorize("GET", `/v1.52/containers/${createdId}/json`, undefined, new Set([createdId])).allowed, true);
  assert.equal(authorize("DELETE", `/v1.52/containers/${createdId}?force=1`, undefined, new Set([createdId])).allowed, true);
  assert.equal(authorize("POST", `/v1.52/containers/${"b".repeat(64)}/attach`).allowed, false);
  assert.equal(authorize("POST", "/v1.52/containers/averray-witness-unregistered/start").allowed, false);
  assert.equal(authorize("POST", "/v1.52/containers/arbitrary/exec", {}).allowed, false);
  assert.equal(authorize("POST", "/v1.52/containers/averray-witness-run-one/exec", {}).allowed, false);
  assert.equal(authorize("POST", "/v1.52/containers/arbitrary/start").allowed, false);
  assert.equal(authorize("DELETE", "/v1.52/containers/arbitrary?force=1").allowed, false);
});

test("proxy refuses create bodies that widen host access", () => {
  for (const mutate of [
    (body) => { body.HostConfig.Binds = ["/:/workspace:rw"]; },
    (body) => { body.HostConfig.Privileged = true; },
    (body) => { body.HostConfig.NetworkMode = "host"; },
    (body) => { body.HostConfig.Devices = [{ PathOnHost: "/dev/kvm" }]; },
    (body) => { body.HostConfig.CapAdd = ["SYS_ADMIN"]; },
    (body) => { body.HostConfig.PortBindings = { "80/tcp": [{ HostPort: "80" }] }; },
    (body) => { body.Env.push("AWS_SECRET_ACCESS_KEY=forbidden"); }
  ]) {
    const body = createBody();
    mutate(body);
    assert.equal(
      authorize("POST", "/v1.52/containers/create?name=averray-witness-run-one", body).allowed,
      false
    );
  }
});
