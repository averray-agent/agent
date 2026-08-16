import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

const TAR_BLOCK_BYTES = 512;

function within(root, candidate) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

function localArtifactPath(locator, baseDirectory) {
  if (isAbsolute(locator.path)) throw new Error("artifact path locator must be relative");
  const root = resolve(baseDirectory);
  const candidate = resolve(root, locator.path);
  if (!within(root, candidate)) throw new Error("artifact path locator escapes the contract directory");
  return candidate;
}

async function acquireBytes(artifact, baseDirectory) {
  if (artifact.locator.kind === "path") {
    return readFile(localArtifactPath(artifact.locator, baseDirectory));
  }
  if (artifact.locator.kind !== "https") {
    throw new Error(`unsupported artifact locator kind: ${artifact.locator.kind}`);
  }
  const response = await fetch(artifact.locator.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`artifact fetch returned HTTP ${response.status}`);
  if (new URL(response.url).protocol !== "https:") {
    throw new Error("artifact fetch redirected outside HTTPS");
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function verifyArtifact(artifact, { baseDirectory = process.cwd() } = {}) {
  const bytes = await acquireBytes(artifact, baseDirectory);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== artifact.bytes) {
    throw new Error(`artifact byte length ${bytes.length} does not match declared ${artifact.bytes}`);
  }
  if (digest !== artifact.sha256) {
    throw new Error(`artifact SHA-256 ${digest} does not match declared ${artifact.sha256}`);
  }
  return { bytes, sha256: digest, size: bytes.length, locator: artifact.locator };
}

function tarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  return buffer.subarray(start, end === -1 || end > start + length ? start + length : end)
    .toString("utf8")
    .trim();
}

function tarNumber(buffer, start, length) {
  const value = tarString(buffer, start, length).replace(/^0+/u, "");
  if (value === "") return 0;
  if (!/^[0-7]+$/u.test(value)) throw new Error("tar entry contains an invalid octal number");
  return Number.parseInt(value, 8);
}

function safeArchivePath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`tar entry path is unsafe: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function parseTar(buffer) {
  const entries = [];
  for (let offset = 0; offset + TAR_BLOCK_BYTES <= buffer.length;) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) break;
    const name = safeArchivePath(`${tarString(header, 345, 155)}/${tarString(header, 0, 100)}`.replace(/^\//u, ""));
    const size = tarNumber(header, 124, 12);
    const mode = tarNumber(header, 100, 8);
    const type = String.fromCharCode(header[156] || 48);
    const storedChecksum = tarNumber(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(32, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (actualChecksum !== storedChecksum) throw new Error(`tar checksum mismatch for ${name}`);
    const dataStart = offset + TAR_BLOCK_BYTES;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new Error(`tar entry ${name} exceeds the archive length`);
    const nextOffset = dataStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (type === "g") {
      // POSIX global PAX metadata does not define a filesystem entry. The
      // archive byte digest still covers it; entry-specific PAX paths remain
      // rejected because they would need separate path validation.
      offset = nextOffset;
      continue;
    }
    if (!["0", "5"].includes(type)) {
      throw new Error(`tar entry ${name} has unsupported type ${JSON.stringify(type)}`);
    }
    entries.push({ name, type, mode, bytes: buffer.subarray(dataStart, dataEnd) });
    offset = nextOffset;
  }
  if (entries.length === 0) throw new Error("tar artifact is empty");
  return entries;
}

function stripCommonRoot(entries) {
  const roots = new Set(entries.map((entry) => entry.name.split("/")[0]));
  if (roots.size !== 1 || !entries.some((entry) => entry.name.includes("/"))) return entries;
  const [root] = roots;
  return entries
    .filter((entry) => entry.name !== root)
    .map((entry) => ({ ...entry, name: entry.name.slice(root.length + 1) }));
}

async function extractTar(bytes, destination, compressed) {
  const archive = compressed ? gunzipSync(bytes) : bytes;
  const entries = stripCommonRoot(parseTar(archive));
  const root = resolve(destination);
  await mkdir(root, { recursive: true, mode: 0o755 });
  for (const entry of entries) {
    const output = resolve(root, entry.name);
    if (!within(root, output)) throw new Error(`tar entry escapes destination: ${entry.name}`);
    if (entry.type === "5") {
      await mkdir(output, { recursive: true, mode: 0o755 });
      continue;
    }
    await mkdir(dirname(output), { recursive: true, mode: 0o755 });
    await writeFile(output, entry.bytes, { mode: entry.mode & 0o111 ? 0o755 : 0o644 });
    await chmod(output, entry.mode & 0o111 ? 0o755 : 0o644);
  }
  return { path: root, entries: entries.map((entry) => entry.name) };
}

export async function materializeArtifact(artifact, destination, options = {}) {
  const verified = await verifyArtifact(artifact, options);
  if (artifact.format === "file") {
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await writeFile(destination, verified.bytes, { mode: 0o644 });
    return { ...verified, path: destination, entries: [basename(destination)] };
  }
  if (artifact.format === "tar") {
    return { ...verified, ...await extractTar(verified.bytes, destination, false) };
  }
  if (artifact.format === "tar+gzip") {
    return { ...verified, ...await extractTar(verified.bytes, destination, true) };
  }
  throw new Error(`unsupported artifact format: ${artifact.format}`);
}
