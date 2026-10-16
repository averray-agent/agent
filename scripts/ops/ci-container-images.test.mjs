import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import yaml from "js-yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFile(join(root, path), "utf8");
const mirror = "public.ecr.aws/docker/library/";
const ci = yaml.load(await read(".github/workflows/ci.yml"));
const steps = Object.values(ci.jobs).flatMap((job) => job.steps ?? []);
const joinLines = (script) => script.replace(/\\\n/gu, " ");
const redisDigest = "sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499";
const redisSources = [`mirror.gcr.io/library/redis@${redisDigest}`, `${mirror}redis@${redisDigest}`];

// `bash scripts/ops/pull-ci-image.sh <averray-ci alias> <source>...` invocations.
function helperPulls(script) {
  return [...script.matchAll(/\bbash scripts\/ops\/pull-ci-image\.sh\s+([^\n]+)/gu)].map((match) => {
    const [alias, ...sources] = match[1].trim().split(/\s+/u);
    return { alias, sources };
  });
}

// `docker compose -f base.yml [-f override.yml]...` invocations, as file lists.
function composeStacks(script) {
  return [...script.matchAll(/\bdocker compose((?:\s+-f\s+[\w./-]+)+)/gu)]
    .map((match) => [...match[1].matchAll(/-f\s+([\w./-]+)/gu)].map(([, path]) => path));
}

// Compose's merge for the keys these files use: later files override per service key.
async function mergedServices(files) {
  const services = {};
  for (const file of files) {
    for (const [name, service] of Object.entries(yaml.load(await read(file)).services)) {
      services[name] = { ...services[name], ...service };
    }
  }
  return services;
}

function assertRemoteImage(image) {
  assert.equal(typeof image, "string");
  assert.match(image, /^[a-z0-9.-]+\.[a-z0-9.-]+\//u, `unqualified CI image: ${image}`);
  assert.doesNotMatch(image, /^(?:[^/]+\.)?docker\.io\//u, `Docker Hub CI image: ${image}`);
}

function commandImages(script) {
  return [...script.matchAll(/\bdocker\s+(?:pull|run|create)\s+([^\n]+)/gu)].map((match) => {
    const args = match[1].trim().split(/\s+/u);
    while (args[0]?.startsWith("-")) {
      const option = args.shift();
      if (["-p", "--publish", "--name", "--platform", "--pull", "-e", "--env", "-v", "--volume"].includes(option)) args.shift();
    }
    return args[0]?.replace(/[)'";]+$/u, "");
  });
}

test("CI remote images, including smoke Compose and Dockerfile bases, never pull from Docker Hub", async () => {
  const dockerfiles = new Set();
  const auditedStacks = new Map();
  let images = 0;
  for (const job of Object.values(ci.jobs)) {
    for (const container of [job.container, ...Object.values(job.services ?? {})].filter(Boolean)) {
      assertRemoteImage(typeof container === "string" ? container : container.image);
      images++;
    }
  }
  for (const step of steps) {
    if (step.uses?.startsWith("docker://")) assertRemoteImage(step.uses.slice(9));
    const script = joinLines(step.run ?? "");
    const pulls = helperPulls(script);
    for (const { sources } of pulls) for (const source of sources) { assertRemoteImage(source); images++; }
    // A local averray-ci/ alias is unqualified, so any implicit pull of it would
    // hit Docker Hub: it is only legal with --pull=never after the helper made it.
    for (const [command] of script.matchAll(/\bdocker\s+(?:run|create)\s+[^\n]*\baverray-ci\/[^\n]*/gu)) {
      assert.match(command, /\s--pull=never\s/u, `implicit pull of a local alias: ${command}`);
    }
    for (const image of commandImages(script)) {
      if (pulls.some(({ alias }) => alias === image)) continue;
      assertRemoteImage(image); images++;
    }
    for (const files of composeStacks(script)) {
      // Every invocation of one stack must layer the same overrides, or `down`
      // and `up` would disagree about which image a service runs.
      const seen = auditedStacks.get(files[0]);
      if (seen) assert.deepEqual(files, seen.files, `inconsistent overrides for ${files[0]}`);
      else auditedStacks.set(files[0], { files, aliases: new Set(pulls.map(({ alias }) => alias)) });
    }
    for (const [, args] of script.matchAll(/docker build\s+([^\n]+)/gu)) {
      // CI's standalone sandbox build uses the default Dockerfile in its context.
      assert.doesNotMatch(args, /(?:^|\s)(?:-f|--file)(?:\s|=)/u, "extend audit for explicit Dockerfiles");
      dockerfiles.add(`${args.trim().split(/\s+/u).at(-1)}/Dockerfile`);
    }
  }
  for (const { files, aliases } of auditedStacks.values()) {
    const services = await mergedServices(files);
    const builtLocally = new Set(Object.values(services).filter((s) => s.build && s.image).map((s) => s.image));
    for (const service of Object.values(services)) {
      if (service.image?.startsWith("averray-ci/")) {
        // Unqualified local alias: only legal when the same step's helper made it
        // and Compose is forbidden to resolve it against Docker Hub.
        assert.ok(aliases.has(service.image), `compose alias without a helper pull: ${service.image}`);
        assert.equal(service.pull_policy, "never", `implicit pull of a local alias: ${service.image}`);
      } else if (service.image && !builtLocally.has(service.image)) { assertRemoteImage(service.image); images++; }
      if (service.build) {
        assert.equal(service.build.context, "..");
        dockerfiles.add(service.build.dockerfile);
      }
    }
  }
  for (const file of dockerfiles) {
    const stages = new Set();
    const source = await read(file);
    for (const [, image, stage] of source.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gimu)) {
      if (!stages.has(image) && image !== "scratch") { assertRemoteImage(image); images++; }
      if (stage) stages.add(stage);
    }
    for (const [, image] of source.matchAll(/^COPY\s+--from=(\S+)/gimu)) {
      if (!stages.has(image) && !/^\d+$/u.test(image)) { assertRemoteImage(image); images++; }
    }
  }
  assert.equal(auditedStacks.size, 2, "both CI smoke stacks must be audited");
  assert.equal(dockerfiles.size, 6, "all transitive CI build files must be audited");
  assert.ok(images >= 10, "audit must not silently stop seeing image references");
});

test("image policy rejects unqualified and explicit Docker Hub spellings", () => {
  for (const image of ["redis:7-alpine", "library/redis:7-alpine", "docker.io/library/redis:7-alpine", "index.docker.io/library/redis:7-alpine", "registry-1.docker.io/library/redis:7-alpine"]) {
    assert.throws(() => assertRemoteImage(image));
    assert.deepEqual(commandImages(`docker run --pull=never -d --rm -p 127.0.0.1:16381:6379 ${image})`), [image]);
  }
  assertRemoteImage(`${mirror}redis:7-alpine`);
});


test("Redis and Caddy CI steps pull one digest from two registries via the bounded helper and prohibit implicit pulls", () => {
  for (const [name, tag] of [["redis", "7-alpine"], ["caddy", "2.11.2-alpine"]]) {
    const alias = `averray-ci/${name}:${tag}`;
    const step = steps.find((s) => s.run?.includes(`pull-ci-image.sh ${alias}`));
    assert.ok(step, `no helper pull for ${alias}`);
    const script = joinLines(step.run);
    const [pull, ...extra] = helperPulls(script);
    assert.deepEqual(extra, []);
    assert.equal(pull.alias, alias);
    // A second registry is the point: ECR Public's anonymous data limit
    // exhausted on 2026-10-14/16 and retrying the same mirror cannot outlast it.
    assert.deepEqual(pull.sources.map((s) => s.split("/")[0]), ["mirror.gcr.io", "public.ecr.aws"]);
    const digests = pull.sources.map((source) => {
      const match = source.match(new RegExp(`/library/${name}@(sha256:[0-9a-f]{64})$`, "u"));
      assert.ok(match, `source must be ${name} pinned by digest: ${source}`);
      return match[1];
    });
    assert.equal(new Set(digests).size, 1, "every fallback must serve the same bits");
    assert.match(script, new RegExp(`docker (?:run|create) --pull=never [^\\n]*${alias.replace(/[.]/gu, "\\.")}`, "u"));
    assert.ok(script.indexOf("pull-ci-image.sh") < script.indexOf("$(docker"));
  }
});

test("real-Redis proof stays mandatory: no skip path and fail-closed readiness", () => {
  const step = steps.find((s) => s.name === "Verify authorization reservation against real Redis");
  assert.ok(step);
  assert.equal(step["continue-on-error"], undefined);
  assert.equal(step.if, undefined);
  assert.deepEqual(helperPulls(joinLines(step.run))[0].sources, redisSources);
  assert.match(step.run, /set -euo pipefail/u);
  assert.match(step.run, /::error::Redis never answered PING[^\n]*exit 1/u);
  assert.match(step.run, /VERIFY_RESERVATION_TEST_REDIS_URL=redis:\/\/127\.0\.0\.1:16381/u);
});

test("verify smoke Redis runs the helper's digest-pinned alias with pull_policy: never", async () => {
  const step = steps.find((s) => s.name === "Verify real fixture inside backend, runner, and proxy images");
  assert.ok(step);
  assert.equal(step["continue-on-error"], undefined);
  assert.equal(step.if, undefined);
  const script = joinLines(step.run);
  assert.match(script, /set -euo pipefail/u);
  // ECR Public's anonymous data limit must not fail an implicit `compose up` pull.
  assert.deepEqual(helperPulls(script), [{ alias: "averray-ci/redis:7-alpine", sources: redisSources }]);
  const files = ["deploy/docker-compose.verify-smoke.yml", "deploy/docker-compose.verify-smoke.ci.yml"];
  const stacks = composeStacks(script);
  assert.equal(stacks.length, 4, "down, two ups, and the proxy guard run");
  for (const stack of stacks) assert.deepEqual(stack, files);
  const redis = (await mergedServices(files))["verify-smoke-redis"];
  assert.equal(redis.image, "averray-ci/redis:7-alpine");
  assert.equal(redis.pull_policy, "never");
  assert.ok(script.indexOf("pull-ci-image.sh") < script.search(/docker compose [^\n]*\bup\b/u), "pull before compose up");
  // Non-CI users of the base file keep resolving a qualified registry image.
  assertRemoteImage(yaml.load(await read(files[0])).services["verify-smoke-redis"].image);
});

async function pullFixture(mode, args = ["averray-ci/redis:7-alpine", ...redisSources]) {
  const dir = await mkdtemp(join(tmpdir(), "ci-image-pull-"));
  const log = join(dir, "calls");
  const envFile = join(dir, "functions.sh");
  try {
    await writeFile(log, "");
    await writeFile(envFile, `
timeout() {
  printf '%s\\n' "timeout $*" >> "$CALL_LOG"
  [[ "$1 $2 $3" == "--signal=TERM --kill-after=5s 90s" ]] || return 99
  shift 3
  "$@"
}
docker() {
  printf '%s\\n' "docker $*" >> "$CALL_LOG"
  [[ "$1" == tag ]] && return 0
  count=$(grep -c '^docker pull ' "$CALL_LOG")
  case "$PULL_MODE" in
    success) return 0 ;;
    retry) [[ "$count" -ge 3 ]] ;;
    fallback) [[ "$2" != mirror.gcr.io/* ]] ;;
    timeout) return 124 ;;
    *) return 1 ;;
  esac
}
sleep() { printf '%s\\n' "sleep $*" >> "$CALL_LOG"; }
`);
    const result = spawnSync("bash", ["scripts/ops/pull-ci-image.sh", ...args], {
      cwd: root, encoding: "utf8", timeout: 5000,
      env: { ...process.env, BASH_ENV: envFile, CALL_LOG: log, PULL_MODE: mode }
    });
    return { ...result, calls: (await readFile(log, "utf8")).trim().split("\n").filter(Boolean) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const pullsOf = (calls) => calls.filter((c) => c.startsWith("docker pull ")).map((c) => c.slice(12));
const sleepsOf = (calls) => calls.filter((c) => c.startsWith("sleep "));

test("CI image pull tags the first source that succeeds, with a deadline on every pull", async () => {
  for (const [mode, pulls, sleeps, winner] of [
    ["success", [redisSources[0]], [], redisSources[0]],
    // mirror.gcr.io out of quota: ECR Public answers in the same round, no backoff.
    ["fallback", redisSources, [], redisSources[1]],
    // Both down for one round, mirror.gcr.io back after a 5 s backoff.
    ["retry", [...redisSources, redisSources[0]], ["sleep 5"], redisSources[0]]
  ]) {
    const result = await pullFixture(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(pullsOf(result.calls), pulls, mode);
    assert.equal(result.calls.filter((c) => c.startsWith("timeout --signal=TERM --kill-after=5s 90s docker pull ")).length, pulls.length);
    assert.deepEqual(sleepsOf(result.calls), sleeps, mode);
    assert.deepEqual(result.calls.filter((c) => c.startsWith("docker tag ")), [`docker tag ${winner} averray-ci/redis:7-alpine`]);
  }
});

test("persistent pull errors and timeouts fail closed after three rounds across every source", async () => {
  for (const mode of ["failure", "timeout"]) {
    const result = await pullFixture(mode);
    assert.equal(result.status, 1);
    assert.deepEqual(pullsOf(result.calls), [...redisSources, ...redisSources, ...redisSources]);
    assert.deepEqual(sleepsOf(result.calls), ["sleep 5", "sleep 15"]);
    assert.equal(result.calls.filter((c) => c.startsWith("docker tag ")).length, 0);
    assert.match(result.stderr, /::error::Image pull exhausted three bounded rounds across 2 source\(s\)/u);
  }
});

test("CI pull helper refuses bad aliases, Docker Hub, tags, and mixed digests before contacting Docker", async () => {
  const otherDigest = `sha256:${"0".repeat(64)}`;
  for (const args of [
    ["averray-ci/redis:7-alpine"],
    ["redis:7-alpine", ...redisSources],
    ["docker.io/averray-ci/redis:7-alpine", ...redisSources],
    ["averray-ci/redis", ...redisSources],
    ...["redis:7-alpine", "library/redis:7-alpine", "docker.io/library/redis:7-alpine", "registry-1.docker.io/library/redis:7-alpine",
      `redis@${redisDigest}`, `docker.io/library/redis@${redisDigest}`, `${mirror}redis:7-alpine`, `${mirror}redis@sha256:abc`]
      .map((image) => ["averray-ci/redis:7-alpine", image]),
    ["averray-ci/redis:7-alpine", redisSources[0], `${mirror}redis@${otherDigest}`]
  ]) {
    const result = await pullFixture("success", args);
    assert.equal(result.status, 2, `${args.join(" ")}\n${result.stderr}`);
    assert.deepEqual(result.calls, []);
  }
});
