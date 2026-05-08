import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_WALK_ENTRIES = 5000;
const DEFAULT_MAX_WALK_DEPTH = 4;
const DEFAULT_DISK_WARN_PERCENT = 85;
const DEFAULT_DISK_CRITICAL_PERCENT = 95;
const DEFAULT_WAL_WARN_BYTES = 64 * 1024 * 1024;

export function collectHostDiagnostics(options = {}) {
  const now = options.now ?? new Date();
  const rootDir = options.rootDir ?? process.cwd();
  const paths = normalizeDiagnosticPaths(options.paths ?? process.env.HOST_DIAGNOSTIC_PATHS, rootDir);
  const diskWarnPercent = numberOption(options.diskWarnPercent, process.env.HOST_DISK_WARN_PERCENT, DEFAULT_DISK_WARN_PERCENT);
  const diskCriticalPercent = numberOption(
    options.diskCriticalPercent,
    process.env.HOST_DISK_CRITICAL_PERCENT,
    DEFAULT_DISK_CRITICAL_PERCENT
  );
  const walWarnBytes = numberOption(options.walWarnBytes, process.env.HOST_WAL_WARN_BYTES, DEFAULT_WAL_WARN_BYTES);
  const maxWalkEntries = numberOption(options.maxWalkEntries, process.env.HOST_DIAGNOSTIC_MAX_ENTRIES, DEFAULT_MAX_WALK_ENTRIES);
  const maxWalkDepth = numberOption(options.maxWalkDepth, process.env.HOST_DIAGNOSTIC_MAX_DEPTH, DEFAULT_MAX_WALK_DEPTH);

  const filesystem = paths.map((targetPath) => inspectFilesystemPath(targetPath, {
    diskWarnPercent,
    diskCriticalPercent
  }));
  const walFiles = findWalFiles(paths, { maxWalkEntries, maxWalkDepth, walWarnBytes });
  const warnings = [
    ...filesystem.flatMap((entry) => entry.warnings),
    ...walFiles.warnings
  ];

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    mutates: false,
    health: summarizeHostHealth(warnings),
    process: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      memory: memorySummary(process.memoryUsage()),
      loadAverage: os.loadavg(),
      cpuCount: os.cpus().length
    },
    filesystem,
    sqliteWal: {
      checkedPaths: paths,
      count: walFiles.files.length,
      largest: walFiles.files[0] ?? null,
      files: walFiles.files.slice(0, 10),
      truncated: walFiles.truncated
    },
    warnings,
    recommendations: buildRecommendations({ filesystem, walFiles, warnings })
  };
}

function normalizeDiagnosticPaths(value, rootDir) {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  const paths = raw.length > 0 ? raw : [rootDir];
  return [...new Set(paths.map((entry) => path.resolve(rootDir, entry)))];
}

function inspectFilesystemPath(targetPath, { diskWarnPercent, diskCriticalPercent }) {
  const warnings = [];
  const base = {
    path: targetPath,
    exists: false,
    type: "missing",
    warnings
  };
  try {
    const stats = fs.statSync(targetPath);
    const statfsTarget = stats.isDirectory() ? targetPath : path.dirname(targetPath);
    const disk = diskSummary(fs.statfsSync(statfsTarget));
    if (disk.usedPercent >= diskCriticalPercent) {
      warnings.push({
        severity: "critical",
        code: "disk_usage_critical",
        message: `Disk usage is ${disk.usedPercent}% at ${statfsTarget}.`
      });
    } else if (disk.usedPercent >= diskWarnPercent) {
      warnings.push({
        severity: "medium",
        code: "disk_usage_high",
        message: `Disk usage is ${disk.usedPercent}% at ${statfsTarget}.`
      });
    }
    return {
      ...base,
      exists: true,
      type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
      sizeBytes: stats.isFile() ? stats.size : undefined,
      disk
    };
  } catch (error) {
    warnings.push({
      severity: "medium",
      code: "diagnostic_path_unavailable",
      message: `Host diagnostic path is unavailable: ${targetPath}`,
      detail: error?.code ?? "unknown_error"
    });
    return base;
  }
}

function findWalFiles(paths, { maxWalkEntries, maxWalkDepth, walWarnBytes }) {
  const found = [];
  const warnings = [];
  let visited = 0;
  let truncated = false;

  for (const targetPath of paths) {
    walk(targetPath, 0);
    if (truncated) break;
  }

  found.sort((left, right) => right.sizeBytes - left.sizeBytes);
  for (const file of found) {
    if (file.sizeBytes >= walWarnBytes) {
      warnings.push({
        severity: "medium",
        code: "sqlite_wal_large",
        message: `SQLite WAL file is ${file.sizeBytes} bytes and may need checkpointing.`,
        path: file.path
      });
    }
  }
  if (truncated) {
    warnings.push({
      severity: "low",
      code: "host_diagnostic_scan_truncated",
      message: `Host diagnostic scan stopped after ${maxWalkEntries} entries.`
    });
  }

  return { files: found, warnings, truncated };

  function walk(currentPath, depth) {
    if (visited >= maxWalkEntries) {
      truncated = true;
      return;
    }
    if (depth > maxWalkDepth) return;
    let stats;
    try {
      stats = fs.statSync(currentPath);
    } catch {
      return;
    }
    visited += 1;
    if (stats.isFile()) {
      if (isSqliteWalPath(currentPath)) {
        found.push({
          path: currentPath,
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString()
        });
      }
      return;
    }
    if (!stats.isDirectory()) return;
    let entries;
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(path.join(currentPath, entry.name), depth + 1);
      if (truncated) return;
    }
  }
}

function isSqliteWalPath(filePath) {
  return /(?:\.db|\.sqlite|\.sqlite3)?-wal$/i.test(filePath) || /\.(?:db|sqlite|sqlite3)-wal$/i.test(filePath);
}

function memorySummary(memory) {
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external
  };
}

function diskSummary(stats) {
  const totalBytes = stats.blocks * stats.bsize;
  const freeBytes = stats.bavail * stats.bsize;
  const usedBytes = Math.max(totalBytes - freeBytes, 0);
  const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 10000) / 100 : 0;
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent
  };
}

function summarizeHostHealth(warnings) {
  if (warnings.some((entry) => entry.severity === "critical")) return "critical";
  if (warnings.some((entry) => entry.severity === "medium")) return "attention";
  if (warnings.some((entry) => entry.severity === "low")) return "ok_with_notes";
  return "ok";
}

function buildRecommendations({ filesystem, walFiles, warnings }) {
  const recommendations = [];
  if (walFiles.files.length > 0) {
    recommendations.push("Review SQLite WAL files and schedule safe checkpoints for inactive databases.");
  }
  if (warnings.some((entry) => entry.code === "disk_usage_high" || entry.code === "disk_usage_critical")) {
    recommendations.push("Free disk space or expand the volume before enabling more autonomous admin actions.");
  }
  if (filesystem.some((entry) => entry.exists === false)) {
    recommendations.push("Verify HOST_DIAGNOSTIC_PATHS so missing paths do not hide real host state.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Host diagnostics are clean. Keep this read-only until an approval-gated action registry exists.");
  }
  return recommendations;
}

function numberOption(primary, secondary, fallback) {
  const value = Number(primary ?? secondary);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
