const path = require("node:path");

const IMPLEMENTATION_DEFAULTS = Object.freeze({
  httpPort: 4173,
  httpHost: "127.0.0.1",
  maxComments: 1000,
  extractionTimeoutMs: 90000,
  translationTimeoutMs: 180000,
  totalJobTimeoutMs: 300000,
  maxInputChars: 300000,
  maxArtifactBytes: 10485760,
  maxCommentPartialRequests: 50,
  maxCommentPartialBytes: 10485760,
  commentPartialIdleMs: 0,
  redactedLogTailBytes: 32768,
  codexProcessTimeoutMs: 180000,
  codexBatchTimeoutMs: 300000,
  translationBatchMaxComments: 10,
  translationBatchMaxChars: 20000,
  translationConcurrency: 10,
  codexUsageHistoryLimit: 30,
  extractionMode: "playwright",
  localExtractorHost: "127.0.0.1",
  localExtractorPort: 4181,
  extractorProvider: "local-playwright",
  extractorProtocolVersion: "extractor.v1",
  extractorHealthTimeoutMs: 5000,
  extractorMaxConsecutiveFailures: 3,
  extractorCircuitCooldownMs: 30000,
  codexModel: "gpt-5.5",
  codexReasoningEffort: "high",
  targetLanguageCode: "uk",
  targetLanguageName: "Ukrainian",
  targetLocale: "uk-UA",
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

function envValue(env, primaryKey, legacyKey = null) {
  if (env[primaryKey] !== undefined) {
    return env[primaryKey];
  }
  return legacyKey ? env[legacyKey] : undefined;
}

function readPositiveEnv(env, primaryKey, legacyKey, fallback) {
  return readPositiveInt({ [primaryKey]: envValue(env, primaryKey, legacyKey) }, primaryKey, fallback);
}

function readNonNegativeEnv(env, primaryKey, legacyKey, fallback) {
  return readNonNegativeInt({ [primaryKey]: envValue(env, primaryKey, legacyKey) }, primaryKey, fallback);
}

function readNonNegativeInt(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

function readBooleanEnv(env, primaryKey, legacyKey, fallback = false) {
  const raw = envValue(env, primaryKey, legacyKey);
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`${primaryKey} must be a boolean value`);
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

function readExtractionMode(raw) {
  const mode = (raw || IMPLEMENTATION_DEFAULTS.extractionMode).trim().toLowerCase();
  if (!["playwright", "external"].includes(mode)) {
    throw new Error("REDDIT_READER_EXTRACTION_MODE must be playwright or external");
  }
  return mode;
}

function providerFromMode(mode) {
  return mode === "external" ? "remote-http" : "local-playwright";
}

function readExtractorProvider(raw, extractionMode) {
  const provider = (raw || providerFromMode(extractionMode)).trim().toLowerCase();
  if (!["remote-http", "local-playwright", "auto", "fixture"].includes(provider)) {
    throw new Error("EXTRACTOR_PROVIDER must be remote-http, local-playwright, auto, or fixture");
  }
  return provider === "auto" ? providerFromMode(extractionMode) : provider;
}

function readCodexModel(raw) {
  const model = (raw || IMPLEMENTATION_DEFAULTS.codexModel).trim();
  if (!model || /\s/.test(model)) {
    throw new Error("CODEX_MODEL must be a non-empty model id without whitespace");
  }
  return model;
}

function readCodexReasoningEffort(raw) {
  const effort = (raw || IMPLEMENTATION_DEFAULTS.codexReasoningEffort).trim().toLowerCase();
  if (!["low", "medium", "high", "xhigh"].includes(effort)) {
    throw new Error("CODEX_REASONING_EFFORT must be low, medium, high, or xhigh");
  }
  return effort;
}

function readTargetLanguageCode(raw) {
  const code = (raw || IMPLEMENTATION_DEFAULTS.targetLanguageCode).trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(code)) {
    throw new Error("REDDIT_READER_TARGET_LANGUAGE_CODE must be a BCP-47-like language code such as uk, es, de, fr, or pt-BR");
  }
  return code;
}

function readTargetLanguageName(raw) {
  const name = (raw || IMPLEMENTATION_DEFAULTS.targetLanguageName).trim();
  if (!name || /[\r\n]/.test(name) || name.length > 80) {
    throw new Error("REDDIT_READER_TARGET_LANGUAGE_NAME must be a short non-empty language name");
  }
  return name;
}

function readTargetLocale(raw, fallbackCode) {
  const locale = (raw || IMPLEMENTATION_DEFAULTS.targetLocale || fallbackCode).trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) {
    throw new Error("REDDIT_READER_TARGET_LOCALE must be a BCP-47-like locale such as uk-UA, es-ES, de-DE, fr-FR, or pt-BR");
  }
  return locale;
}

function readHttpHost(raw) {
  const host = (raw || IMPLEMENTATION_DEFAULTS.httpHost).trim();
  if (!host || /[\r\n]/.test(host) || host.length > 255) {
    throw new Error("REDDIT_READER_HTTP_HOST must be a non-empty host name or IP address");
  }
  return host;
}

function readCappedPositiveInt(env, key, fallback, max) {
  const value = readPositiveInt(env, key, fallback);
  return Math.min(value, max);
}

function loadConfig(options = {}) {
  const env = options.env || process.env;
  const rootDir = options.rootDir || path.resolve(__dirname, "..");
  const storageDir = options.storageDir || envValue(env, "REDDIT_READER_STORAGE_DIR", "REDDIT_RU_STORAGE_DIR") || path.join(rootDir, "runtime");
  const apiToken = options.apiToken !== undefined ? options.apiToken : (envValue(env, "REDDIT_READER_API_TOKEN", "REDDIT_RU_API_TOKEN") || "");
  const diagnosticsToken =
    options.diagnosticsToken !== undefined
      ? options.diagnosticsToken
      : (envValue(env, "REDDIT_READER_DIAGNOSTICS_TOKEN", "REDDIT_RU_DIAGNOSTICS_TOKEN") || apiToken);

  const extractionMode = readExtractionMode(envValue(env, "REDDIT_READER_EXTRACTION_MODE", "REDDIT_RU_EXTRACTION_MODE"));
  const extractorProvider = readExtractorProvider(env.EXTRACTOR_PROVIDER, extractionMode);
  const targetLanguageCode = readTargetLanguageCode(
    env.REDDIT_READER_TARGET_LANGUAGE_CODE || env.REDDIT_RU_TARGET_LANGUAGE_CODE
  );
  const targetLanguageName = readTargetLanguageName(
    env.REDDIT_READER_TARGET_LANGUAGE_NAME || env.REDDIT_RU_TARGET_LANGUAGE_NAME
  );

  return {
    rootDir,
    storageDir,
    httpPort: readPositiveEnv(env, "REDDIT_READER_HTTP_PORT", "REDDIT_RU_HTTP_PORT", IMPLEMENTATION_DEFAULTS.httpPort),
    httpHost: readHttpHost(envValue(env, "REDDIT_READER_HTTP_HOST", "REDDIT_RU_HTTP_HOST")),
    publicBaseUrl: (envValue(env, "REDDIT_READER_PUBLIC_BASE_URL", "REDDIT_RU_PUBLIC_BASE_URL") || "").replace(/\/+$/, ""),
    apiToken,
    diagnosticsToken,
    publicDebugPages: readBooleanEnv(env, "REDDIT_READER_PUBLIC_DEBUG_PAGES", "REDDIT_RU_PUBLIC_DEBUG_PAGES", false),
    allowedHosts: splitHosts(envValue(env, "REDDIT_READER_PUBLIC_URL_ALLOWLIST", "REDDIT_RU_PUBLIC_URL_ALLOWLIST")),
    maxComments: readPositiveEnv(env, "REDDIT_READER_MAX_COMMENTS", "REDDIT_RU_MAX_COMMENTS", IMPLEMENTATION_DEFAULTS.maxComments),
    extractionTimeoutMs: readPositiveEnv(env, "REDDIT_READER_EXTRACTION_TIMEOUT_MS", "REDDIT_RU_EXTRACTION_TIMEOUT_MS", IMPLEMENTATION_DEFAULTS.extractionTimeoutMs),
    translationTimeoutMs: readPositiveEnv(env, "REDDIT_READER_TRANSLATION_TIMEOUT_MS", "REDDIT_RU_TRANSLATION_TIMEOUT_MS", IMPLEMENTATION_DEFAULTS.translationTimeoutMs),
    totalJobTimeoutMs: readPositiveEnv(env, "REDDIT_READER_TOTAL_JOB_TIMEOUT_MS", "REDDIT_RU_TOTAL_JOB_TIMEOUT_MS", IMPLEMENTATION_DEFAULTS.totalJobTimeoutMs),
    maxInputChars: readPositiveEnv(env, "REDDIT_READER_MAX_INPUT_CHARS", "REDDIT_RU_MAX_INPUT_CHARS", IMPLEMENTATION_DEFAULTS.maxInputChars),
    maxArtifactBytes: readPositiveEnv(env, "REDDIT_READER_MAX_ARTIFACT_BYTES", "REDDIT_RU_MAX_ARTIFACT_BYTES", IMPLEMENTATION_DEFAULTS.maxArtifactBytes),
    maxCommentPartialRequests: readPositiveEnv(
      env,
      "REDDIT_READER_MAX_COMMENT_PARTIAL_REQUESTS",
      "REDDIT_RU_MAX_COMMENT_PARTIAL_REQUESTS",
      IMPLEMENTATION_DEFAULTS.maxCommentPartialRequests
    ),
    maxCommentPartialBytes: readPositiveEnv(
      env,
      "REDDIT_READER_MAX_COMMENT_PARTIAL_BYTES",
      "REDDIT_RU_MAX_COMMENT_PARTIAL_BYTES",
      IMPLEMENTATION_DEFAULTS.maxCommentPartialBytes
    ),
    commentPartialIdleMs: readNonNegativeEnv(
      env,
      "REDDIT_READER_COMMENT_PARTIAL_IDLE_MS",
      "REDDIT_RU_COMMENT_PARTIAL_IDLE_MS",
      IMPLEMENTATION_DEFAULTS.commentPartialIdleMs
    ),
    redactedLogTailBytes: readPositiveEnv(
      env,
      "REDDIT_READER_REDACTED_LOG_TAIL_BYTES",
      "REDDIT_RU_REDACTED_LOG_TAIL_BYTES",
      IMPLEMENTATION_DEFAULTS.redactedLogTailBytes
    ),
    codexProcessTimeoutMs: readPositiveEnv(
      env,
      "REDDIT_READER_CODEX_PROCESS_TIMEOUT_MS",
      "REDDIT_RU_CODEX_PROCESS_TIMEOUT_MS",
      IMPLEMENTATION_DEFAULTS.codexProcessTimeoutMs
    ),
    codexBatchTimeoutMs: readPositiveEnv(
      env,
      "REDDIT_READER_CODEX_BATCH_TIMEOUT_MS",
      "REDDIT_RU_CODEX_BATCH_TIMEOUT_MS",
      IMPLEMENTATION_DEFAULTS.codexBatchTimeoutMs
    ),
    translationBatchMaxComments: readPositiveEnv(
      env,
      "REDDIT_READER_TRANSLATION_BATCH_MAX_COMMENTS",
      "REDDIT_RU_TRANSLATION_BATCH_MAX_COMMENTS",
      IMPLEMENTATION_DEFAULTS.translationBatchMaxComments
    ),
    translationBatchMaxChars: readPositiveEnv(
      env,
      "REDDIT_READER_TRANSLATION_BATCH_MAX_CHARS",
      "REDDIT_RU_TRANSLATION_BATCH_MAX_CHARS",
      IMPLEMENTATION_DEFAULTS.translationBatchMaxChars
    ),
    translationConcurrency: Math.min(readPositiveEnv(
      env,
      "REDDIT_READER_TRANSLATION_CONCURRENCY",
      "REDDIT_RU_TRANSLATION_CONCURRENCY",
      IMPLEMENTATION_DEFAULTS.translationConcurrency,
    ), 10),
    codexUsageHistoryLimit: Math.min(readPositiveEnv(
      env,
      "REDDIT_READER_CODEX_USAGE_HISTORY_LIMIT",
      "REDDIT_RU_CODEX_USAGE_HISTORY_LIMIT",
      IMPLEMENTATION_DEFAULTS.codexUsageHistoryLimit,
    ), 100),
    extractionMode,
    extractorProvider,
    extractorProtocolVersion: env.EXTRACTOR_PROTOCOL_VERSION || IMPLEMENTATION_DEFAULTS.extractorProtocolVersion,
    externalExtractorUrl: (env.EXTRACTOR_REMOTE_URL || envValue(env, "REDDIT_READER_EXTERNAL_EXTRACTOR_URL", "REDDIT_RU_EXTERNAL_EXTRACTOR_URL") || "").trim(),
    externalExtractorToken: env.EXTRACTOR_TOKEN || env.EXTRACTOR_SHARED_SECRET || envValue(env, "REDDIT_READER_EXTERNAL_EXTRACTOR_TOKEN", "REDDIT_RU_EXTERNAL_EXTRACTOR_TOKEN") || "",
    localExtractorHost: envValue(env, "REDDIT_READER_EXTRACTOR_AGENT_HOST", "REDDIT_RU_EXTRACTOR_AGENT_HOST") || IMPLEMENTATION_DEFAULTS.localExtractorHost,
    localExtractorPort: readPositiveEnv(
      env,
      "REDDIT_READER_EXTRACTOR_AGENT_PORT",
      "REDDIT_RU_EXTRACTOR_AGENT_PORT",
      IMPLEMENTATION_DEFAULTS.localExtractorPort
    ),
    localExtractorToken: envValue(env, "REDDIT_READER_EXTRACTOR_AGENT_TOKEN", "REDDIT_RU_EXTRACTOR_AGENT_TOKEN") || env.EXTRACTOR_TOKEN || env.EXTRACTOR_SHARED_SECRET || "",
    extractorTimeoutMs: readPositiveInt(env, "EXTRACTOR_TIMEOUT_MS", readPositiveEnv(env, "REDDIT_READER_EXTRACTION_TIMEOUT_MS", "REDDIT_RU_EXTRACTION_TIMEOUT_MS", IMPLEMENTATION_DEFAULTS.extractionTimeoutMs)),
    extractorHealthTimeoutMs: readPositiveInt(env, "EXTRACTOR_HEALTH_TIMEOUT_MS", IMPLEMENTATION_DEFAULTS.extractorHealthTimeoutMs),
    extractorMaxConsecutiveFailures: readPositiveInt(
      env,
      "EXTRACTOR_MAX_CONSECUTIVE_FAILURES",
      IMPLEMENTATION_DEFAULTS.extractorMaxConsecutiveFailures
    ),
    extractorCircuitCooldownMs: readPositiveInt(
      env,
      "EXTRACTOR_CIRCUIT_COOLDOWN_MS",
      IMPLEMENTATION_DEFAULTS.extractorCircuitCooldownMs
    ),
    codexModel: readCodexModel(env.CODEX_MODEL),
    codexReasoningEffort: readCodexReasoningEffort(env.CODEX_REASONING_EFFORT),
    targetLanguageCode,
    targetLanguageName,
    targetLocale: readTargetLocale(env.REDDIT_READER_TARGET_LOCALE || env.REDDIT_RU_TARGET_LOCALE, targetLanguageCode),
    codexCliPath: env.CODEX_CLI_PATH || "codex",
    codexExtraArgs: (env.CODEX_CLI_EXTRA_ARGS || "").split(/\s+/).filter(Boolean)
  };
}

module.exports = {
  IMPLEMENTATION_DEFAULTS,
  loadConfig
};
