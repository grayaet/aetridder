const crypto = require("node:crypto");

const PROTOCOL_VERSION = "extractor.v1";
const AGENT_VERSION = "aetridder-extractor-agent.v1";

function nowIso() {
  return new Date().toISOString();
}

function makeRequestId() {
  return crypto.randomBytes(16).toString("base64url");
}

function protocolVersion(config = {}) {
  return config.extractorProtocolVersion || PROTOCOL_VERSION;
}

function buildExtractorRequest(job, config) {
  return {
    protocolVersion: protocolVersion(config),
    jobId: job.jobId,
    generation: job.generation,
    requestId: makeRequestId(),
    sourceUrl: job.sourceUrl,
    normalizedUrl: job.normalizedUrl,
    limits: {
      maxComments: config.maxComments,
      maxPartialRequests: config.maxCommentPartialRequests,
      timeoutMs: config.extractorTimeoutMs || config.extractionTimeoutMs,
      maxArtifactBytes: config.maxArtifactBytes
    }
  };
}

function metricsFromThread(thread) {
  const parserMetrics = thread && thread.parserMetrics && typeof thread.parserMetrics === "object"
    ? thread.parserMetrics
    : {};
  return {
    visibleCommentCount: parserMetrics.visibleCommentCount || 0,
    totalCommentCount: parserMetrics.totalCommentCount || 0,
    extractedUniqueCommentCount: parserMetrics.extractedUniqueCommentCount || (Array.isArray(thread?.comments) ? thread.comments.length : 0),
    discoveredMoreRequestCount: parserMetrics.discoveredMoreRequestCount || 0,
    uniqueMoreRequestCount: parserMetrics.uniqueMoreRequestCount || 0,
    fetchedMoreRequestCount: parserMetrics.fetchedMoreRequestCount || 0,
    failedMoreRequestCount: parserMetrics.failedMoreRequestCount || 0,
    unresolvedMoreRequestCount: parserMetrics.unresolvedMoreRequestCount || 0,
    partialArtifactsCount: parserMetrics.partialArtifactsCount || 0
  };
}

function makeExtractorReport({ request, provider, metadata = {}, thread = null, startedAt, endedAt, errorCode = null }) {
  const finishedAt = endedAt || nowIso();
  const startedTime = Date.parse(startedAt);
  const endedTime = Date.parse(finishedAt);
  const durationMs = Number.isFinite(startedTime) && Number.isFinite(endedTime) ? Math.max(0, endedTime - startedTime) : null;
  return {
    schemaVersion: "aetridder.extractor-report.v1",
    extractionAttemptId: request ? request.requestId : makeRequestId(),
    extractorProvider: provider,
    protocolVersion: request ? request.protocolVersion : metadata.protocolVersion || PROTOCOL_VERSION,
    agentVersion: metadata.agentVersion || null,
    startedAt,
    endedAt: finishedAt,
    durationMs,
    metrics: metricsFromThread(thread),
    warningCodes: Array.isArray(thread?.warningCodes) ? thread.warningCodes : [],
    errorCode,
    metadata: {
      remoteTransport: metadata.remoteTransport || null,
      retryable: typeof metadata.retryable === "boolean" ? metadata.retryable : null
    }
  };
}

function buildSuccessResponse(request, rawThread, metadata = {}) {
  const startedAt = metadata.startedAt || nowIso();
  const endedAt = metadata.endedAt || nowIso();
  return {
    protocolVersion: request.protocolVersion,
    ok: true,
    jobId: request.jobId,
    generation: request.generation,
    requestId: request.requestId,
    rawThread,
    warningCodes: Array.isArray(rawThread?.warningCodes) ? rawThread.warningCodes : [],
    metrics: metricsFromThread(rawThread),
    extractor: {
      provider: metadata.provider || "local-playwright",
      agentVersion: metadata.agentVersion || AGENT_VERSION,
      startedAt,
      endedAt,
      browserReady: metadata.browserReady !== false
    }
  };
}

function buildErrorResponse(request, error, metadata = {}) {
  const startedAt = metadata.startedAt || nowIso();
  const endedAt = metadata.endedAt || nowIso();
  return {
    protocolVersion: request.protocolVersion,
    ok: false,
    jobId: request.jobId,
    generation: request.generation,
    requestId: request.requestId,
    errorCode: error.errorCode || error.code || "extractor_failed",
    errorMessageSafe: error.errorMessageSafe || "Reddit extractor could not complete extraction.",
    retryable: Boolean(error.retryable),
    extractor: {
      provider: metadata.provider || "local-playwright",
      agentVersion: metadata.agentVersion || AGENT_VERSION,
      startedAt,
      endedAt,
      browserReady: metadata.browserReady !== false
    }
  };
}

function validateSuccessResponse(body, request) {
  if (!body || typeof body !== "object") {
    return { ok: false, errorCode: "extractor_bad_response" };
  }

  const isLegacy = body.thread || body.rawThread || body.post;
  if (isLegacy && body.ok !== false && !body.protocolVersion) {
    return {
      ok: true,
      legacy: true,
      rawThread: body.thread || body.rawThread || body
    };
  }

  if (body.protocolVersion !== request.protocolVersion || body.ok !== true) {
    return { ok: false, errorCode: "extractor_schema_invalid" };
  }
  if (body.jobId !== request.jobId || body.generation !== request.generation) {
    return { ok: false, errorCode: "extractor_schema_invalid" };
  }
  if (!body.rawThread || typeof body.rawThread !== "object") {
    return { ok: false, errorCode: "extractor_schema_invalid" };
  }
  return { ok: true, rawThread: body.rawThread, metadata: body.extractor || {} };
}

module.exports = {
  AGENT_VERSION,
  PROTOCOL_VERSION,
  buildExtractorRequest,
  buildSuccessResponse,
  buildErrorResponse,
  makeExtractorReport,
  metricsFromThread,
  nowIso,
  protocolVersion,
  validateSuccessResponse
};
