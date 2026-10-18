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

// Compose's merge for the keys these files use: mappings merge recursively,
// scalars and sequences from a later file replace earlier ones.
const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function mergeMappings(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isMapping(merged[key]) && isMapping(value) ? mergeMappings(merged[key], value) : value;
  }
  return merged;
}

async function mergedServices(files) {
  let services = {};
  for (const file of files) services = mergeMappings(services, yaml.load(await read(file)).services);
  return services;
}

// `--build-context <FROM ref>=<source>` flags of one `docker build`, as a map.
function buildContexts(args) {
  return Object.fromEntries([...args.matchAll(/--build-context\s+(\S+)/gu)].map(([, flag]) => {
    const split = flag.indexOf("=");
    return [flag.slice(0, split), flag.slice(split + 1)];
  }));
}

// A named context that replaces a FROM ref with a helper alias must name an
// alias the same step pulled; anything else must still be a qualified remote.
function assertContextSource(source, aliases) {
  assert.match(source, /^docker-image:\/\//u, `unexpected build context: ${source}`);
  const image = source.slice("docker-image://".length);
  if (image.startsWith("averray-ci/")) assert.ok(aliases.has(image), `build context alias without a helper pull: ${image}`);
  else assertRemoteImage(image);
}

// External image refs of a Dockerfile: FROM and COPY --from that are not stages.
function dockerfileImages(source) {
  const stages = new Set();
  const images = [];
  for (const [, image, stage] of source.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gimu)) {
    if (!stages.has(image) && image !== "scratch") images.push(image);
    if (stage) stages.add(stage);
  }
  for (const [, image] of source.matchAll(/^COPY\s+--from=(\S+)/gimu)) {
    if (!stages.has(image) && !/^\d+$/u.test(image)) images.push(image);
  }
  return images;
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
      const aliases = new Set(pulls.map(({ alias }) => alias));
      for (const source of Object.values(buildContexts(args))) assertContextSource(source, aliases);
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
        for (const source of Object.values(service.build.additional_contexts ?? {})) assertContextSource(source, aliases);
      }
    }
  }
  // Production refs stay audited even where a CI build context replaces them.
  for (const file of dockerfiles) {
    for (const image of dockerfileImages(await read(file))) { assertRemoteImage(image); images++; }
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
  assert.equal(ci.jobs.backend["continue-on-error"], undefined);
  const step = steps.find((s) => s.name === "Verify authorization reservation against real Redis");
  assert.ok(step);
  assert.equal(step["continue-on-error"], undefined);
  assert.equal(step.if, undefined);
  assert.deepEqual(helperPulls(joinLines(step.run))[0].sources, redisSources);
  assert.match(step.run, /set -euo pipefail/u);
  assert.match(step.run, /::error::Redis never answered PING[^\n]*exit 1/u);
  assert.match(step.run, /VERIFY_RESERVATION_TEST_REDIS_URL=redis:\/\/127\.0\.0\.1:16381/u);
});

test("verify fixture step resolves every ECR image from digest-pinned helper aliases", async () => {
  const step = steps.find((s) => s.name === "Verify real fixture inside backend, runner, and proxy images");
  assert.ok(step);
  assert.equal(step["continue-on-error"], undefined);
  assert.equal(step.if, undefined);
  const script = joinLines(step.run);
  assert.match(script, /set -euo pipefail/u);
  // ECR Public's anonymous data limit failed both an implicit `compose up`
  // pull and `docker build witness/sandbox` (2026-10-16). Each image comes
  // from the helper: one digest, mirror.gcr.io first, then ECR Public.
  const pulls = new Map(helperPulls(script).map((pull) => [pull.alias, pull.sources]));
  assert.equal(pulls.size, helperPulls(script).length, "one helper pull per alias");
  for (const [alias, sources] of pulls) {
    const [, name] = alias.match(/^averray-ci\/([^:]+):/u);
    const digest = sources[0].split("@")[1];
    assert.match(digest, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(sources, [`mirror.gcr.io/library/${name}@${digest}`, `${mirror}${name}@${digest}`], alias);
  }
  assert.deepEqual(pulls.get("averray-ci/redis:7-alpine"), redisSources);
  const firstBuild = Math.min(script.search(/\bdocker build\b/u), script.search(/docker compose [^\n]*\bup\b/u));
  assert.ok(script.lastIndexOf("pull-ci-image.sh") < firstBuild, "every pull precedes every build and compose up");

  const files = ["deploy/docker-compose.verify-smoke.yml", "deploy/docker-compose.verify-smoke.ci.yml"];
  const stacks = composeStacks(script);
  assert.equal(stacks.length, 4, "down, two ups, and the proxy guard run");
  for (const stack of stacks) assert.deepEqual(stack, files);
  const services = await mergedServices(files);
  const redis = services["verify-smoke-redis"];
  assert.equal(redis.image, "averray-ci/redis:7-alpine");
  assert.equal(redis.pull_policy, "never");
  // Non-CI users of the base file keep resolving a qualified registry image.
  assertRemoteImage(yaml.load(await read(files[0])).services["verify-smoke-redis"].image);

  const builds = [...script.matchAll(/docker build\s+([^\n]+)/gu)].map(([, args]) => ({
    dockerfile: `${args.trim().split(/\s+/u).at(-1)}/Dockerfile`, contexts: buildContexts(args)
  }));
  for (const service of Object.values(services).filter((s) => s.build)) {
    builds.push({ dockerfile: service.build.dockerfile, contexts: service.build.additional_contexts ?? {} });
  }
  assert.deepEqual(builds.map((b) => b.dockerfile), [
    "witness/sandbox/Dockerfile", "deploy/witness-docker-proxy/Dockerfile", "mcp-server/Dockerfile.witness-runner",
    "mcp-server/Dockerfile.witness-runner", "mcp-server/Dockerfile"
  ]);
  let covered = 0;
  for (const { dockerfile, contexts } of builds) {
    const refs = dockerfileImages(await read(dockerfile));
    // A context whose key matches no FROM is silently ignored by BuildKit.
    for (const key of Object.keys(contexts)) assert.ok(refs.includes(key), `${dockerfile}: unused build context ${key}`);
    for (const ref of refs.filter((r) => r.startsWith(mirror))) {
      const [, name, tag, digest] = ref.slice(mirror.length).match(/^([^:@]+):([^@]+)(?:@(sha256:[0-9a-f]{64}))?$/u);
      const alias = `averray-ci/${name}:${tag}`;
      assert.equal(contexts[ref], `docker-image://${alias}`, `${dockerfile}: ${ref} would pull from ECR`);
      assert.ok(pulls.has(alias), `no helper pull for ${alias}`);
      // A production digest pin must be the digest CI pulls; a floating tag gets a CI pin.
      if (digest) assert.ok(pulls.get(alias).every((source) => source.endsWith(`@${digest}`)), `${alias} digest drifted from ${dockerfile}`);
      covered++;
    }
  }
  assert.equal(covered, 8, "python, docker-cli twice, and five node FROMs");
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


test("real-Redis node test failure fails the workflow step, including its cleanup trap", async () => {
  const step = ci.jobs.backend.steps.find((s) => s.name === "Verify authorization reservation against real Redis");
  const dir = await mkdtemp(join(tmpdir(), "ci-redis-failure-"));
  try {
    const envFile = join(dir, "functions.sh"), log = join(dir, "node-calls");
    await writeFile(envFile, `
# Only external commands are fixtures; execute the workflow's actual shell.
bash() { return 0; }
docker() { [[ "$1" != run ]] || printf 'redis-fixture'; return 0; }
sleep() { return 0; }
node() {
  printf '%s\\n' "$VERIFY_RESERVATION_TEST_REDIS_URL $*" >> "$CALL_LOG"
  return 42
}
`);
    const result = spawnSync("bash", ["-c", step.run], {
      cwd: root, encoding: "utf8", timeout: 5000,
      env: { ...process.env, BASH_ENV: envFile, CALL_LOG: log }
    });
    assert.equal(result.status, 42, `Redis test failure was swallowed: ${result.stderr}`);
    assert.equal((await readFile(log, "utf8")).trim(),
      "redis://127.0.0.1:16381 --test mcp-server/src/services/verify-authorization-reservation.test.js mcp-server/src/services/verify-receipt-signing.test.js mcp-server/src/services/github-repository-identity-backfill.test.js");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("backend job has a bounded deadline even if registry pulls hang", () => {
  assert.equal(ci.jobs.backend["timeout-minutes"], 30);
});

test("MCP smoke builds both Node bases from the pre-pulled CI alias", async () => {
  const step = steps.find((s) => s.name === "Verify real MCP good, bad, and egress-deny fixtures inside prober images");
  assert.ok(step);
  assert.equal(step.if, undefined);
  assert.equal(step["continue-on-error"], undefined);
  const script = joinLines(step.run);
  assert.match(script, /set -euo pipefail/u);
  const alias = "averray-ci/node:22-bookworm-slim";
  const fixture = steps.find((s) => s.name === "Verify real fixture inside backend, runner, and proxy images");
  const nodePull = helperPulls(joinLines(fixture.run)).find((pull) => pull.alias === alias);
  assert.deepEqual(helperPulls(script), [nodePull], "same two-registry digest pin as the witness smoke");
  assert.ok(script.indexOf("pull-ci-image.sh") < script.search(/docker compose [^\n]*\bup\b/u));
  const files = ["deploy/docker-compose.mcp-prober-smoke.yml", "deploy/docker-compose.mcp-prober-smoke.ci.yml"];
  assert.deepEqual(composeStacks(script), [files, files], "cleanup and up must both use the override");
  const services = await mergedServices(files);
  assert.deepEqual(Object.keys(services).filter((name) => services[name].build), ["mcp-egress-proxy", "mcp-prober"]);
  for (const name of ["mcp-egress-proxy", "mcp-prober"]) {
    const refs = dockerfileImages(await read(services[name].build.dockerfile));
    assert.deepEqual(refs, [`${mirror}node:22-bookworm-slim`]);
    assert.deepEqual(services[name].build.additional_contexts,
      Object.fromEntries(refs.map((ref) => [ref, `docker-image://${alias}`])), name);
  }
});
