const { extractWithPlaywright } = require("../extractor");
const {
  buildExtractorRequest,
  makeExtractorReport,
  nowIso
} = require("./extractor-protocol");

class LocalPlaywrightExtractorProvider {
  constructor(config, options = {}) {
    this.config = config;
    this.extractImpl = options.extractImpl || extractWithPlaywright;
    this.providerName = "local-playwright";
    this.lastExtraction = null;
  }

  diagnostics() {
    return {
      configuredProvider: this.providerName,
      protocolVersion: this.config.extractorProtocolVersion,
      remoteTarget: null,
      circuit: {
        state: "not_applicable",
        consecutiveFailures: 0,
        openedAt: null
      },
      lastHealth: {
        checkedAt: null,
        ok: true,
        browserReady: null
      },
      lastExtraction: this.lastExtraction
    };
  }

  async health() {
    return {
      checkedAt: nowIso(),
      ok: true,
      protocolVersion: this.config.extractorProtocolVersion,
      agentVersion: "local-playwright-provider",
      browserReady: null
    };
  }

  async extract(job, context) {
    const request = buildExtractorRequest(job, context.config);
    const startedAt = nowIso();
    try {
      const result = await this.extractImpl(job, context);
      const thread = result.thread || result;
      const endedAt = nowIso();
      const report = makeExtractorReport({
        request,
        provider: this.providerName,
        metadata: { agentVersion: "local-playwright-provider" },
        thread,
        startedAt,
        endedAt
      });
      this.lastExtraction = {
        status: "ok",
        at: endedAt,
        commentCount: Array.isArray(thread.comments) ? thread.comments.length : 0,
        warningCodes: Array.isArray(thread.warningCodes) ? thread.warningCodes : []
      };
      return {
        thread,
        extractorReport: report
      };
    } catch (error) {
      const endedAt = nowIso();
      const report = makeExtractorReport({
        request,
        provider: this.providerName,
        metadata: { agentVersion: "local-playwright-provider", retryable: Boolean(error.retryable) },
        startedAt,
        endedAt,
        errorCode: error.errorCode || error.code || "local_playwright_extractor_failed"
      });
      error.extractorReport = error.extractorReport || report;
      this.lastExtraction = {
        status: "failed",
        at: endedAt,
        errorCode: report.errorCode
      };
      throw error;
    }
  }
}

module.exports = {
  LocalPlaywrightExtractorProvider
};
