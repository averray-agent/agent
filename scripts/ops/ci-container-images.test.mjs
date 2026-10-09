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
  const composeFiles = new Set();
  let images = 0;
  for (const job of Object.values(ci.jobs)) {
    for (const container of [job.container, ...Object.values(job.services ?? {})].filter(Boolean)) {
      assertRemoteImage(typeof container === "string" ? container : container.image);
      images++;
    }
  }
  for (const step of steps) {
    if (step.uses?.startsWith("docker://")) assertRemoteImage(step.uses.slice(9));
    const script = (step.run ?? "").replace(/\\\n/gu, " ");
    for (const image of commandImages(script)) { assertRemoteImage(image); images++; }
    for (const [, path] of script.matchAll(/docker compose -f ([\w./-]+)/gu)) composeFiles.add(path);
    for (const [, args] of script.matchAll(/docker build\s+([^\n]+)/gu)) {
      // CI's standalone sandbox build uses the default Dockerfile in its context.
      assert.doesNotMatch(args, /(?:^|\s)(?:-f|--file)(?:\s|=)/u, "extend audit for explicit Dockerfiles");
      dockerfiles.add(`${args.trim().split(/\s+/u).at(-1)}/Dockerfile`);
    }
  }
  for (const file of composeFiles) {
    const { services } = yaml.load(await read(file));
    const builtLocally = new Set(Object.values(services).filter((s) => s.build && s.image).map((s) => s.image));
    for (const service of Object.values(services)) {
      if (service.image && !builtLocally.has(service.image)) { assertRemoteImage(service.image); images++; }
      if (service.build) {
        assert.equal(service.build.context, "..");
        dockerfiles.add(service.build.dockerfile);
      }
    }
  }
  for (const file of dockerfiles) {
    const stages = new Set();
    for (const [, image, stage] of (await read(file)).matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gimu)) {
      if (!stages.has(image) && image !== "scratch") { assertRemoteImage(image); images++; }
      if (stage) stages.add(stage);
    }
  }
  assert.equal(composeFiles.size, 2, "both CI smoke stacks must be audited");
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

test("Redis and Caddy CI steps pull mirrors with the bounded helper and prohibit implicit pulls", () => {
  for (const image of ["redis:7-alpine", "caddy:2.11.2-alpine"]) {
    const step = steps.find((s) => s.run?.includes(`${mirror}${image}`));
    assert.ok(step);
    assert.ok(step.run.includes(`bash scripts/ops/pull-ci-image.sh ${mirror}${image}`));
    assert.match(step.run, /docker (?:run|create) --pull=never/u);
    assert.ok(step.run.indexOf("pull-ci-image.sh") < step.run.indexOf("$(docker"));
  }
});

async function pullFixture(mode, image = `${mirror}redis:7-alpine`) {
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
  count=$(grep -c '^docker ' "$CALL_LOG")
  case "$PULL_MODE" in
    success) return 0 ;;
    retry) [[ "$count" -ge 3 ]] ;;
    timeout) return 124 ;;
    *) return 1 ;;
  esac
}
sleep() { printf '%s\\n' "sleep $*" >> "$CALL_LOG"; }
`);
    const result = spawnSync("bash", ["scripts/ops/pull-ci-image.sh", image], {
      cwd: root, encoding: "utf8", timeout: 5000,
      env: { ...process.env, BASH_ENV: envFile, CALL_LOG: log, PULL_MODE: mode }
    });
    return { ...result, calls: (await readFile(log, "utf8")).trim().split("\n").filter(Boolean) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("CI image pull succeeds immediately or retries twice, with a deadline on every pull", async () => {
  for (const [mode, attempts] of [["success", 1], ["retry", 3]]) {
    const result = await pullFixture(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.filter((c) => c.startsWith("docker pull ")).length, attempts);
    assert.equal(result.calls.filter((c) => c.startsWith("timeout --signal=TERM --kill-after=5s 90s docker pull ")).length, attempts);
    assert.equal(result.calls.filter((c) => c === "sleep 5").length, attempts - 1);
  }
});

test("persistent pull errors and timeouts fail closed after exactly three attempts", async () => {
  for (const mode of ["failure", "timeout"]) {
    const result = await pullFixture(mode);
    assert.equal(result.status, 1);
    assert.equal(result.calls.filter((c) => c.startsWith("docker pull ")).length, 3);
    assert.equal(result.calls.filter((c) => c === "sleep 5").length, 2);
    assert.match(result.stderr, /::error::Image pull exhausted three bounded attempts/u);
  }
});

test("CI pull helper refuses unqualified and Docker Hub images before contacting Docker", async () => {
  for (const image of ["redis:7-alpine", "library/redis:7-alpine", "docker.io/library/redis:7-alpine", "registry-1.docker.io/library/redis:7-alpine"]) {
    const result = await pullFixture("success", image);
    assert.equal(result.status, 2);
    assert.deepEqual(result.calls, []);
  }
});
