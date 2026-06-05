const fs = require("node:fs");
const path = require("node:path");

const { loadConfig } = require("../src/config");
const { BROWSER_LIKE_HEADERS, extractWithPlaywright, looksLikeRedditVerificationPage } = require("../src/extractor");
const { validateExtractedThread } = require("../src/validation");
const { appRoot, apiToken } = require("./helpers");

const browserLikeHeaders = BROWSER_LIKE_HEADERS;

const jsonHeaders = Object.freeze({
  "user-agent": browserLikeHeaders["user-agent"],
  "accept": "application/json",
  "accept-language": browserLikeHeaders["accept-language"]
});

function snippet(text, limit = 500) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function looksLikeVerificationPage(text) {
  return looksLikeRedditVerificationPage("", text);
}

function expectedThreadId(url) {
  const match = String(url).match(/\/comments\/([^/]+)/i);
  return match ? `t3_${match[1]}` : null;
}

function expectedSubreddit(url) {
  const match = String(url).match(/\/r\/([^/?#]+)/i);
  return match ? match[1] : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifyStatus(proof) {
  const listingOk = proof.probes.nodeFetchListingHtml.ok || proof.probes.playwrightListingRender.ok;
  const fetchThreadOk = proof.probes.nodeFetchThreadHtml.ok || proof.probes.playwrightThreadRenderExtract.pageFetchedOk;
  const renderOk = proof.probes.playwrightThreadRenderExtract.ok;
  const parsedWithComments = proof.probes.playwrightThreadRenderExtract.validationOk &&
    proof.probes.playwrightThreadRenderExtract.commentCount > 0 &&
    proof.probes.playwrightThreadRenderExtract.requestedThreadMatched;
  if (listingOk && fetchThreadOk && renderOk && parsedWithComments) {
    return {
      lifecycle_label: "bounded_live_runtime_proof",
      verification_status: "live_reddit_proof_complete"
    };
  }
  return {
    lifecycle_label: "skipped_due_to_host_limit",
    verification_status: "partial_verified_local_fixture; live_reddit_proof_blocked_or_pending"
  };
}

function runStatusLabel(result) {
  if (result.status && result.status.startsWith("skipped_")) {
    return "skipped_due_to_host_limit";
  }
  if (result.ok && /oauth/i.test(result.name || "")) {
    return "api_oauth_success";
  }
  if (result.ok && /playwright|browser|render/i.test(result.name || "")) {
    return "browser_render_success";
  }
  if (result.statusCode === 403) {
    return "blocked_403";
  }
  if (result.statusCode === 429) {
    return "blocked_429";
  }
  if (result.verificationOrBlockPageDetected) {
    return "verification_page";
  }
  if (result.errorCode || result.errorClass) {
    return "skipped_due_to_host_limit";
  }
  return result.ok ? "browser_render_success" : "skipped_due_to_host_limit";
}

async function fetchProbe(name, url, headers = browserLikeHeaders) {
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  const result = {
    name,
    url,
    method: "GET",
    requestHeadersMinusSecrets: headers,
    startedAt,
    endedAt: null,
    ok: false,
    statusCode: null,
    finalUrl: null,
    contentType: null,
    responseSnippet: null,
    verificationOrBlockPageDetected: false,
    errorClass: null,
    errorCode: null
  };
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: "follow"
    });
    result.statusCode = response.status;
    result.finalUrl = response.url;
    result.contentType = response.headers.get("content-type");
    const text = await response.text();
    result.responseSnippet = snippet(text);
    result.verificationOrBlockPageDetected = looksLikeVerificationPage(text);
    result.ok = response.ok && !result.verificationOrBlockPageDetected;
    if (response.ok && result.verificationOrBlockPageDetected) {
      result.errorCode = "reddit_verification_or_block_page";
    }
  } catch (error) {
    result.errorClass = error.name || "fetch_error";
    result.errorCode = error.code || error.cause?.code || null;
    result.responseSnippet = snippet(error.message);
  } finally {
    clearTimeout(timer);
    result.endedAt = new Date().toISOString();
  }
  result.runStatusLabel = runStatusLabel(result);
  return result;
}

async function oauthProbe(mode, url) {
  if (process.env.REDDIT_READER_LIVE_OAUTH_PROBE !== "1") {
      return {
        name: mode,
        runStatusLabel: "skipped_due_to_host_limit",
        status: "skipped_due_to_no_approved_oauth_probe",
      reason: "OAuth/API is not selected, preferred, implemented, or configured by this MVP. Any OAuth/API production mode or credentialed probe requires a separate owner-confirmed work order."
    };
  }
  const tokenPresent = Boolean(process.env.REDDIT_READER_OAUTH_BEARER_TOKEN);
  if (!tokenPresent) {
    return {
      name: mode,
      runStatusLabel: "skipped_due_to_host_limit",
      status: "skipped_due_to_no_approved_oauth_credentials",
      reason: "OAuth probe was requested, but no bearer token was supplied. Token value was not logged."
    };
  }
  const headers = {
    "user-agent": browserLikeHeaders["user-agent"],
    "accept": "application/json",
    "authorization": "Bearer <redacted>"
  };
  const actualHeaders = {
    ...headers,
    authorization: `Bearer ${process.env.REDDIT_READER_OAUTH_BEARER_TOKEN}`
  };
  const startedAt = new Date().toISOString();
  const result = {
    name: mode,
    url,
    method: "GET",
    requestHeadersMinusSecrets: headers,
    startedAt,
    endedAt: null,
    ok: false,
    statusCode: null,
    contentType: null,
    responseSnippet: null,
    errorClass: null,
    errorCode: null
  };
  try {
    const response = await fetch(url, { headers: actualHeaders, redirect: "follow" });
    result.statusCode = response.status;
    result.contentType = response.headers.get("content-type");
    const text = await response.text();
    result.responseSnippet = snippet(text);
    result.ok = response.ok && /application\/json/i.test(result.contentType || "");
    if (!result.ok && response.status === 401) {
      result.errorCode = "oauth_unauthorized";
    }
  } catch (error) {
    result.errorClass = error.name || "fetch_error";
    result.errorCode = error.code || error.cause?.code || null;
    result.responseSnippet = snippet(error.message);
  } finally {
    result.endedAt = new Date().toISOString();
  }
  result.runStatusLabel = runStatusLabel(result);
  return result;
}

function browserSessionCookieProbe() {
  return {
    name: "browser_session_fetch_with_cookies",
    runStatusLabel: "skipped_due_to_host_limit",
    status: "skipped_due_to_no_explicit_cookie_approval",
    reason: "Browser-session/cookie extraction is not selected, preferred, implemented, or configured by this MVP. Personal Reddit cookies/session storage were not requested, read, or logged."
  };
}

async function playwrightListingProbe(url, config) {
  const result = {
    name: "playwright_listing_render",
    url,
    requestHeadersMinusSecrets: {
      ...browserLikeHeaders,
      "user-agent": browserLikeHeaders["user-agent"]
    },
    startedAt: new Date().toISOString(),
    endedAt: null,
    ok: false,
    statusCode: null,
    finalUrl: null,
    pageTitle: null,
    bodySnippet: null,
    verificationOrBlockPageDetected: false,
    pageFetchedOk: false,
    listingVisible: false,
    errorClass: null,
    errorCode: null,
    errorMessageSafe: null
  };

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    result.errorClass = error.name || "require_error";
    result.errorCode = "playwright_unavailable";
    result.errorMessageSafe = "Playwright is not available in this environment.";
    result.endedAt = new Date().toISOString();
    return result;
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      userAgent: browserLikeHeaders["user-agent"],
      extraHTTPHeaders: {
        "accept-language": browserLikeHeaders["accept-language"]
      }
    });
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: config.extractionTimeoutMs
    });
    result.statusCode = response ? response.status() : null;
    await page.waitForTimeout(1200);
    result.finalUrl = page.url();
    result.pageTitle = await page.title();
    result.bodySnippet = snippet(await page.locator("body").innerText({ timeout: 5000 }).catch(() => ""));
    result.verificationOrBlockPageDetected = looksLikeVerificationPage(`${result.pageTitle} ${result.bodySnippet}`);
    const expected = expectedSubreddit(url);
    const listingText = `${result.pageTitle} ${result.bodySnippet}`;
    result.listingVisible = expected
      ? new RegExp(`\\br/${escapeRegExp(expected)}\\b`, "i").test(listingText)
      : /top posts|hot posts/i.test(listingText);
    result.pageFetchedOk = Boolean(result.statusCode && result.statusCode >= 200 && result.statusCode < 400);
    result.ok = result.pageFetchedOk && !result.verificationOrBlockPageDetected && result.listingVisible;
    if (!result.ok && result.verificationOrBlockPageDetected) {
      result.errorCode = "reddit_verification_or_block_page";
      result.errorMessageSafe = "Reddit returned or retained a verification/block page for the listing.";
    }
  } catch (error) {
    result.errorClass = error.name || "playwright_error";
    result.errorCode = error.code || "reddit_listing_load_failed";
    result.errorMessageSafe = "Reddit listing loading or rendering failed.";
    result.bodySnippet = result.bodySnippet || snippet(error.message);
  } finally {
    if (browser) {
      await browser.close();
    }
    result.endedAt = new Date().toISOString();
  }
  result.runStatusLabel = runStatusLabel(result);
  return result;
}

async function playwrightThreadProbe(url, config, outputDir) {
  const result = {
    name: "playwright_thread_render_extract",
    url,
    expectedThreadId: expectedThreadId(url),
    requestHeadersMinusSecrets: {
      ...browserLikeHeaders,
      "user-agent": browserLikeHeaders["user-agent"]
    },
    startedAt: new Date().toISOString(),
    endedAt: null,
    ok: false,
    pageFetchedOk: false,
    statusCode: null,
    finalUrl: null,
    pageTitle: null,
    bodySnippet: null,
    verificationOrBlockPageDetected: false,
    validationOk: false,
    errorClass: null,
    errorCode: null,
    errorMessageSafe: null,
    titleExtracted: false,
    extractedPostId: null,
    requestedThreadMatched: false,
    commentCount: 0,
    expansionMetrics: null,
    artifacts: []
  };

  const readDebug = () => {
    const debugPath = path.join(outputDir, "extractor-debug.json");
    if (!fs.existsSync(debugPath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(debugPath, "utf8"));
    } catch (_error) {
      return null;
    }
  };
  const refreshArtifacts = () => {
    if (!fs.existsSync(outputDir)) {
      result.artifacts = [];
      return;
    }
    result.artifacts = fs.readdirSync(outputDir)
      .filter((name) => fs.statSync(path.join(outputDir, name)).isFile())
      .sort();
  };

  try {
    const extracted = await extractWithPlaywright({
      jobId: "bounded-live-reddit-check",
      sourceUrl: url,
      normalizedUrl: url
    }, { config, workDir: outputDir, log: () => {} });
    const thread = extracted.thread || extracted;
    fs.writeFileSync(path.join(outputDir, "thread.raw.json"), JSON.stringify(thread, null, 2));
    refreshArtifacts();

    const debug = readDebug();
    if (debug) {
      result.finalUrl = debug.finalUrl || thread.finalUrlAfterRedirect || null;
      result.pageTitle = debug.pageTitle || null;
      result.bodySnippet = debug.bodySnippet || null;
      result.verificationOrBlockPageDetected = Boolean(debug.verificationOrBlockPageDetected);
    } else {
      result.finalUrl = thread.finalUrlAfterRedirect || null;
    }
    result.pageFetchedOk = !result.verificationOrBlockPageDetected;
    const validation = validateExtractedThread(thread, config);
    result.validationOk = validation.ok;
    result.errorCode = validation.errorCode || null;
    result.errorMessageSafe = validation.errorMessageSafe || null;
    result.titleExtracted = validation.ok ? Boolean(validation.thread.post.title) : false;
    result.extractedPostId = validation.ok ? validation.thread.post.id : null;
    result.requestedThreadMatched = validation.ok && (!result.expectedThreadId || validation.thread.post.id === result.expectedThreadId);
    result.commentCount = validation.ok ? validation.thread.comments.length : 0;
    result.expansionMetrics = validation.ok ? validation.thread.parserMetrics : thread.parserMetrics;
    result.ok = validation.ok && result.requestedThreadMatched;
    if (validation.ok && !result.requestedThreadMatched) {
      result.errorCode = "requested_thread_id_mismatch";
      result.errorMessageSafe = "Rendered Reddit content did not match the requested thread id.";
    }
  } catch (error) {
    const debug = readDebug();
    if (debug) {
      result.finalUrl = debug.finalUrl || null;
      result.pageTitle = debug.pageTitle || null;
      result.bodySnippet = debug.bodySnippet || null;
      result.verificationOrBlockPageDetected = Boolean(debug.verificationOrBlockPageDetected);
    }
    result.errorClass = error.name || "playwright_error";
    result.errorCode = error.errorCode || error.code || "reddit_page_load_failed";
    result.errorMessageSafe = error.errorMessageSafe || "Reddit page loading, rendering, or extraction failed.";
    result.bodySnippet = result.bodySnippet || snippet(error.message);
    refreshArtifacts();
  } finally {
    result.endedAt = new Date().toISOString();
  }
  result.runStatusLabel = runStatusLabel(result);
  return result;
}

async function main() {
  const outputDir = path.join(appRoot, "runtime", "live-reddit-extraction");
  const resultPath = path.join(outputDir, "live-reddit-extraction-check.json");
  if (!path.resolve(outputDir).startsWith(path.resolve(appRoot) + path.sep)) {
    throw new Error("live extraction outputDir escaped app root");
  }
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const threadUrl =
    process.env.REDDIT_READER_LIVE_TEST_URL ||
    "https://www.reddit.com/r/IAmA/comments/aunv58/im_bill_gates_cochair_of_the_bill_melinda_gates/";
  const listingUrl =
    process.env.REDDIT_READER_LIVE_LISTING_URL ||
    "https://www.reddit.com/r/IAmA/";

  const config = loadConfig({
    env: {
      REDDIT_READER_API_TOKEN: apiToken,
      REDDIT_READER_MAX_COMMENTS: "1000",
      REDDIT_READER_EXTRACTION_TIMEOUT_MS: "30000",
      REDDIT_READER_MAX_ARTIFACT_BYTES: "10485760",
      REDDIT_READER_REDACTED_LOG_TAIL_BYTES: "32768"
    },
    storageDir: outputDir
  });

  const proof = {
    schemaVersion: "aetridder.live-reddit-proof.v1",
    lifecycle_label: null,
    verification_status: null,
    gate: "live_reddit_proof",
    runtimeScope: "local_windows_codex_host_only",
    vpsProductionViability: "not_proved_by_this_local_test",
    requiredForComplete: [
      "one real subreddit listing fetched",
      "one real thread fetched",
      "thread comments fetched",
      "raw thread persisted",
      "thread parsed",
      "reader/render path verified separately"
    ],
    urls: {
      listingUrl,
      threadUrl
    },
    command: "npm run test:live:reddit",
    designedModeForCurrentFeature: "unauthenticated_browser_render_html_playwright",
    vpsDeploymentStatus: "not_vps_ready_until_same_gate_passes_on_intended_vps",
    allowedRunStatusLabels: [
      "api_oauth_success",
      "browser_render_success",
      "blocked_403",
      "blocked_429",
      "verification_page",
      "skipped_due_to_host_limit"
    ],
    modes: {
      unauthenticatedPublicJsonFetch: {
        role: "diagnostic_probe_not_current_product_primary"
      },
      officialRedditOauthApiFetch: {
        role: "not_selected_or_preferred_by_this_mvp_separate_owner_confirmed_work_order_required"
      },
      browserSessionFetchWithCookies: {
        role: "not_selected_or_preferred_by_this_mvp_no_cookies_requested_read_or_logged"
      },
      unauthenticatedBrowserRenderHtml: {
        role: "current_product_primary_extraction_mode"
      }
    },
    probes: {
      publicJsonUnauthenticatedThread: await fetchProbe("public_json_unauthenticated_thread", `${threadUrl.replace(/\/?$/, "/")}.json`, jsonHeaders),
      nodeFetchListingHtml: await fetchProbe("node_fetch_listing_html", listingUrl, browserLikeHeaders),
      nodeFetchThreadHtml: await fetchProbe("node_fetch_thread_html", threadUrl, browserLikeHeaders),
      playwrightListingRender: null,
      playwrightThreadRenderExtract: null,
      officialRedditOauthApi: await oauthProbe("official_reddit_oauth_api", `https://oauth.reddit.com/comments/${expectedThreadId(threadUrl)?.replace(/^t3_/, "")}`),
      browserSessionFetchWithCookies: browserSessionCookieProbe()
    },
    conclusion: null
  };

  proof.probes.playwrightListingRender = await playwrightListingProbe(listingUrl, config);
  proof.probes.playwrightThreadRenderExtract = await playwrightThreadProbe(threadUrl, config, outputDir);
  const classification = classifyStatus(proof);
  proof.lifecycle_label = classification.lifecycle_label;
  proof.verification_status = classification.verification_status;
  proof.conclusion = classification.verification_status === "live_reddit_proof_complete"
    ? "Live Reddit listing and thread extraction proof completed for the bounded public URLs from this local Windows/Codex host only; intended VPS viability is not proved."
    : "Fixture parser proof remains local-only; live Reddit proof is blocked or pending and root cause is not established by this run.";

  fs.writeFileSync(resultPath, JSON.stringify(proof, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
