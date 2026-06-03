const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const { extractThreadFromPage, localFixturePath } = require("../src/extractor");

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

