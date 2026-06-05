const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const {
  BROWSER_LIKE_HEADERS,
  collectMoreCommentRequestsFromPage,
  extractThreadFromPage,
  fetchPublicCommentPartials,
  localFixturePath,
  looksLikeRedditVerificationPage,
  stripRedditRuntimeParams,
  subredditListingUrlFromRedditUrl,
  uniqueMoreCommentRequests,
  waitForRedditPageAfterChallenge
} = require("../src/extractor");
const { makeConfig, freshStorage, cleanupStorage } = require("./helpers");

const finalUrl = "https://www.reddit.com/r/test/comments/fixture/title/";

test("shared browser-like headers match production extractor and live smoke expectations", () => {
  assert.match(BROWSER_LIKE_HEADERS["user-agent"], /Windows NT 10\.0/);
  assert.match(BROWSER_LIKE_HEADERS["user-agent"], /Chrome\/125/);
  assert.equal(BROWSER_LIKE_HEADERS["accept-language"], "en-US,en;q=0.9");
  assert.match(BROWSER_LIKE_HEADERS.accept, /text\/html/);
});

test("subreddit listing warm-up URL treats Reddit app share links as normal input", () => {
  assert.equal(
    subredditListingUrlFromRedditUrl("https://www.reddit.com/r/ChatGPT/s/9OgJ8NVu8T"),
    "https://www.reddit.com/r/ChatGPT/"
  );
  assert.equal(
    subredditListingUrlFromRedditUrl("https://www.reddit.com/r/redditdev/comments/1oxazn8/need_api_access/"),
    "https://www.reddit.com/r/redditdev/"
  );
});

test("Reddit runtime challenge params are stripped from persisted final URLs", () => {
  assert.equal(
    stripRedditRuntimeParams("https://www.reddit.com/r/test/comments/abc/title/?solution=abc&js_challenge=1&token=secretish&jsc_orig_r=&share_id=mobile&utm_source=share"),
    "https://www.reddit.com/r/test/comments/abc/title/"
  );
});

test("verification detector ignores ordinary discussion of blocked accounts", () => {
  assert.equal(
    looksLikeRedditVerificationPage(
      "OpenAI banned my account after I paid : r/ChatGPT",
      "My account was locked and some comments mention blocked accounts, but this is normal thread text."
    ),
    false
  );
  assert.equal(
    looksLikeRedditVerificationPage("Reddit - Please wait for verification", "js_challenge"),
    true
  );
});

async function withChromium(t, fn) {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (_error) {
    t.skip("Playwright package unavailable");
    return;
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (_error) {
    t.skip("Playwright Chromium unavailable on this host");
    return;
  }

  try {
    await fn(browser);
  } finally {
    await browser.close();
  }
}

function redditPageHtml(extra = "") {
  return `${fs.readFileSync(localFixturePath("reddit-thread.html"), "utf8")}\n${extra}`;
}

async function pageOnRedditOrigin(browser, html, partialHandler = null) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route("https://www.reddit.com/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname.startsWith("/svc/shreddit/more-comments/") && partialHandler) {
      await partialHandler(route, requestUrl);
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: html
    });
  });
  await page.goto(finalUrl, { waitUntil: "domcontentloaded" });
  return page;
}

test("Playwright extraction reads local Reddit-like fixture when Chromium is available", async (t) => {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (_error) {
    t.skip("Playwright package unavailable");
    return;
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (_error) {
    t.skip("Playwright Chromium unavailable on this host");
    return;
  }

  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(fs.readFileSync(localFixturePath("reddit-thread.html"), "utf8"));
    const thread = await extractThreadFromPage(page, {
      sourceUrl: "https://www.reddit.com/r/test/comments/fixture/title/",
      normalizedUrl: "https://www.reddit.com/r/test/comments/fixture/title/"
    });
    assert.equal(thread.post.id, "t3_fixture");
    assert.equal(thread.post.title, "Fixture English title");
    assert.equal(thread.comments.length, 2);
    assert.equal(thread.comments[0].parentId, "t3_fixture");
    assert.equal(thread.comments[1].parentId, "t1_fixture_a");
    assert.equal(thread.comments[1].depth, 1);
  } finally {
    await browser.close();
  }
});

test("extraction warns when some comments exist but more-comments partials remain unresolved", async (t) => {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (_error) {
    t.skip("Playwright package unavailable");
    return;
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (_error) {
    t.skip("Playwright Chromium unavailable on this host");
    return;
  }

  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const html = `${fs.readFileSync(localFixturePath("reddit-thread.html"), "utf8")}
      <faceplate-partial src="/svc/shreddit/more-comments/test/t3_fixture?render-mode=partial"></faceplate-partial>`;
    await page.setContent(html);
    const thread = await extractThreadFromPage(page, {
      sourceUrl: "https://www.reddit.com/r/test/comments/fixture/title/",
      normalizedUrl: "https://www.reddit.com/r/test/comments/fixture/title/"
    });
    assert.equal(thread.comments.length, 2);
    assert.deepEqual(thread.warningCodes, ["partial_comments"]);
  } finally {
    await browser.close();
  }
});

test("same partial src with different hidden cursor values creates distinct request identities", async (t) => {
  await withChromium(t, async (browser) => {
    const html = redditPageHtml(`
      <faceplate-partial method="POST" src="/svc/shreddit/more-comments/test/t3_fixture?sort=confidence&startingDepth=1" slot="children-t1_fixture_a-0">
        <input type="hidden" name="cursor" value="cursor-one">
      </faceplate-partial>
      <faceplate-partial method="POST" src="/svc/shreddit/more-comments/test/t3_fixture?sort=confidence&startingDepth=1" slot="children-t1_fixture_b-0">
        <input type="hidden" name="cursor" value="cursor-two">
      </faceplate-partial>`);
    const page = await pageOnRedditOrigin(browser, html);
    const requests = await collectMoreCommentRequestsFromPage(page, finalUrl);
    const { unique, duplicateCount } = uniqueMoreCommentRequests(requests);
    assert.equal(requests.length, 2);
    assert.equal(unique.length, 2);
    assert.equal(duplicateCount, 0);
    assert.notEqual(unique[0].key, unique[1].key);
    assert.deepEqual(unique.map((request) => request.formFields[0].value), ["cursor-one", "cursor-two"]);
    await page.close();
  });
});

test("verification challenge wait retries before keeping verification classification", async (t) => {
  await withChromium(t, async (browser) => {
    const storageDir = freshStorage("verification-wait");
    let hits = 0;
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.route(finalUrl, async (route) => {
        hits += 1;
        if (hits === 1) {
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: "<!doctype html><title>Reddit - Please wait for verification</title><body>js_challenge</body>"
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: redditPageHtml()
        });
      });
      await page.goto(finalUrl, { waitUntil: "domcontentloaded" });
      const snapshot = await waitForRedditPageAfterChallenge(page, {
        config: { ...makeConfig(storageDir), redditChallengeWaitMs: 4000, redditChallengePollMs: 1 },
        log: () => {},
        purpose: "fixture_thread"
      });
      assert.equal(snapshot.verificationOrBlockPageDetected, false);
      assert.equal(hits >= 2, true);
      await page.close();
    } finally {
      cleanupStorage(storageDir);
    }
  });
});

test("identical partial src and cursor dedupe to one queued request", async (t) => {
  await withChromium(t, async (browser) => {
    const partial = `
      <faceplate-partial method="POST" src="/svc/shreddit/more-comments/test/t3_fixture?sort=confidence&startingDepth=1" slot="children-t1_fixture_a-0">
        <input type="hidden" name="cursor" value="same-cursor">
      </faceplate-partial>`;
    const page = await pageOnRedditOrigin(browser, redditPageHtml(`${partial}${partial}`));
    const requests = await collectMoreCommentRequestsFromPage(page, finalUrl);
    const { unique, duplicateCount } = uniqueMoreCommentRequests(requests);
    assert.equal(requests.length, 2);
    assert.equal(unique.length, 1);
    assert.equal(duplicateCount, 1);
    await page.close();
  });
});

test("unrelated faceplate partials are ignored", async (t) => {
  await withChromium(t, async (browser) => {
    const html = redditPageHtml(`
      <faceplate-partial src="/svc/shreddit/user-hover-card/test"></faceplate-partial>
      <faceplate-partial src="/svc/shreddit/more-comments/test/t3_other?render-mode=partial"></faceplate-partial>
      <faceplate-partial src="https://evil.example/svc/shreddit/more-comments/test/t3_fixture"></faceplate-partial>`);
    const page = await pageOnRedditOrigin(browser, html);
    const requests = await collectMoreCommentRequestsFromPage(page, finalUrl);
    assert.equal(requests.length, 0);
    await page.close();
  });
});

test("POST partial request sends hidden inputs in request body", async (t) => {
  await withChromium(t, async (browser) => {
    const storageDir = freshStorage("partial-post-body");
    const config = makeConfig(storageDir);
    let captured = null;
    try {
      const html = redditPageHtml(`
        <faceplate-partial method="POST" src="/svc/shreddit/more-comments/test/t3_fixture?sort=confidence&startingDepth=1" slot="children-t1_fixture_a-0">
          <input type="hidden" name="cursor" value="abc 123">
          <input type="hidden" name="token" value="not-a-secret-fixture">
        </faceplate-partial>`);
      const page = await pageOnRedditOrigin(browser, html, async (route) => {
        captured = {
          method: route.request().method(),
          postData: route.request().postData(),
          contentType: route.request().headers()["content-type"]
        };
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<shreddit-comment id="t1_partial" depth="1" parentid="t1_fixture_a"><div slot="comment">Partial body.</div></shreddit-comment>`
        });
      });
      const partialFetch = await fetchPublicCommentPartials(page, finalUrl, config);
      assert.equal(partialFetch.partials.length, 1);
      assert.equal(captured.method, "POST");
      assert.match(captured.contentType, /application\/x-www-form-urlencoded/);
      const body = new URLSearchParams(captured.postData);
      assert.equal(body.get("cursor"), "abc 123");
      assert.equal(body.get("token"), "not-a-secret-fixture");
      await page.close();
    } finally {
      cleanupStorage(storageDir);
    }
  });
});

test("fetched partial HTML recursively discovers nested more-comments requests", async (t) => {
  await withChromium(t, async (browser) => {
    const storageDir = freshStorage("partial-recursive");
    const config = makeConfig(storageDir);
    const seenCursors = [];
    try {
      const html = redditPageHtml(`
        <faceplate-partial method="POST" src="/svc/shreddit/more-comments/test/t3_fixture?render-mode=partial" slot="children-t1_fixture_a-0">
          <input type="hidden" name="cursor" value="first">
        </faceplate-partial>`);
      const page = await pageOnRedditOrigin(browser, html, async (route) => {
        const body = new URLSearchParams(route.request().postData() || "");
        seenCursors.push(body.get("cursor"));
        const responseBody = body.get("cursor") === "first"
          ? `<shreddit-comment id="t1_partial_a" depth="1"><div slot="comment">First partial.</div></shreddit-comment>
             <faceplate-partial method="POST" src="/svc/shreddit/more-comments/test/t3_fixture?render-mode=partial" slot="children-t1_partial_a-0">
               <input type="hidden" name="cursor" value="second">
             </faceplate-partial>`
          : `<shreddit-comment id="t1_partial_b" depth="2"><div slot="comment">Second partial.</div></shreddit-comment>`;
        await route.fulfill({ status: 200, contentType: "text/html", body: responseBody });
      });
      const partialFetch = await fetchPublicCommentPartials(page, finalUrl, config);
      assert.deepEqual(seenCursors, ["first", "second"]);
      assert.equal(partialFetch.partials.length, 2);
      assert.equal(partialFetch.metrics.discoveredMoreRequestCount, 2);
      assert.equal(partialFetch.metrics.fetchedMoreRequestCount, 2);
      await page.close();
    } finally {
      cleanupStorage(storageDir);
    }
  });
});

test("failed partial fetch keeps extracted comments but marks partial_comments", async (t) => {
  await withChromium(t, async (browser) => {
    const storageDir = freshStorage("partial-failed-warning");
    const config = makeConfig(storageDir);
    try {
      const html = redditPageHtml(`
        <faceplate-partial method="POST" src="/svc/shreddit/more-comments/test/t3_fixture?render-mode=partial" slot="children-t1_fixture_a-0">
          <input type="hidden" name="cursor" value="fail">
        </faceplate-partial>`);
      const page = await pageOnRedditOrigin(browser, html, async (route) => {
        await route.fulfill({ status: 500, contentType: "text/html", body: "failed" });
      });
      const partialFetch = await fetchPublicCommentPartials(page, finalUrl, config);
      const thread = await extractThreadFromPage(page, {
        sourceUrl: finalUrl,
        normalizedUrl: finalUrl
      }, {
        parserMetrics: partialFetch.metrics,
        partialExpansionAttempted: true,
        partial: partialFetch.metrics.failedMoreRequestCount > 0
      });
      assert.equal(thread.comments.length, 2);
      assert.deepEqual(thread.warningCodes, ["partial_comments"]);
      assert.equal(thread.parserMetrics.failedMoreRequestCount, 1);
      await page.close();
    } finally {
      cleanupStorage(storageDir);
    }
  });
});

test("partial request limit marks extraction as partial_comments", async (t) => {
  await withChromium(t, async (browser) => {
    const storageDir = freshStorage("partial-limit-warning");
    const config = makeConfig(storageDir, { maxCommentPartialRequests: 1 });
    try {
      const html = redditPageHtml(`
        <faceplate-partial method="POST" src="/svc/shreddit/more-comments/test/t3_fixture?render-mode=partial" slot="children-t1_fixture_a-0">
          <input type="hidden" name="cursor" value="one">
        </faceplate-partial>
        <faceplate-partial method="POST" src="/svc/shreddit/more-comments/test/t3_fixture?render-mode=partial" slot="children-t1_fixture_b-0">
          <input type="hidden" name="cursor" value="two">
        </faceplate-partial>`);
      const page = await pageOnRedditOrigin(browser, html, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<shreddit-comment id="t1_partial_limit" depth="1"><div slot="comment">Limited partial.</div></shreddit-comment>`
        });
      });
      const partialFetch = await fetchPublicCommentPartials(page, finalUrl, config);
      const thread = await extractThreadFromPage(page, {
        sourceUrl: finalUrl,
        normalizedUrl: finalUrl
      }, {
        partialContexts: partialFetch.partials.map((partial) => ({
          html: partial.html,
          parentIdHint: partial.parentIdHint
        })),
        parserMetrics: partialFetch.metrics,
        partialExpansionAttempted: true,
        partial: partialFetch.metrics.limitReached
      });
      assert.equal(partialFetch.metrics.limitReached, true);
      assert.deepEqual(thread.warningCodes, ["partial_comments"]);
      await page.close();
    } finally {
      cleanupStorage(storageDir);
    }
  });
});

test("duplicate comments are deduped by canonical comment id", async (t) => {
  await withChromium(t, async (browser) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(fs.readFileSync(localFixturePath("reddit-thread.html"), "utf8"));
    const thread = await extractThreadFromPage(page, {
      sourceUrl: finalUrl,
      normalizedUrl: finalUrl
    }, {
      additionalCommentHtml: [
        `<shreddit-comment id="t1_fixture_a" depth="0"><div slot="comment">Duplicate body should not replace first.</div></shreddit-comment>`
      ]
    });
    assert.equal(thread.comments.length, 2);
    assert.equal(thread.comments[0].bodyMarkdown, "Fixture English comment one.");
    await page.close();
  });
});

test("partial comment parent can be inferred from children slot hint", async (t) => {
  await withChromium(t, async (browser) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(fs.readFileSync(localFixturePath("reddit-thread.html"), "utf8"));
    const thread = await extractThreadFromPage(page, {
      sourceUrl: finalUrl,
      normalizedUrl: finalUrl
    }, {
      partialContexts: [{
        html: `<shreddit-comment id="t1_partial_child" depth="1"><div slot="comment">Reply without parent attr.</div></shreddit-comment>`,
        parentIdHint: "t1_fixture_a"
      }]
    });
    const partial = thread.comments.find((comment) => comment.id === "t1_partial_child");
    assert.equal(partial.parentId, "t1_fixture_a");
    assert.equal(partial.metadata.parentInferenceSource, "partial_slot_hint");
    assert.equal(thread.parserMetrics.maxDepthExtracted, 1);
    await page.close();
  });
});

test("extraction preserves paragraph breaks in post and comment bodies", async (t) => {
  await withChromium(t, async (browser) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<!doctype html>
      <html><body>
        <shreddit-post id="t3_fixture">
          <a href="https://www.reddit.com/user/post_author/">u/post_author</a>
          <h1>Paragraph fixture title</h1>
          <div slot="text-body">
            <p>Post paragraph one.</p>
            <p>Post paragraph two.</p>
          </div>
        </shreddit-post>
        <shreddit-comment id="t1_paragraph" depth="0" parentid="t3_fixture">
          <a href="https://www.reddit.com/user/post_author/">u/post_author</a>
          <div slot="comment">
            <p>update:</p>
            <p>Thank you for your interest.</p>
            <p>Reddit Data API Team</p>
          </div>
        </shreddit-comment>
      </body></html>`);
    const thread = await extractThreadFromPage(page, {
      sourceUrl: finalUrl,
      normalizedUrl: finalUrl
    });

    assert.equal(thread.post.bodyMarkdown, "Post paragraph one.\n\nPost paragraph two.");
    assert.equal(
      thread.comments[0].bodyMarkdown,
      "update:\n\nThank you for your interest.\n\nReddit Data API Team"
    );
    await page.close();
  });
});

test("extraction dedupes nested quote/list text and preserves safe markdown links", async (t) => {
  await withChromium(t, async (browser) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<!doctype html>
      <html><body>
        <shreddit-post id="t3_fixture" comment-count="12">
          <a href="https://www.reddit.com/user/post_author/">u/post_author</a>
          <h1>Quote list fixture</h1>
          <div slot="text-body"><p>Post body.</p></div>
        </shreddit-post>
        <shreddit-comment id="t1_quote_list" depth="0" parentid="t3_fixture">
          <a href="https://www.reddit.com/user/commenter/">u/commenter</a>
          <div slot="comment">
            <blockquote><p>Turns out the usage limits actually were affected by backend problems</p></blockquote>
            <p>Can you point where exactly he wrote that? <a href="https://example.com/source?x=1">source link</a></p>
            <ul><li><p>First list item</p></li></ul>
          </div>
        </shreddit-comment>
      </body></html>`);
    const thread = await extractThreadFromPage(page, {
      sourceUrl: finalUrl,
      normalizedUrl: finalUrl
    });

    const body = thread.comments[0].bodyMarkdown;
    assert.equal((body.match(/Turns out the usage limits/g) || []).length, 1);
    assert.match(body, /^> Turns out the usage limits/m);
    assert.match(body, /\[source link\]\(https:\/\/example\.com\/source\?x=1\)/);
    assert.match(body, /^- First list item/m);
    assert.equal(thread.parserMetrics.totalCommentCount, 12);
    await page.close();
  });
});

test("comment count mismatch marks partial comments even without failed partial requests", async (t) => {
  await withChromium(t, async (browser) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<!doctype html>
      <html><body>
        <shreddit-post id="t3_fixture" comment-count="3">
          <a href="https://www.reddit.com/user/post_author/">u/post_author</a>
          <h1>Count mismatch fixture</h1>
          <div slot="text-body"><p>Post body.</p></div>
        </shreddit-post>
        <shreddit-comment id="t1_only_comment" depth="0" parentid="t3_fixture">
          <a href="https://www.reddit.com/user/commenter/">u/commenter</a>
          <div slot="comment"><p>Only extracted comment.</p></div>
        </shreddit-comment>
      </body></html>`);
    const thread = await extractThreadFromPage(page, {
      sourceUrl: finalUrl,
      normalizedUrl: finalUrl
    });

    assert.equal(thread.comments.length, 1);
    assert.equal(thread.parserMetrics.totalCommentCount, 3);
    assert.deepEqual(thread.warningCodes, ["partial_comments"]);
    await page.close();
  });
});
