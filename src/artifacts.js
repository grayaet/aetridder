const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_ARTIFACTS = Object.freeze([
  "reddit-page.html",
  "screenshot.png",
  "thread.raw.json",
  "thread.translated.json",
  "worker.log",
  "codex-events.jsonl",
  "validation-report.json",
  "artifact-manifest.json"
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function assertInside(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Refusing path outside storage root: ${target}`);
  }
  return target;
}

function resetDir(rootDir, targetPath) {
  const target = assertInside(rootDir, targetPath);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
}

function safeRemoveDir(rootDir, targetPath) {
  const target = assertInside(rootDir, targetPath);
  fs.rmSync(target, { recursive: true, force: true });
}

function redactText(text, config = {}) {
  let output = String(text || "");
  const tokens = [config.apiToken, config.diagnosticsToken].filter(Boolean);
  for (const token of tokens) {
    output = output.split(token).join("[REDACTED_TOKEN]");
  }
  output = output.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  output = output.replace(/https?:\/\/[^\s"'<>]+\/t\/[A-Za-z0-9_-]{20,}/g, "[REDACTED_VIEW_URL]");
  output = output.replace(/D:\\Codex\\_opscontrol\\[^\s"'<>]*/gi, "[REDACTED_LOCAL_TOOL_PATH]");
  return output;
}

function limitBytes(bufferOrText, maxBytes) {
  const buffer = Buffer.isBuffer(bufferOrText) ? bufferOrText : Buffer.from(String(bufferOrText), "utf8");
  if (buffer.byteLength <= maxBytes) {
    return buffer;
  }
  const marker = Buffer.from("\n[truncated_by_AETRIDDER_MAX_ARTIFACT_BYTES]\n", "utf8");
  return Buffer.concat([buffer.subarray(0, Math.max(0, maxBytes - marker.byteLength)), marker]);
}

function writeTextArtifact(dir, name, text, config) {
  ensureDir(dir);
  const redacted = redactText(text, config);
  fs.writeFileSync(path.join(dir, name), limitBytes(redacted, config.maxArtifactBytes), "utf8");
}

function writeBufferArtifact(dir, name, buffer, config) {
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, name), limitBytes(buffer, config.maxArtifactBytes));
}

function writeJsonArtifact(dir, name, payload, config) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  writeTextArtifact(dir, name, text, config);
}

function appendWorkerLog(dir, line, config) {
  ensureDir(dir);
  const entry = `${new Date().toISOString()} ${redactText(line, config)}\n`;
  fs.appendFileSync(path.join(dir, "worker.log"), entry, "utf8");
}

function readRedactedLogTail(dir, config) {
  const filePath = path.join(dir, "worker.log");
  if (!fs.existsSync(filePath)) {
    return "";
  }
  const stats = fs.statSync(filePath);
  const start = Math.max(0, stats.size - config.redactedLogTailBytes);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(stats.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return redactText(buffer.toString("utf8"), config);
  } finally {
    fs.closeSync(fd);
  }
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listFilesRecursively(dir, baseDir = dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      return [];
    }
    if (entry.isDirectory()) {
      return listFilesRecursively(fullPath, baseDir);
    }
    if (!entry.isFile()) {
      return [];
    }
    return [path.relative(baseDir, fullPath).split(path.sep).join("/")];
  });
}

function buildArtifactManifest(dir) {
  const generatedAt = new Date().toISOString();
  const entries = REQUIRED_ARTIFACTS.map((name) => {
    const filePath = path.join(dir, name);
    if (!fs.existsSync(filePath)) {
      return {
        name,
        available: false,
        evidenceLabel: "generated_artifact"
      };
    }
    const stats = fs.statSync(filePath);
    return {
      name,
      available: true,
      bytes: stats.size,
      sha256: sha256(filePath),
      relativePath: name,
      evidenceLabel: "generated_artifact"
    };
  });
  const known = new Set(entries.map((entry) => entry.relativePath || entry.name));
  const additionalArtifacts = listFilesRecursively(dir)
    .filter((relativePath) => !known.has(relativePath))
    .sort()
    .map((relativePath) => {
      const filePath = path.join(dir, ...relativePath.split("/"));
      const stats = fs.statSync(filePath);
      return {
        name: path.basename(relativePath),
        available: true,
        bytes: stats.size,
        sha256: sha256(filePath),
        relativePath,
        evidenceLabel: "generated_artifact"
      };
    });

  return {
    schemaVersion: "aetridder.artifact-manifest.v1",
    generatedAt,
    latestJobArtifactsOnly: true,
    entries,
    additionalArtifacts
  };
}

function writeManifest(dir, config) {
  let manifest = buildArtifactManifest(dir);
  writeJsonArtifact(dir, "artifact-manifest.json", manifest, config);
  manifest = buildArtifactManifest(dir);
  writeJsonArtifact(dir, "artifact-manifest.json", manifest, config);
  return manifest;
}

module.exports = {
  REQUIRED_ARTIFACTS,
  ensureDir,
  assertInside,
  resetDir,
  safeRemoveDir,
  redactText,
  writeTextArtifact,
  writeBufferArtifact,
  writeJsonArtifact,
  appendWorkerLog,
  readRedactedLogTail,
  buildArtifactManifest,
  writeManifest
};

