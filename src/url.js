const REDDIT_HOST_RE = /(^|\.)reddit\.com$/i;

function isAllowedRedditHost(hostname, allowedHosts = []) {
  const host = String(hostname || "").toLowerCase();
  const allowed = new Set(allowedHosts.map((item) => item.toLowerCase()));
  return host === "redd.it" || REDDIT_HOST_RE.test(host) || allowed.has(host);
}

function normalizeRedditUrl(input, allowedHosts) {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, errorCode: "invalid_url", errorMessageSafe: "A Reddit URL is required." };
  }

  let parsed;
  try {
    parsed = new URL(input.trim());
  } catch (_error) {
    return { ok: false, errorCode: "invalid_url", errorMessageSafe: "The submitted URL is invalid." };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, errorCode: "invalid_url", errorMessageSafe: "Only http or https Reddit URLs are accepted." };
  }

  if (!isAllowedRedditHost(parsed.hostname, allowedHosts)) {
    return { ok: false, errorCode: "non_reddit_url", errorMessageSafe: "Only Reddit or redd.it URLs are accepted." };
  }

  parsed.protocol = "https:";
  parsed.hash = "";
  return {
    ok: true,
    normalizedUrl: parsed.toString(),
    hostname: parsed.hostname.toLowerCase()
  };
}

function validateFinalRedditUrl(finalUrl, allowedHosts) {
  const normalized = normalizeRedditUrl(finalUrl, allowedHosts);
  if (!normalized.ok) {
    return {
      ok: false,
      errorCode: "redirect_target_not_reddit",
      errorMessageSafe: "The final redirect target is not a Reddit URL."
    };
  }
  return normalized;
}

module.exports = {
  isAllowedRedditHost,
  normalizeRedditUrl,
  validateFinalRedditUrl
};

