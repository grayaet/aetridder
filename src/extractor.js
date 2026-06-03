const path = require("node:path");

const { validateFinalRedditUrl } = require("./url");
const { writeBufferArtifact, writeTextArtifact } = require("./artifacts");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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

function looksLikeRedditVerificationPage(title, bodyText) {
  return /please wait for verification|js_challenge|network policy|blocked|cloudflare/i.test(`${title || ""} ${bodyText || ""}`);
}

async function fetchPublicCommentPartials(page, finalUrl, log) {
  const route = postRouteFromUrl(finalUrl);
  if (!route) {
    return {
      partials: [],
      discoveredCount: 0,
      failedCount: 0,
      unresolvedCount: 0,
      limitReached: false
    };
  }

  const queue = [
    {
      src: `/svc/shreddit/comments/r/${route.subreddit}/${route.postShortId}?sort=CONFIDENCE&render-mode=partial`,
      discovered: false
    },
    {
      src: `/svc/shreddit/more-comments/${route.subreddit}/${route.postId}?render-mode=partial&top-level=1`,
      discovered: false
    }
  ];
  const seen = new Set();
  const partials = [];
  let discoveredCount = 0;
  let failedCount = 0;
  let limitReached = false;

  while (queue.length > 0 && partials.length < 12) {
    const item = queue.shift();
    const src = item && item.src;
    if (!src || seen.has(src)) {
      continue;
    }
    seen.add(src);
    const result = await page.evaluate(async ({ src }) => {
      const response = await fetch(src, {
        method: src.includes("/more-comments/") ? "POST" : "GET",
        headers: {
          accept: "text/vnd.reddit.partial+html,text/html,*/*;q=0.8"
        },
        redirect: "follow"
      });
      const html = await response.text();
      return {
        src,
        status: response.status,
        contentType: response.headers.get("content-type"),
        html
      };
    }, { src });

    if (result.status < 200 || result.status >= 300 || looksLikeRedditVerificationPage("", result.html)) {
      log(`comment partial skipped ${result.status} ${src}`);
      if (item.discovered) {
        failedCount += 1;
      }
      continue;
    }
    partials.push(result);

    const discovered = Array.from(result.html.matchAll(/<faceplate-partial\b[^>]*\bsrc="([^"]*more-comments[^"]*)"/gi))
      .map((match) => match[1].replace(/&amp;/g, "&"))
      .filter((candidate) => candidate.includes(route.postId));
    for (const candidate of discovered) {
      if (!seen.has(candidate) && queue.length < 20) {
        discoveredCount += 1;
        queue.push({ src: candidate, discovered: true });
      }
    }
  }

  if (queue.length > 0) {
    limitReached = true;
  }

  return {
    partials,
    discoveredCount,
    failedCount,
    unresolvedCount: queue.filter((item) => item && item.discovered).length,
    limitReached
  };
}

async function extractThreadFromPage(page, job, options = {}) {
  const finalUrl = page.url();
  const additionalCommentHtml = Array.isArray(options.additionalCommentHtml) ? options.additionalCommentHtml : [];
  const extracted = await page.evaluate(({ additionalCommentHtml }) => {
    const text = (node) => (node && node.innerText ? node.innerText.replace(/\s+/g, " ").trim() : "");
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
    const postId =
      attr(postRoot, "id") ||
      attr(postRoot, "thingid") ||
      attr(postRoot, "post-id") ||
      "post";

    const canonicalCommentId = (rawId) => {
      const match = String(rawId || "").match(/t1_[a-z0-9_]+/i);
      return match ? match[0] : String(rawId || "");
    };
    const commentRoots = [document];
    for (const html of additionalCommentHtml) {
      const container = document.createElement("div");
      container.innerHTML = html;
      commentRoots.push(container);
    }
    const hasUnresolvedMoreComments = commentRoots.some((root) => {
      if (root.querySelector('faceplate-partial[src*="more-comments"], faceplate-partial[src*="/comments/"]')) {
        return true;
      }
      return Array.from(root.querySelectorAll("button, a, shreddit-comment-action-row"))
        .some((node) => /more comments|view more replies|continue this thread/i.test(text(node)));
    });
    const rawComments = commentRoots.flatMap((root) => {
      const preferredComments = Array.from(root.querySelectorAll("shreddit-comment"));
      return preferredComments.length > 0
        ? preferredComments
        : Array.from(root.querySelectorAll("[data-testid='comment'], div[id^='t1_'], .comment"));
    });
    const comments = [];
    const seen = new Set();
    for (const node of rawComments) {
      const body =
        text(node.querySelector("[slot='comment'], [data-testid='comment-content'], .md, .usertext-body")) ||
        text(node);
      if (!body || body.length < 2) {
        continue;
      }
      const rawId = attr(node, "thingid") || attr(node, "comment-id") || attr(node, "id") || `comment-${comments.length + 1}`;
      const id = canonicalCommentId(rawId);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const author = authorFrom(node);
      const depthRaw = attr(node, "depth") || node.style.getPropertyValue("--depth") || "0";
      const depth = Number.parseInt(depthRaw, 10);
      const normalizedDepth = Number.isSafeInteger(depth) && depth >= 0 ? depth : 0;
      const rawParentId = attr(node, "parentid") || attr(node, "parent-id");
      const parentId = rawParentId ? canonicalCommentId(rawParentId) : (normalizedDepth === 0 ? postId : null);
      comments.push({
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
          extractionSelector: node.tagName.toLowerCase()
        }
      });
    }

    return {
      post: {
        id: postId,
        title: titleNode ? text(titleNode) : "",
        bodyMarkdown: bodyNode ? text(bodyNode) : "",
        author: postAuthor.author,
        authorProfileUrl: postAuthor.authorProfileUrl,
        score: scoreFrom(postRoot),
        timestamp: timeFrom(postRoot),
        metadata: {
          extractionSelector: postRoot.tagName.toLowerCase()
        }
      },
      comments,
      hasUnresolvedMoreComments
    };
  }, { additionalCommentHtml });

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
    warningCodes: options.partial || extracted.hasUnresolvedMoreComments || extracted.comments.length === 0 ? ["partial_comments"] : []
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
      userAgent: "Mozilla/5.0 Aetridder/0.1 public-thread-reader"
    });
    log("opening public Reddit URL with Playwright");
    await page.goto(job.normalizedUrl, { waitUntil: "domcontentloaded", timeout: config.extractionTimeoutMs });
    await page.waitForTimeout(1200);

    const finalValidation = validateFinalRedditUrl(page.url(), config.allowedHosts);
    if (!finalValidation.ok) {
      const error = new Error(finalValidation.errorCode);
      error.status = "invalid_url";
      error.errorCode = finalValidation.errorCode;
      error.errorMessageSafe = finalValidation.errorMessageSafe;
      throw error;
    }

    const pageTitle = await page.title().catch(() => "");
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    if (looksLikeRedditVerificationPage(pageTitle, bodyText)) {
      const error = new Error("reddit_verification_or_block_page");
      error.status = "reddit_unavailable";
      error.errorCode = "reddit_verification_or_block_page";
      error.errorMessageSafe = "Reddit returned a verification or block page instead of the requested thread.";
      throw error;
    }

    const partialFetch = await fetchPublicCommentPartials(page, page.url(), log).catch((error) => {
      log(`comment partial fetch unavailable: ${error.code || error.message}`);
      return {
        partials: [],
        discoveredCount: 0,
        failedCount: 1,
        unresolvedCount: 0,
        limitReached: false
      };
    });
    const commentPartials = partialFetch.partials;
    commentPartials.forEach((partial, index) => {
      writeTextArtifact(workDir, `reddit-comments-partial-${index + 1}.html`, partial.html, config);
    });

    const html = await page.content();
    writeTextArtifact(workDir, "reddit-page.html", html, config);
    try {
      const screenshot = await page.screenshot({ fullPage: true });
      writeBufferArtifact(workDir, "screenshot.png", screenshot, config);
    } catch (_error) {
      log("screenshot unavailable");
    }

    const thread = await extractThreadFromPage(page, job, {
      additionalCommentHtml: commentPartials.map((partial) => partial.html),
      partial: partialFetch.failedCount > 0 || partialFetch.unresolvedCount > 0 || partialFetch.limitReached
    });
    const expectedPostId = expectedPostIdFromUrl(job.normalizedUrl);
    if (expectedPostId && thread.post.id !== expectedPostId) {
      const error = new Error("requested_thread_id_mismatch");
      error.status = "extraction_failed";
      error.errorCode = "requested_thread_id_mismatch";
      error.errorMessageSafe = "Rendered Reddit content did not match the requested thread id.";
      throw error;
    }
    thread.finalUrlAfterRedirect = finalValidation.normalizedUrl;
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
  extractWithPlaywright,
  extractThreadFromPage,
  expectedPostIdFromUrl,
  localFixturePath
};

