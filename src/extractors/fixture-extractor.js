const {
  buildExtractorRequest,
  makeExtractorReport,
  nowIso
} = require("./extractor-protocol");

class FixtureExtractorProvider {
  constructor(extractImpl, config) {
    this.extractImpl = extractImpl;
    this.config = config;
    this.providerName = "fixture";
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
      lastHealth: null,
      lastExtraction: this.lastExtraction
    };
  }

  async extract(job, context) {
    const request = buildExtractorRequest(job, context.config);
    const startedAt = nowIso();
    const result = await this.extractImpl(job, context);
    const thread = result.thread || result;
    const endedAt = nowIso();
    const report = result.extractorReport || makeExtractorReport({
      request,
      provider: this.providerName,
      metadata: { agentVersion: "fixture-provider" },
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
    return { thread, extractorReport: report };
  }
}

module.exports = {
  FixtureExtractorProvider
};
