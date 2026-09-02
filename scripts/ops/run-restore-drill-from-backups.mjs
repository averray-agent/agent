#!/usr/bin/env node

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { fileURLToPath } from "node:url";

import { SCHEMA_VERSION } from "./check-restore-drill-evidence.mjs";

const SCRIPT_NAME = basename(fileURLToPath(import.meta.url));
const POSTGRES_IMAGE = process.env.RESTORE_DRILL_POSTGRES_IMAGE || "postgres:16";
const REDIS_IMAGE = process.env.RESTORE_DRILL_REDIS_IMAGE || "redis:7";
const POSTGRES_QUERY = "select count(*) from information_schema.tables where table_schema = 'public';";

function usage() {
  return `Usage: node scripts/ops/${SCRIPT_NAME} --readiness artifacts/backup-readiness.json --backup-dir artifacts/backups --out artifacts/restore-drill.json [options]

Restores selected Postgres and Redis backups into disposable local Docker
containers and writes restore-drill evidence. This script never connects to
production services and never modifies backup files.

Options:
  --operator-name NAME       Evidence operator.name, default GitHub Actions
  --operator-signature SIG   Evidence operator.signature, default gh
  -h, --help                 Show this help text
`;
}

function parseArgs(argv) {
  const args = {
    readiness: undefined,
    backupDir: undefined,
    out: undefined,
    operatorName: "GitHub Actions",
    operatorSignature: "gh"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--readiness") {
      args.readiness = argv[index + 1];
      index += 1;
    } else if (arg === "--backup-dir") {
      args.backupDir = argv[index + 1];
      index += 1;
    } else if (arg === "--out") {
      args.out = argv[index + 1];
      index += 1;
    } else if (arg === "--operator-name") {
      args.operatorName = argv[index + 1];
      index += 1;
    } else if (arg === "--operator-signature") {
      args.operatorSignature = argv[index + 1];
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function requireArg(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function component(readiness, name) {
  return readiness?.components?.find((item) => item?.name === name);
}

async function assertFile(path) {
  const stats = await stat(path);
  if (!stats.isFile()) {
    throw new Error(`${path} is not a regular file`);
  }
}

async function selectBackupCopies(readiness, backupDir) {
  if (readiness?.overallStatus !== "ok") {
    throw new Error("readiness.overallStatus must be ok before restore drill");
  }

  const postgres = component(readiness, "postgres");
  const redis = component(readiness, "redis");
  if (postgres?.status !== "ok" || !postgres.file) {
    throw new Error("readiness postgres component must be ok with a file");
  }
  if (redis?.status !== "ok" || !redis.file) {
    throw new Error("readiness redis component must be ok with a file");
  }

  const postgresBasename = basename(postgres.file);
  const redisBasename = basename(redis.file);
  if (!postgresBasename.endsWith(".sql.gz")) {
    throw new Error(`postgres backup must end with .sql.gz: ${postgresBasename}`);
  }
  if (!redisBasename.endsWith(".rdb.gz")) {
    throw new Error(`redis backup must end with .rdb.gz: ${redisBasename}`);
  }

  const postgresLocal = resolve(backupDir, "postgres", postgresBasename);
  const redisLocal = resolve(backupDir, "redis", redisBasename);
  await assertFile(postgresLocal);
  await assertFile(redisLocal);

  return {
    postgres: {
      remoteFile: postgres.file,
      basename: postgresBasename,
      localFile: postgresLocal
    },
    redis: {
      remoteFile: redis.file,
      basename: redisBasename,
      localFile: redisLocal
    }
  };
}

function wait(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        const error = new Error(`${command} ${args.join(" ")} failed with exit ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function waitForPostgres(container) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await run("docker", ["exec", container, "pg_isready", "-U", "agent"]);
      return;
    } catch {
      await wait(1000);
    }
  }
  throw new Error(`Postgres container ${container} did not become ready`);
}

async function waitForRedis(container) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const { stdout } = await run("docker", ["exec", container, "redis-cli", "PING"]);
      if (stdout.trim() === "PONG") return;
    } catch {
      await wait(1000);
    }
  }
  throw new Error(`Redis container ${container} did not become ready`);
}

async function pipeGzipToDockerPsql(backupFile, container) {
  const child = spawn("docker", [
    "exec",
    "-i",
    container,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "agent",
    "-d",
    "agent"
  ], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const waitForExit = new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        const error = new Error(`docker exec psql restore failed with exit ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });

  try {
    await pipeline(createReadStream(backupFile), createGunzip(), child.stdin);
  } catch (error) {
    child.kill("SIGTERM");
    await waitForExit.catch(() => {});
    throw error;
  }
  return waitForExit;
}

function parseIntegerStdout(stdout, label) {
  const value = Number.parseInt(String(stdout).trim(), 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} did not return a non-negative integer: ${stdout}`);
  }
  return value;
}

async function restorePostgres(backupFile, suffix) {
  const container = `drill-postgres-${suffix}`;
  let removed = false;
  try {
    await run("docker", [
      "run",
      "-d",
      "--name",
      container,
      "-e",
      "POSTGRES_USER=agent",
      "-e",
      "POSTGRES_PASSWORD=drill",
      "-e",
      "POSTGRES_DB=agent",
      POSTGRES_IMAGE
    ]);
    await waitForPostgres(container);
    await pipeGzipToDockerPsql(backupFile, container);
    const { stdout } = await run("docker", [
      "exec",
      container,
      "psql",
      "-t",
      "-A",
      "-U",
      "agent",
      "-d",
      "agent",
      "-c",
      POSTGRES_QUERY
    ]);
    return {
      restoreTarget: container,
      restoreExitCode: 0,
      rowCheck: {
        query: POSTGRES_QUERY,
        rowCount: parseIntegerStdout(stdout, "postgres row check")
      }
    };
  } finally {
    try {
      await run("docker", ["rm", "-f", container]);
      removed = true;
    } catch {
      removed = false;
    }
    restorePostgres.lastRemoved = removed;
  }
}

async function restoreRedis(backupFile, suffix) {
  const container = `drill-redis-${suffix}`;
  const redisDataDir = await mkdtemp(join(tmpdir(), "averray-restore-drill-redis-"));
  let removed = false;
  let dataDirRemoved = false;
  try {
    await pipeline(
      createReadStream(backupFile),
      createGunzip(),
      createWriteStream(join(redisDataDir, "dump.rdb"))
    );
    await run("docker", [
      "run",
      "-d",
      "--name",
      container,
      "-v",
      `${redisDataDir}:/data`,
      REDIS_IMAGE
    ]);
    await waitForRedis(container);
    const { stdout } = await run("docker", ["exec", container, "redis-cli", "DBSIZE"]);
    return {
      restoreTarget: container,
      restoreExitCode: 0,
      dbSize: parseIntegerStdout(stdout, "redis DBSIZE")
    };
  } finally {
    try {
      await run("docker", ["rm", "-f", container]);
      removed = true;
    } catch {
      removed = false;
    }
    try {
      await rm(redisDataDir, { recursive: true, force: true });
      dataDirRemoved = true;
    } catch {
      await makeDockerBindMountWritable(redisDataDir);
      await rm(redisDataDir, { recursive: true, force: true });
      dataDirRemoved = true;
    }
    restoreRedis.lastRemoved = removed;
    restoreRedis.lastDataDirRemoved = dataDirRemoved;
  }
}

async function makeDockerBindMountWritable(path) {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return;
  }

  await run("docker", dockerBindMountWritableArgs(path, process.getuid(), process.getgid()));
}

function dockerBindMountWritableArgs(path, uid, gid) {
  return [
    "run",
    "--rm",
    "--user",
    "0:0",
    "-v",
    `${path}:/data`,
    REDIS_IMAGE,
    "sh",
    "-c",
    `chown -R ${uid}:${gid} /data && chmod -R u+rwX /data`
  ];
}

function buildEvidence({ readiness, selected, postgres, redis, operatorName, operatorSignature, completedAt }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    drillDate: completedAt.slice(0, 10),
    completedAt,
    operator: {
      name: operatorName,
      signature: operatorSignature
    },
    target: {
      type: "disposable_container",
      label: "GitHub Actions restore drill containers"
    },
    readiness,
    postgres: {
      backupFile: selected.postgres.basename,
      ...postgres
    },
    redis: {
      backupFile: selected.redis.basename,
      ...redis
    },
    cleanup: {
      postgresTargetRemoved: restorePostgres.lastRemoved === true,
      redisTargetRemoved: restoreRedis.lastRemoved === true,
      ...(typeof restoreRedis.lastDataDirRemoved === "boolean"
        ? { redisDataDirRemoved: restoreRedis.lastDataDirRemoved === true }
        : {})
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const readinessFile = requireArg(args.readiness, "--readiness");
  const backupDir = requireArg(args.backupDir, "--backup-dir");
  const out = requireArg(args.out, "--out");
  const readiness = await readJson(readinessFile);
  const selected = await selectBackupCopies(readiness, backupDir);
  const suffix = `${Date.now()}-${process.pid}`;

  const postgres = await restorePostgres(selected.postgres.localFile, suffix);
  const redis = await restoreRedis(selected.redis.localFile, suffix);
  const evidence = buildEvidence({
    readiness,
    selected,
    postgres,
    redis,
    operatorName: args.operatorName,
    operatorSignature: args.operatorSignature,
    completedAt: new Date().toISOString()
  });

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`Restore drill evidence written to ${out}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    if (error.stderr) process.stderr.write(`${error.stderr}\n`);
    process.exitCode = 1;
  });
}

export {
  buildEvidence,
  dockerBindMountWritableArgs,
  makeDockerBindMountWritable,
  parseArgs,
  parseIntegerStdout,
  selectBackupCopies
};
