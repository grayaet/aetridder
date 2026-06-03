const path = require("node:path");

const IMPLEMENTATION_DEFAULTS = Object.freeze({
  httpPort: 4173,
  maxComments: 1000,
  extractionTimeoutMs: 90000,
  translationTimeoutMs: 180000,
  totalJobTimeoutMs: 300000,
  maxInputChars: 300000,
  maxArtifactBytes: 10485760,
  redactedLogTailBytes: 32768,
  codexProcessTimeoutMs: 180000,
  allowedHosts: ["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com", "redd.it"]
});

function readPositiveInt(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function splitHosts(raw) {
  if (!raw) {
    return IMPLEMENTATION_DEFAULTS.allowedHosts;
  }
  return raw
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function loadConfig(options = {}) {
  const env = options.env || process.env;
  const rootDir = options.rootDir || path.resolve(__dirname, "..");
  const storageDir = options.storageDir || env.AETRIDDER_STORAGE_DIR || path.join(rootDir, "runtime");
  const apiToken = options.apiToken !== undefined ? options.apiToken : (env.AETRIDDER_API_TOKEN || "");
  const diagnosticsToken =
    options.diagnosticsToken !== undefined
      ? options.diagnosticsToken
      : (env.AETRIDDER_DIAGNOSTICS_TOKEN || apiToken);

  return {
    rootDir,
    storageDir,
    httpPort: readPositiveInt(env, "AETRIDDER_HTTP_PORT", IMPLEMENTATION_DEFAULTS.httpPort),
    publicBaseUrl: (env.AETRIDDER_PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
    apiToken,
    diagnosticsToken,
    allowedHosts: splitHosts(env.AETRIDDER_PUBLIC_URL_ALLOWLIST),
    maxComments: readPositiveInt(env, "AETRIDDER_MAX_COMMENTS", IMPLEMENTATION_DEFAULTS.maxComments),
    extractionTimeoutMs: readPositiveInt(env, "AETRIDDER_EXTRACTION_TIMEOUT_MS", IMPLEMENTATION_DEFAULTS.extractionTimeoutMs),
    translationTimeoutMs: readPositiveInt(env, "AETRIDDER_TRANSLATION_TIMEOUT_MS", IMPLEMENTATION_DEFAULTS.translationTimeoutMs),
    totalJobTimeoutMs: readPositiveInt(env, "AETRIDDER_TOTAL_JOB_TIMEOUT_MS", IMPLEMENTATION_DEFAULTS.totalJobTimeoutMs),
    maxInputChars: readPositiveInt(env, "AETRIDDER_MAX_INPUT_CHARS", IMPLEMENTATION_DEFAULTS.maxInputChars),
    maxArtifactBytes: readPositiveInt(env, "AETRIDDER_MAX_ARTIFACT_BYTES", IMPLEMENTATION_DEFAULTS.maxArtifactBytes),
    redactedLogTailBytes: readPositiveInt(
      env,
      "AETRIDDER_REDACTED_LOG_TAIL_BYTES",
      IMPLEMENTATION_DEFAULTS.redactedLogTailBytes
    ),
    codexProcessTimeoutMs: readPositiveInt(
      env,
      "AETRIDDER_CODEX_PROCESS_TIMEOUT_MS",
      IMPLEMENTATION_DEFAULTS.codexProcessTimeoutMs
    ),
    codexCliPath: env.CODEX_CLI_PATH || "codex",
    codexExtraArgs: (env.CODEX_CLI_EXTRA_ARGS || "").split(/\s+/).filter(Boolean)
  };
}

module.exports = {
  IMPLEMENTATION_DEFAULTS,
  loadConfig
};

