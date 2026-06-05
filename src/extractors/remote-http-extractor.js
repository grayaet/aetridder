const {
  extractorBadResponse,
  extractorSchemaInvalid,
  extractorTimeout,
  extractorUnauthorized,
  extractorUnavailable,
  redditUnavailable
} = require("./extractor-errors");
const {
  buildExtractorRequest,
  makeExtractorReport,
  nowIso,
  validateSuccessResponse
} = require("./extractor-protocol");

function safeRemoteTarget(url) {
  try {
    const parsed = new URL(url);
    return {
      protocol: parsed.protocol.replace(":", ""),
      host: parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" ? parsed.hostname : "[redacted-host]",
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
      path: parsed.pathname
    };
  } catch (_error) {
    return null;
  }
}

function errorFromRemoteBody(body, statusCode, report) {
  const errorCode = body && body.errorCode ? body.errorCode : `extractor_http_${statusCode}`;
  const safeMessage = body && body.errorMessageSafe
    ? body.errorMessageSafe
    : "Reddit extractor could not complete extraction.";
  const options = {
    retryable: Boolean(body && body.retryable),
    extractorReport: {
      ...report,
      errorCode,
      metadata: {
        ...report.metadata,
        retryable: Boolean(body && body.retryable)
      }
    }
  };
  if (statusCode === 401 || statusCode === 403 || errorCode === "extractor_unauthorized") {
    return extractorUnauthorized(options);
  }
  if (errorCode === "reddit_verification_or_block_page" || errorCode === "reddit_unavailable" || errorCode === "reddit_login_gated") {
    return redditUnavailable(errorCode, safeMessage, options);
  }
  return extractorBadResponse(safeMessage, options);
}

class RemoteHttpExtractorProvider {
  constructor(config, options = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl || fetch;
    this.providerName = "remote-http";
    this.consecutiveFailures = 0;
    this.circuitOpenedAt = null;
    this.lastHealth = null;
    this.lastExtraction = null;
  }

  isCircuitOpen() {
    if (!this.circuitOpenedAt) {
      return false;
    }
    return Date.now() - this.circuitOpenedAt < this.config.extractorCircuitCooldownMs;
  }

  recordSuccess(summary) {
    this.consecutiveFailures = 0;
    this.circuitOpenedAt = null;
    this.lastExtraction = summary;
  }

  recordFailure(summary) {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.extractorMaxConsecutiveFailures) {
      this.circuitOpenedAt = Date.now();
    }
    this.lastExtraction = summary;
  }

  diagnostics() {
    return {
      configuredProvider: this.providerName,
      protocolVersion: this.config.extractorProtocolVersion,
      remoteTarget: safeRemoteTarget(this.config.externalExtractorUrl),
      circuit: {
        state: this.isCircuitOpen() ? "open" : "closed",
        consecutiveFailures: this.consecutiveFailures,
        openedAt: this.circuitOpenedAt ? new Date(this.circuitOpenedAt).toISOString() : null
      },
      lastHealth: this.lastHealth,
      lastExtraction: this.lastExtraction
    };
  }

  async health() {
    if (!this.config.externalExtractorUrl) {
      this.lastHealth = {
        checkedAt: nowIso(),
        ok: false,
        errorCode: "extractor_remote_url_missing"
      };
      return this.lastHealth;
    }

    const healthUrl = new URL(this.config.externalExtractorUrl);
    healthUrl.pathname = "/health";
    healthUrl.search = "";
    const checkedAt = nowIso();
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.extractorHealthTimeoutMs);
    try {
      const headers = {};
      if (this.config.externalExtractorToken) {
        headers.authorization = `Bearer ${this.config.externalExtractorToken}`;
      }
      const response = await this.fetchImpl(healthUrl.toString(), {
        headers,
        signal: controller.signal
      });
      const body = await response.json().catch(() => ({}));
      this.lastHealth = {
        checkedAt,
        ok: response.ok && Boolean(body.ok),
        latencyMs: Date.now() - started,
        protocolVersion: body.protocolVersion || null,
        agentVersion: body.agentVersion || null,
        browserReady: typeof body.browserReady === "boolean" ? body.browserReady : null,
        errorCode: response.ok ? null : `extractor_health_http_${response.status}`
      };
      return this.lastHealth;
    } catch (error) {
      this.lastHealth = {
        checkedAt,
        ok: false,
        latencyMs: Date.now() - started,
        errorCode: error.name === "AbortError" ? "extractor_health_timeout" : "extractor_health_unavailable"
      };
      return this.lastHealth;
    } finally {
      clearTimeout(timer);
    }
  }

  async extract(job, { config, log }) {
    if (!config.externalExtractorUrl) {
      throw extractorUnavailable("Reddit extractor endpoint is not configured.");
    }
    if (this.isCircuitOpen()) {
      const error = extractorUnavailable("Reddit extractor circuit is open.");
      error.errorCode = "extractor_unavailable";
      throw error;
    }

    const request = buildExtractorRequest(job, config);
    const startedAt = nowIso();
    const reportBase = makeExtractorReport({
      request,
      provider: this.providerName,
      metadata: { remoteTransport: "reverse_ssh_tunnel" },
      startedAt
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.extractorTimeoutMs);
    try {
      log("requesting configured ExtractorProvider remote-http endpoint");
      const headers = {
        "content-type": "application/json",
        "user-agent": "Aetridder-VPS-Worker/0.1"
      };
      if (config.externalExtractorToken) {
        headers.authorization = `Bearer ${config.externalExtractorToken}`;
      }

      const response = await this.fetchImpl(config.externalExtractorUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal
      });
      const text = await response.text();
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch (_error) {
          const error = extractorBadResponse("Reddit extractor returned invalid JSON.", {
            extractorReport: { ...reportBase, errorCode: "extractor_bad_response" }
          });
          this.recordFailure({ status: "failed", errorCode: error.errorCode, at: nowIso() });
          throw error;
        }
      }

      if (!response.ok || (body && body.ok === false)) {
        const error = errorFromRemoteBody(body, response.status, reportBase);
        this.recordFailure({ status: "failed", errorCode: error.errorCode, at: nowIso() });
        throw error;
      }

      const validation = validateSuccessResponse(body, request);
      if (!validation.ok) {
        const error = extractorSchemaInvalid("Reddit extractor response did not match the requested job.", {
          extractorReport: { ...reportBase, errorCode: validation.errorCode || "extractor_schema_invalid" }
        });
        this.recordFailure({ status: "failed", errorCode: error.errorCode, at: nowIso() });
        throw error;
      }

      const endedAt = nowIso();
      const report = makeExtractorReport({
        request,
        provider: this.providerName,
        metadata: {
          ...validation.metadata,
          remoteTransport: "reverse_ssh_tunnel"
        },
        thread: validation.rawThread,
        startedAt,
        endedAt
      });
      this.recordSuccess({
        status: "ok",
        at: endedAt,
        commentCount: Array.isArray(validation.rawThread.comments) ? validation.rawThread.comments.length : 0,
        warningCodes: Array.isArray(validation.rawThread.warningCodes) ? validation.rawThread.warningCodes : []
      });
      return {
        thread: validation.rawThread,
        extractorReport: report
      };
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = extractorTimeout({
          extractorReport: { ...reportBase, errorCode: "extractor_timeout" }
        });
        this.recordFailure({ status: "failed", errorCode: timeoutError.errorCode, at: nowIso() });
        throw timeoutError;
      }
      if (error.status) {
        throw error;
      }
      const unavailable = extractorUnavailable("Reddit extractor is offline or unreachable.", {
        extractorReport: { ...reportBase, errorCode: "extractor_unavailable" }
      });
      this.recordFailure({ status: "failed", errorCode: unavailable.errorCode, at: nowIso() });
      throw unavailable;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  RemoteHttpExtractorProvider,
  safeRemoteTarget
};
