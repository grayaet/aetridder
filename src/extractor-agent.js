const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");

const { appendWorkerLog, ensureDir, resetDir } = require("./artifacts");
const { loadConfig } = require("./config");
const { extractWithPlaywright } = require("./extractor");
const {
  AGENT_VERSION,
  PROTOCOL_VERSION,
  buildErrorResponse,
  buildSuccessResponse,
  nowIso
} = require("./extractors/extractor-protocol");
const { normalizeRedditUrl } = require("./url");

function tokenFromHeader(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function safeJobSegment(value) {
  const source = String(value || "");
  if (/^[A-Za-z0-9_-]{8,80}$/.test(source)) {
    return source;
  }
  return `agent-${crypto.randomBytes(12).toString("hex")}`;
}

function errorPayload(errorCode, errorMessageSafe) {
  return { errorCode, errorMessageSafe };
}

function makeRequestId() {
  return crypto.randomBytes(16).toString("base64url");
}

function numberOrFallback(value, fallback) {
  return Number.isSafeInteger(value) ? value : fallback;
}

function makeProtocolRequest(body, normalized, config) {
  const source = body && typeof body === "object" ? body : {};
  return {
    protocolVersion: source.protocolVersion || config.extractorProtocolVersion || PROTOCOL_VERSION,
    jobId: safeJobSegment(source.jobId),
    generation: numberOrFallback(source.generation, 0),
    requestId: source.requestId || makeRequestId(),
    sourceUrl: source.sourceUrl || source.url || normalized.normalizedUrl,
    normalizedUrl: normalized.normalizedUrl,
    limits: source.limits && typeof source.limits === "object"
      ? source.limits
      : {
        maxComments: config.maxComments,
        maxPartialRequests: config.maxCommentPartialRequests,
        timeoutMs: config.extractorTimeoutMs || config.extractionTimeoutMs,
        maxArtifactBytes: config.maxArtifactBytes
      }
  };
}

function statusCodeForError(error) {
  if (error.status === "invalid_url") {
    return 400;
  }
  if (error.errorCode === "extractor_unauthorized") {
    return 401;
  }
  if (error.errorCode === "extractor_timeout") {
    return 504;
  }
  if (error.status === "reddit_unavailable") {
    return 502;
  }
  return 502;
}

function createExtractorAgent(options = {}) {
  const config = options.config || loadConfig(options);
  const extract = options.extractor || extractWithPlaywright;
  const app = express();

  ensureDir(config.storageDir);
  app.use(express.json({ limit: `${config.maxInputChars}b` }));

  function requireAgentAuth(req, res, next) {
    if (config.localExtractorToken && tokenFromHeader(req) !== config.localExtractorToken) {
      res.status(401).json(errorPayload("extractor_unauthorized", "Reddit extractor authorization failed."));
      return;
    }
    next();
  }

  app.get("/health", requireAgentAuth, (_req, res) => {
    res.json({
      ok: true,
      protocolVersion: config.extractorProtocolVersion || PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      mode: "local_playwright_extractor",
      provider: "local-playwright",
      public: false,
      browserReady: null,
      limits: {
        maxComments: config.maxComments,
        maxPartialRequests: config.maxCommentPartialRequests
      }
    });
  });

  app.post("/extract", requireAgentAuth, async (req, res) => {
    const sourceUrl = req.body && (req.body.normalizedUrl || req.body.sourceUrl || req.body.url);
    const normalized = normalizeRedditUrl(sourceUrl, config.allowedHosts);
    if (!normalized.ok) {
      res.status(400).json(errorPayload(normalized.errorCode, normalized.errorMessageSafe));
      return;
    }

    const request = makeProtocolRequest(req.body, normalized, config);
    const jobId = request.jobId;
    const workDir = path.join(config.storageDir, "extractor-agent", jobId);
    resetDir(config.storageDir, workDir);
    const log = (line) => appendWorkerLog(workDir, line, config);
    const job = {
      jobId,
      generation: request.generation,
      sourceUrl: request.sourceUrl,
      normalizedUrl: normalized.normalizedUrl
    };
    const startedAt = nowIso();

    try {
      log("extractor-agent job started");
      const result = await extract(job, { config, workDir, log });
      res.json(buildSuccessResponse(request, result.thread || result, {
        provider: "local-playwright",
        agentVersion: AGENT_VERSION,
        startedAt,
        endedAt: nowIso(),
        browserReady: null
      }));
    } catch (error) {
      const errorCode = error.errorCode || error.code || "extractor_agent_failed";
      const errorMessageSafe = error.errorMessageSafe || "Reddit extractor could not complete extraction.";
      log(`extractor-agent job failed with ${errorCode}`);
      res.status(statusCodeForError(error)).json(buildErrorResponse(request, {
        ...error,
        errorCode,
        errorMessageSafe
      }, {
        provider: "local-playwright",
        agentVersion: AGENT_VERSION,
        startedAt,
        endedAt: nowIso(),
        browserReady: null
      }));
    }
  });

  return { app, config };
}

if (require.main === module) {
  const { app, config } = createExtractorAgent();
  app.listen(config.localExtractorPort, config.localExtractorHost, () => {
    console.log(`Extractor agent listening on http://${config.localExtractorHost}:${config.localExtractorPort}`);
    console.log("Extractor agent does not need public inbound access.");
  });
}

module.exports = {
  createExtractorAgent
};
