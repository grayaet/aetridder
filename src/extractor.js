const path = require("node:path");

const { validateFinalRedditUrl } = require("./url");
const { writeBufferArtifact, writeJsonArtifact, writeTextArtifact } = require("./artifacts");

const BROWSER_LIKE_HEADERS = Object.freeze({
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36 Aetridder/0.1",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9"
});

function cleanText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

function expectedPostIdFromUrl(url) {
  const match = String(url || "").match(/\/comments\/([^/?#]+)/i);
  return match ? `t3_${match[1]}` : null;
}

function postRouteFromUrl(url) {
  const match = String(url || "").match(/\/r\/([^/]+)\/comments\/([^/?#]+)/i);
  if (!match) {
    return null;
  }
  return {
    subreddit: match[1],
    postShortId: match[2],
    postId: `t3_${match[2]}`
  };
}

function subredditListingUrlFromRedditUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    return null;
  }
  const match = parsed.pathname.match(/^\/r\/([^/]+)/i);
  if (!match) {
    return null;
  }
  return new URL(`/r/${match[1]}/`, "https://www.reddit.com").toString();
}

function canonicalCommentId(rawId) {
  const match = String(rawId || "").match(/t1_[a-z0-9_]+/i);
  return match ? match[0] : String(rawId || "");
}

function normalizePartialMethod(method) {
  const normalized = String(method || "GET").trim().toUpperCase();
  return normalized === "POST" ? "POST" : "GET";
}

function parentHintFromSlot(slot) {
  const match = String(slot || "").match(/children-(t1_[a-z0-9_]+)/i);
  return match ? canonicalCommentId(match[1]) : null;
}

function normalizedUrlForKey(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = "";
  const sorted = Array.from(url.searchParams.entries())
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    );
  url.search = "";
  for (const [name, value] of sorted) {
    url.searchParams.append(name, value);
  }
  return url.toString();
}

function sortedFormFieldsForKey(formFields) {
  return (Array.isArray(formFields) ? formFields : [])
    .map((field) => ({
      name: String(field && field.name ? field.name : ""),
      value: String(field && field.value !== undefined ? field.value : "")
    }))
    .filter((field) => field.name)
    .sort((left, right) => left.name.localeCompare(right.name) || left.value.localeCompare(right.value));
}

function commentPartialRequestKey(request) {
  return JSON.stringify({
    method: normalizePartialMethod(request.method),
    url: normalizedUrlForKey(request.url),
    formFields: sortedFormFieldsForKey(request.formFields)
  });
}

function normalizeCommentPartialRequest(request) {
  const normalized = {
    method: normalizePartialMethod(request.method),
    url: new URL(request.url).toString(),
    src: request.src || request.url,
    formFields: Array.isArray(request.formFields) ? request.formFields : [],
    slot: request.slot || null,
    parentIdHint: request.parentIdHint || parentHintFromSlot(request.slot)
  };
  return {
    ...normalized,
    key: commentPartialRequestKey(normalized)
  };
}

function uniqueMoreCommentRequests(requests) {
  const seen = new Set();
  const unique = [];
  let duplicateCount = 0;
  for (const request of requests) {
    const normalized = normalizeCommentPartialRequest(request);
    if (seen.has(normalized.key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(normalized.key);
    unique.push(normalized);
  }
  return { unique, duplicateCount };
}

function looksLikeRedditVerificationPage(title, bodyText) {
  const combined = `${title || ""} ${bodyText || ""}`;
  return /reddit\s*-\s*please wait for verification|please wait for verification|js_challenge|network policy|checking your browser|verify you are human|cf-browser-verification|cloudflare ray id|request blocked/i.test(combined);
}

function safeSnippet(text, limit = 500) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function safeDebugUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const name of Array.from(url.searchParams.keys())) {
      if (/token|solution|challenge|jsc|share_id/i.test(name)) {
        url.searchParams.set(name, "[redacted]");
      }
    }
    return url.toString();
  } catch (_error) {
    return "";
  }
}

function stripRedditRuntimeParams(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const name of Array.from(url.searchParams.keys())) {
      if (/^(solution|js_challenge|token|jsc_orig_r|share_id)$/i.test(name) || /^utm_/i.test(name)) {
        url.searchParams.delete(name);
      }
    }
    return url.toString();
  } catch (_error) {
    return rawUrl;
  }
}

async function readPageDebugSnapshot(page, reason = "page_check") {
  const pageTitle = await page.title().catch(() => "");
  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  return {
    schemaVersion: "aetridder.extractor-debug.v1",
    reason,
    capturedAt: new Date().toISOString(),
    finalUrl: safeDebugUrl(page.url()),
    pageTitle,
    bodySnippet: safeSnippet(bodyText),
    verificationOrBlockPageDetected: looksLikeRedditVerificationPage(pageTitle, bodyText)
  };
}

async function writePageDebugArtifacts(page, workDir, config, reason, log = () => {}) {
  const snapshot = await readPageDebugSnapshot(page, reason);
  writeJsonArtifact(workDir, "extractor-debug.json", snapshot, config);
  const html = await page.content().catch(() => "");
  if (html) {
    writeTextArtifact(workDir, "reddit-verification-page-snippet.html", safeSnippet(html, 50000), config);
  }
  try {
    const screenshot = await page.screenshot({ fullPage: true });
    writeBufferArtifact(workDir, "reddit-verification-screenshot.png", screenshot, config);
  } catch (_error) {
    log("verification screenshot unavailable");
  }
  return snapshot;
}

async function waitForRedditPageAfterChallenge(page, { config = {}, log = () => {}, purpose = "page" } = {}) {
  let snapshot = await readPageDebugSnapshot(page, `${purpose}_initial_check`);
  if (!snapshot.verificationOrBlockPageDetected) {
    return snapshot;
  }

  log(`${purpose} verification page detected; waiting for Reddit browser challenge`);
  const maxWaitMs = Math.min(Math.max(config.redditChallengeWaitMs || 15000, 3000), config.extractionTimeoutMs || 90000);
  const deadline = Date.now() + maxWaitMs;
  const baseDelayMs = config.redditChallengePollMs || 1500;
  let attempt = 0;
  while (Date.now() < deadline && attempt < 5) {
    attempt += 1;
    await page.waitForLoadState("networkidle", { timeout: Math.min(5000, maxWaitMs) }).catch(() => {});
    await page.waitForTimeout(Math.min(baseDelayMs + attempt * 500, 3500));
    snapshot = await readPageDebugSnapshot(page, `${purpose}_challenge_wait_${attempt}`);
    if (!snapshot.verificationOrBlockPageDetected) {
      log(`${purpose} verification page cleared after wait ${attempt}`);
      return snapshot;
    }
    if (attempt === 2) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: Math.min(10000, config.extractionTimeoutMs || 90000) }).catch(() => {});
    }
  }
  return snapshot;
}

function emptyExpansionMetrics(overrides = {}) {
  return {
    visibleCommentCount: 0,
    totalCommentCount: 0,
    discoveredMoreRequestCount: 0,
    uniqueMoreRequestCount: 0,
    fetchedMoreRequestCount: 0,
    duplicateMoreRequestCount: 0,
    failedMoreRequestCount: 0,
    unresolvedMoreRequestCount: 0,
    limitReached: false,
    extractedUniqueCommentCount: 0,
    maxDepthExtracted: 0,
    partialArtifactsCount: 0,
    ...overrides
  };
}

function partialFetchNeedsWarning(metrics) {
  return Boolean(
    metrics.failedMoreRequestCount > 0 ||
    metrics.unresolvedMoreRequestCount > 0 ||
    metrics.limitReached
  );
}

async function collectMoreCommentRequests(page, finalUrl, html = null, inheritedParentIdHint = null) {
  const route = postRouteFromUrl(finalUrl);
  if (!route) {
    return [];
  }

  const requests = await page.evaluate(({ finalUrl, html, route, inheritedParentIdHint }) => {
    const container = html === null ? document : document.createElement("div");
    if (html !== null) {
      container.innerHTML = html;
    }
    const base = new URL(finalUrl);
    const currentOrigin = base.origin;
    const currentSubreddit = String(route.subreddit || "").toLowerCase();
    const currentPostIds = new Set([
      String(route.postId || "").toLowerCase(),
      String(route.postShortId || "").toLowerCase()
    ].filter(Boolean));
    const parentHintFromSlot = (slot) => {
      const match = String(slot || "").match(/children-(t1_[a-z0-9_]+)/i);
      return match ? match[1] : null;
    };
    const normalizeMethod = (method) => String(method || "GET").trim().toUpperCase() === "POST" ? "POST" : "GET";

    return Array.from(container.querySelectorAll("faceplate-partial"))
      .map((node) => {
        const rawSrc = node.getAttribute("src") || "";
        if (!rawSrc) {
          return null;
        }
        let url;
        try {
          url = new URL(rawSrc, finalUrl);
        } catch (_error) {
          return null;
        }
        const path = url.pathname.toLowerCase();
        if (url.origin !== currentOrigin || !path.includes("/svc/shreddit/more-comments/")) {
          return null;
        }
        if (currentSubreddit && !path.includes(`/${currentSubreddit}/`)) {
          return null;
        }
        const belongsToCurrentPost = Array.from(currentPostIds).some((postId) => path.includes(`/${postId}`));
        if (!belongsToCurrentPost) {
          return null;
        }

        const slot = node.getAttribute("slot") || null;
        const formFields = Array.from(node.querySelectorAll("input[name]"))
          .map((input) => ({
            name: input.getAttribute("name") || "",
            value: input.getAttribute("value") ?? input.value ?? ""
          }))
          .filter((field) => field.name);

        return {
          method: normalizeMethod(node.getAttribute("method")),
          src: rawSrc,
          url: url.toString(),
          formFields,
          slot,
          parentIdHint: parentHintFromSlot(slot) || inheritedParentIdHint || null
        };
      })
      .filter(Boolean);
  }, { finalUrl, html, route, inheritedParentIdHint });

  return requests.map(normalizeCommentPartialRequest);
}

async function collectMoreCommentRequestsFromPage(page, finalUrl) {
  return collectMoreCommentRequests(page, finalUrl);
}

async function fetchCommentPartial(page, request) {
  return page.evaluate(async ({ request }) => {
    const headers = {
      accept: "text/vnd.reddit.partial+html,text/html,*/*;q=0.8"
    };
    const init = {
      method: request.method,
      headers,
      redirect: "follow",
      credentials: "same-origin"
    };
    if (request.method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(request.formFields.map((field) => [field.name, field.value])).toString();
    }
    const response = await fetch(request.url, init);
    const html = await response.text();
    return {
      src: request.src,
      url: request.url,
      method: request.method,
      status: response.status,
      contentType: response.headers.get("content-type"),
      html,
      byteLength: new TextEncoder().encode(html).byteLength
    };
  }, { request });
}

async function fetchPublicCommentPartials(page, finalUrl, config = {}, log = () => {}) {
  const maxRequests = config.maxCommentPartialRequests || 50;
  const maxBytes = config.maxCommentPartialBytes || config.maxArtifactBytes || 10485760;
  const idleMs = config.commentPartialIdleMs || 0;
  const queue = [];
  const knownKeys = new Set();
  const partials = [];
  const metrics = emptyExpansionMetrics();

  function enqueue(requests) {
    metrics.discoveredMoreRequestCount += requests.length;
    for (const request of requests) {
      if (knownKeys.has(request.key)) {
        metrics.duplicateMoreRequestCount += 1;
        continue;
      }
      knownKeys.add(request.key);
      metrics.uniqueMoreRequestCount = knownKeys.size;
      queue.push(request);
    }
  }

  enqueue(await collectMoreCommentRequests(page, finalUrl));

  while (queue.length > 0 && metrics.fetchedMoreRequestCount + metrics.failedMoreRequestCount < maxRequests) {
    const request = queue.shift();
    let result;
    try {
      result = await fetchCommentPartial(page, request);
    } catch (error) {
      metrics.failedMoreRequestCount += 1;
      log(`comment partial fetch failed ${error.code || error.message} ${request.url}`);
      continue;
    }
    if (result.status < 200 || result.status >= 300 || looksLikeRedditVerificationPage("", result.html)) {
      metrics.failedMoreRequestCount += 1;
      log(`comment partial skipped ${result.status} ${request.url}`);
      continue;
    }
    if (result.byteLength > maxBytes) {
      metrics.failedMoreRequestCount += 1;
      log(`comment partial skipped over byte limit ${result.byteLength} ${request.url}`);
      continue;
    }

    metrics.fetchedMoreRequestCount += 1;
    const partial = {
      ...result,
      requestKey: request.key,
      parentIdHint: request.parentIdHint || null,
      slot: request.slot || null
    };
    partials.push(partial);

    const nested = await collectMoreCommentRequests(page, finalUrl, result.html, request.parentIdHint || null);
    enqueue(nested);
    if (idleMs > 0 && queue.length > 0) {
      await page.waitForTimeout(idleMs);
    }
  }

  metrics.limitReached = queue.length > 0;
  metrics.unresolvedMoreRequestCount = metrics.failedMoreRequestCount + queue.length;
  metrics.partialArtifactsCount = partials.length;

  return {
    partials,
    metrics
  };
}

async function extractThreadFromPage(page, job, options = {}) {
  const finalUrl = page.url();
  const additionalCommentHtml = Array.isArray(options.additionalCommentHtml) ? options.additionalCommentHtml : [];
  const partialContexts = Array.isArray(options.partialContexts)
    ? options.partialContexts
    : additionalCommentHtml.map((html) => ({ html, parentIdHint: null, source: "legacy" }));
  const extracted = await page.evaluate(({ partialContexts }) => {
    const text = (node) => (node && node.innerText ? node.innerText.replace(/\s+/g, " ").trim() : "");
    const textBlockSelector = "p, li, blockquote, pre";
    const normalizeParagraphText = (value) => String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t\f\v]+/g, " ")
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.replace(/\n+/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n\n");
    const markdownHref = (href) => {
      try {
        const url = new URL(href, document.location.href);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return null;
        }
        return url.href.replace(/\)/g, "%29");
      } catch (_error) {
        return null;
      }
    };
    const inlineMarkdownText = (root) => {
      let output = "";
      const visit = (node) => {
        if (!node) {
          return;
        }
        if (node.nodeType === Node.TEXT_NODE) {
          output += node.nodeValue || "";
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return;
        }
        const tag = node.tagName.toLowerCase();
        if (tag === "br") {
          output += "\n";
          return;
        }
        if (tag === "a") {
          const label = normalizeParagraphText(node.innerText || node.textContent || "").replace(/\]/g, "\\]");
          const href = markdownHref(node.getAttribute("href") || node.href || "");
          output += label && href ? `[${label}](${href})` : label;
          return;
        }
        for (const child of node.childNodes) {
          visit(child);
        }
      };
      for (const child of root.childNodes) {
        visit(child);
      }
      return output;
    };
    const hasTextBlockAncestorInside = (block, container) => {
      let parent = block.parentElement;
      while (parent && parent !== container) {
        if (parent.matches && parent.matches(textBlockSelector)) {
          return true;
        }
        parent = parent.parentElement;
      }
      return false;
    };
    const blockMarkdownText = (block) => {
      const body = normalizeParagraphText(inlineMarkdownText(block));
      if (!body) {
        return "";
      }
      const tag = block.tagName.toLowerCase();
      if (tag === "blockquote") {
        return body.split(/\n{2,}/).map((paragraph) => `> ${paragraph}`).join("\n\n");
      }
      if (tag === "li") {
        return body.split(/\n{2,}/).map((paragraph, index) => index === 0 ? `- ${paragraph}` : `  ${paragraph}`).join("\n\n");
      }
      return body;
    };
    const bodyText = (node) => {
      if (!node) {
        return "";
      }
      const blocks = Array.from(node.querySelectorAll(textBlockSelector))
        .filter((block) => !hasTextBlockAncestorInside(block, node))
        .map((block) => blockMarkdownText(block))
        .filter(Boolean);
      if (blocks.length > 0) {
        return blocks.join("\n\n");
      }
      return normalizeParagraphText(inlineMarkdownText(node) || node.innerText || node.textContent || "");
    };
    const attr = (node, name) => (node ? node.getAttribute(name) : null);
    const first = (selectors) => {
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node && text(node)) {
          return node;
        }
      }
      return null;
    };
    const authorFrom = (root) => {
      const authorAttr = attr(root, "author");
      if (authorAttr) {
        const profilePath = `/user/${authorAttr.replace(/^u\//i, "")}/`;
        return {
          author: authorAttr.replace(/^u\//i, "") || "[deleted]",
          authorProfileUrl: new URL(profilePath, document.location.href).href
        };
      }
      const link = root.querySelector('a[href*="/user/"], a[href*="/u/"]');
      if (!link) {
        return { author: "[deleted]", authorProfileUrl: null };
      }
      return {
        author: text(link).replace(/^u\//i, "") || "[deleted]",
        authorProfileUrl: link.href || null
      };
    };
    const scoreFrom = (root) => {
      const scoreAttr = attr(root, "score");
      if (scoreAttr) {
        return scoreAttr;
      }
      const scoreNode = root.querySelector('[data-testid*="score"], [id*="score"], faceplate-number, .score');
      const scoreText = scoreNode ? text(scoreNode) : "";
      return scoreText || null;
    };
    const timeFrom = (root) => {
      const created = attr(root, "created");
      if (created) {
        return created;
      }
      const time = root.querySelector("time");
      return time ? (attr(time, "datetime") || text(time)) : null;
    };
    const numberFromText = (value) => {
      const raw = String(value || "").replace(/,/g, "").trim();
      const match = raw.match(/(\d+(?:\.\d+)?)\s*([km])?/i);
      if (!match) {
        return 0;
      }
      const base = Number(match[1]);
      if (!Number.isFinite(base)) {
        return 0;
      }
      const suffix = String(match[2] || "").toLowerCase();
      const multiplier = suffix === "m" ? 1000000 : suffix === "k" ? 1000 : 1;
      return Math.max(0, Math.round(base * multiplier));
    };
    const totalCommentCountFrom = (root) => {
      const attrValue =
        attr(root, "comment-count") ||
        attr(root, "comments") ||
        attr(root, "num-comments") ||
        attr(root, "number-comments");
      return numberFromText(attrValue);
    };
    const screenviewCommentCount = () => {
      for (const node of document.querySelectorAll("shreddit-screenview-data[data]")) {
        try {
          const parsed = JSON.parse(node.getAttribute("data") || "{}");
          const count = Number(parsed && parsed.post && parsed.post.number_comments);
          if (Number.isSafeInteger(count) && count >= 0) {
            return count;
          }
        } catch (_error) {
          // Ignore non-JSON telemetry fragments.
        }
      }
      return 0;
    };

    const titleNode = first(["h1", "shreddit-title", '[slot="title"]']);
    const bodyNode = first([
      '[data-test-id="post-content"]',
      '[data-testid="post-content"]',
      "shreddit-post div[slot='text-body']",
      "shreddit-post [slot='text-body']",
      ".usertext-body",
      "article"
    ]);
    const postRoot = document.querySelector("shreddit-post, [data-testid='post-container'], article") || document.body;
    const postAuthor = authorFrom(postRoot);
    const totalCommentCount =
      totalCommentCountFrom(postRoot) ||
      totalCommentCountFrom(document.querySelector("shreddit-post-overflow-menu")) ||
      screenviewCommentCount();
    const postId =
      attr(postRoot, "id") ||
      attr(postRoot, "thingid") ||
      attr(postRoot, "post-id") ||
      "post";

    const canonicalCommentId = (rawId) => {
      const match = String(rawId || "").match(/t1_[a-z0-9_]+/i);
      return match ? match[0] : String(rawId || "");
    };
    const isPlaceholderBody = (body) => /^\[(deleted|removed)\]$/i.test(String(body || "").trim());
    const commentRoots = [{ root: document, parentIdHint: null, source: "base" }];
    for (const context of partialContexts) {
      const container = document.createElement("div");
      container.innerHTML = context.html || "";
      commentRoots.push({
        root: container,
        parentIdHint: context.parentIdHint || null,
        source: context.source || "partial"
      });
    }
    const hasUnresolvedMoreComments = commentRoots.some((root) => {
      if (root.root.querySelector('faceplate-partial[src*="more-comments"], faceplate-partial[src*="/comments/"]')) {
        return true;
      }
      return Array.from(root.root.querySelectorAll("button, a, shreddit-comment-action-row"))
        .some((node) => /more comments|view more replies|continue this thread/i.test(text(node)));
    });
    const comments = [];
    const seen = new Map();
    let visibleCommentCount = 0;
    let maxDepthExtracted = 0;
    let unresolvedParentCount = 0;

    function rawCommentNodes(root) {
      const preferredComments = Array.from(root.querySelectorAll("shreddit-comment"));
      return preferredComments.length > 0
        ? preferredComments
        : Array.from(root.querySelectorAll("[data-testid='comment'], div[id^='t1_'], .comment"));
    }

    for (const context of commentRoots) {
      const rawComments = rawCommentNodes(context.root);
      if (context.source === "base") {
        visibleCommentCount = rawComments.length;
      }
      for (const node of rawComments) {
        const body =
          bodyText(node.querySelector("[slot='comment'], [data-testid='comment-content'], .md, .usertext-body")) ||
          text(node);
        if (!body || body.length < 2) {
          continue;
        }
        const rawId = attr(node, "thingid") || attr(node, "comment-id") || attr(node, "id") || `comment-${comments.length + 1}`;
        const id = canonicalCommentId(rawId);
        const author = authorFrom(node);
        const depthRaw = attr(node, "depth") || node.style.getPropertyValue("--depth") || "0";
        const depth = Number.parseInt(depthRaw, 10);
        const normalizedDepth = Number.isSafeInteger(depth) && depth >= 0 ? depth : 0;
        maxDepthExtracted = Math.max(maxDepthExtracted, normalizedDepth);
        const rawParentId =
          attr(node, "parentid") ||
          attr(node, "parent-id") ||
          attr(node, "data-parentid") ||
          attr(node, "data-parent-id");
        let parentId = null;
        let parentInferenceSource = null;
        let parentInferenceWarning = null;
        if (rawParentId) {
          parentId = canonicalCommentId(rawParentId);
          parentInferenceSource = "explicit_attr";
        } else if (context.parentIdHint) {
          parentId = canonicalCommentId(context.parentIdHint);
          parentInferenceSource = "partial_slot_hint";
        } else if (normalizedDepth === 0) {
          parentId = postId;
          parentInferenceSource = "top_level_depth";
        } else {
          parentInferenceSource = "unresolved";
          parentInferenceWarning = "parent_unresolved";
          unresolvedParentCount += 1;
        }
        const candidate = {
          id,
          parentId,
          order: comments.length,
          depth: normalizedDepth,
          author: author.author,
        authorProfileUrl: author.authorProfileUrl,
        score: scoreFrom(node),
        timestamp: timeFrom(node),
        bodyMarkdown: body,
          metadata: {
            originalDomId: rawId,
            extractionSelector: node.tagName.toLowerCase(),
            parentInferenceSource,
            parentInferenceWarning
          }
        };
        if (seen.has(id)) {
          const existingIndex = seen.get(id);
          const existing = comments[existingIndex];
          if ((!existing.bodyMarkdown || isPlaceholderBody(existing.bodyMarkdown)) && candidate.bodyMarkdown && !isPlaceholderBody(candidate.bodyMarkdown)) {
            comments[existingIndex] = {
              ...candidate,
              order: existing.order,
              metadata: {
                ...candidate.metadata,
                duplicateMerge: "replaced_placeholder_body"
              }
            };
          }
          continue;
        }
        seen.set(id, comments.length);
        comments.push(candidate);
      }
    }

    return {
      post: {
        id: postId,
        title: titleNode ? text(titleNode) : "",
        bodyMarkdown: bodyNode ? bodyText(bodyNode) : "",
        author: postAuthor.author,
        authorProfileUrl: postAuthor.authorProfileUrl,
        score: scoreFrom(postRoot),
        timestamp: timeFrom(postRoot),
        metadata: {
          extractionSelector: postRoot.tagName.toLowerCase()
        }
      },
      comments,
      hasUnresolvedMoreComments,
      visibleCommentCount,
      totalCommentCount,
      maxDepthExtracted,
      unresolvedParentCount
    };
  }, { partialContexts });

  const parserMetrics = emptyExpansionMetrics({
    ...(options.parserMetrics || {}),
    visibleCommentCount: extracted.visibleCommentCount,
    totalCommentCount: extracted.totalCommentCount,
    extractedUniqueCommentCount: extracted.comments.length,
    maxDepthExtracted: extracted.maxDepthExtracted,
    partialArtifactsCount: Array.isArray(partialContexts) ? partialContexts.length : 0
  });
  const warningCodes = [];
  if (
    options.partial ||
    (parserMetrics.totalCommentCount > 0 &&
      parserMetrics.extractedUniqueCommentCount > 0 &&
      parserMetrics.extractedUniqueCommentCount < parserMetrics.totalCommentCount) ||
    (extracted.unresolvedParentCount > 0 && extracted.hasUnresolvedMoreComments) ||
    (!options.partialExpansionAttempted && extracted.hasUnresolvedMoreComments) ||
    extracted.comments.length === 0
  ) {
    warningCodes.push("partial_comments");
  }

  return {
    schemaVersion: "aetridder.extracted-thread.v1",
    sourceUrl: job.sourceUrl,
    normalizedUrl: job.normalizedUrl,
    finalUrlAfterRedirect: finalUrl,
    extractedAt: new Date().toISOString(),
    post: {
      ...extracted.post,
      title: cleanText(extracted.post.title),
      bodyMarkdown: cleanText(extracted.post.bodyMarkdown)
    },
    comments: extracted.comments.map((comment) => ({
      ...comment,
      bodyMarkdown: cleanText(comment.bodyMarkdown)
    })),
    warningCodes,
    parserMetrics
  };
}

async function extractWithPlaywright(job, { config, workDir, log }) {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    error.status = "extraction_failed";
    error.errorCode = "playwright_unavailable";
    error.errorMessageSafe = "Playwright is not available in this environment.";
    throw error;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      userAgent: BROWSER_LIKE_HEADERS["user-agent"],
      extraHTTPHeaders: {
        "accept-language": BROWSER_LIKE_HEADERS["accept-language"]
      }
    });

    const listingUrl = subredditListingUrlFromRedditUrl(job.normalizedUrl || job.sourceUrl);
    if (listingUrl) {
      log(`warming public Reddit listing ${safeDebugUrl(listingUrl)}`);
      await page.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: config.extractionTimeoutMs }).catch((error) => {
        log(`listing warm-up unavailable: ${error.code || error.message}`);
      });
      await page.waitForTimeout(1200);
      await waitForRedditPageAfterChallenge(page, { config, log, purpose: "listing_warmup" }).catch((error) => {
        log(`listing warm-up challenge wait unavailable: ${error.code || error.message}`);
      });
    }

    log("opening public Reddit URL with Playwright");
    await page.goto(job.normalizedUrl, { waitUntil: "domcontentloaded", timeout: config.extractionTimeoutMs });
    await page.waitForTimeout(1200);
    let pageSnapshot = await waitForRedditPageAfterChallenge(page, { config, log, purpose: "thread" });

    const finalValidation = validateFinalRedditUrl(page.url(), config.allowedHosts);
    if (!finalValidation.ok) {
      const error = new Error(finalValidation.errorCode);
      error.status = "invalid_url";
      error.errorCode = finalValidation.errorCode;
      error.errorMessageSafe = finalValidation.errorMessageSafe;
      throw error;
    }

    if (pageSnapshot.verificationOrBlockPageDetected) {
      pageSnapshot = await writePageDebugArtifacts(page, workDir, config, "reddit_verification_or_block_page", log);
      const error = new Error("reddit_verification_or_block_page");
      error.status = "reddit_unavailable";
      error.errorCode = "reddit_verification_or_block_page";
      error.errorMessageSafe = "Reddit returned a verification or block page instead of the requested thread.";
      error.extractorDebug = pageSnapshot;
      throw error;
    }

    const partialFetch = await fetchPublicCommentPartials(page, page.url(), config, log).catch((error) => {
      log(`comment partial fetch unavailable: ${error.code || error.message}`);
      return {
        partials: [],
        metrics: emptyExpansionMetrics({
          failedMoreRequestCount: 1,
          unresolvedMoreRequestCount: 1
        })
      };
    });
    const commentPartials = partialFetch.partials;
    commentPartials.forEach((partial, index) => {
      writeTextArtifact(workDir, `reddit-comments-partial-${index + 1}.html`, partial.html, config);
    });

    const html = await page.content();
    writeTextArtifact(workDir, "reddit-page.html", html, config);
    writeJsonArtifact(workDir, "extractor-debug.json", {
      ...pageSnapshot,
      reason: "thread_ready",
      finalUrl: safeDebugUrl(page.url()),
      capturedAt: new Date().toISOString()
    }, config);
    try {
      const screenshot = await page.screenshot({ fullPage: true });
      writeBufferArtifact(workDir, "screenshot.png", screenshot, config);
    } catch (_error) {
      log("screenshot unavailable");
    }

    const thread = await extractThreadFromPage(page, job, {
      partialContexts: commentPartials.map((partial) => ({
        html: partial.html,
        parentIdHint: partial.parentIdHint || null,
        source: "partial"
      })),
      parserMetrics: partialFetch.metrics,
      partialExpansionAttempted: true,
      partial: partialFetchNeedsWarning(partialFetch.metrics)
    });
    const expectedPostId = expectedPostIdFromUrl(job.normalizedUrl);
    if (expectedPostId && thread.post.id !== expectedPostId) {
      const error = new Error("requested_thread_id_mismatch");
      error.status = "extraction_failed";
      error.errorCode = "requested_thread_id_mismatch";
      error.errorMessageSafe = "Rendered Reddit content did not match the requested thread id.";
      throw error;
    }
    thread.finalUrlAfterRedirect = stripRedditRuntimeParams(finalValidation.normalizedUrl);
    return { thread };
  } catch (error) {
    if (!error.status) {
      error.status = "reddit_unavailable";
      error.errorCode = error.code || "reddit_page_load_failed";
      error.errorMessageSafe = "Reddit page loading or extraction failed.";
    }
    throw error;
  } finally {
    await browser.close();
  }
}

function localFixturePath(name) {
  return path.join(__dirname, "..", "fixtures", "html", name);
}

module.exports = {
  BROWSER_LIKE_HEADERS,
  collectMoreCommentRequestsFromPage,
  commentPartialRequestKey,
  extractWithPlaywright,
  extractThreadFromPage,
  expectedPostIdFromUrl,
  fetchPublicCommentPartials,
  looksLikeRedditVerificationPage,
  subredditListingUrlFromRedditUrl,
  stripRedditRuntimeParams,
  uniqueMoreCommentRequests,
  waitForRedditPageAfterChallenge,
  localFixturePath
};
