class ExtractorError extends Error {
  constructor(errorCode, errorMessageSafe, options = {}) {
    super(errorCode);
    this.name = "ExtractorError";
    this.status = options.status || "extraction_failed";
    this.errorCode = errorCode;
    this.errorMessageSafe = errorMessageSafe;
    this.retryable = Boolean(options.retryable);
    this.extractorReport = options.extractorReport || null;
  }
}

function extractorUnavailable(message = "Reddit extractor is offline or unreachable.", options = {}) {
  return new ExtractorError("extractor_unavailable", message, {
    status: "extraction_unavailable",
    retryable: true,
    ...options
  });
}

function extractorTimeout(options = {}) {
  return new ExtractorError("extractor_timeout", "Reddit extractor did not respond in time.", {
    status: "timeout",
    retryable: true,
    ...options
  });
}

function extractorUnauthorized(options = {}) {
  return new ExtractorError("extractor_unauthorized", "Reddit extractor authorization failed.", {
    status: "extraction_unavailable",
    retryable: false,
    ...options
  });
}

function extractorBadResponse(message = "Reddit extractor returned an invalid response.", options = {}) {
  return new ExtractorError("extractor_bad_response", message, {
    retryable: true,
    ...options
  });
}

function extractorSchemaInvalid(message = "Reddit extractor response did not match the extractor protocol.", options = {}) {
  return new ExtractorError("extractor_schema_invalid", message, {
    retryable: false,
    ...options
  });
}

function redditUnavailable(errorCode = "reddit_unavailable", message = "Reddit is unavailable to the extractor.", options = {}) {
  return new ExtractorError(errorCode, message, {
    status: "reddit_unavailable",
    retryable: true,
    ...options
  });
}

module.exports = {
  ExtractorError,
  extractorUnavailable,
  extractorTimeout,
  extractorUnauthorized,
  extractorBadResponse,
  extractorSchemaInvalid,
  redditUnavailable
};
