const { RemoteHttpExtractorProvider } = require("./extractors/remote-http-extractor");

async function extractWithExternalExtractor(job, { config, log }) {
  const provider = new RemoteHttpExtractorProvider(config);
  return provider.extract(job, { config, log });
}

module.exports = {
  extractWithExternalExtractor
};
