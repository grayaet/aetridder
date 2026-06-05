const { FixtureExtractorProvider } = require("./fixture-extractor");
const { LocalPlaywrightExtractorProvider } = require("./local-playwright-extractor");
const { RemoteHttpExtractorProvider } = require("./remote-http-extractor");

function providerFromCandidate(candidate, config) {
  if (!candidate) {
    return null;
  }
  if (typeof candidate.extract === "function" && typeof candidate.diagnostics === "function") {
    return candidate;
  }
  const extractImpl = typeof candidate === "function" ? candidate : candidate.extract;
  return new FixtureExtractorProvider(extractImpl, config);
}

function createExtractorProvider(config, candidate) {
  const provided = providerFromCandidate(candidate, config);
  if (provided) {
    return provided;
  }
  if (config.extractorProvider === "remote-http") {
    return new RemoteHttpExtractorProvider(config);
  }
  return new LocalPlaywrightExtractorProvider(config);
}

module.exports = {
  createExtractorProvider,
  FixtureExtractorProvider,
  LocalPlaywrightExtractorProvider,
  RemoteHttpExtractorProvider
};
