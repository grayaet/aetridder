const assert = require("node:assert/strict");
const test = require("node:test");

const { formatTimestamp, renderReaderPage, renderMarkdown } = require("../src/renderer");

const {
  getText,
  requestJson,
  sampleRaw,
  translatedFromRaw,
  waitForStatus,
  withServer
} = require("./helpers");

test("reader renders translated content with nested comments and metadata", async () => {
  await withServer({
    name: "reader-ukrainian",
    extractor: async () => ({ thread: sampleRaw({ warningCodes: ["partial_comments"] }) }),
    translator: async (raw) => ({ thread: translatedFromRaw(raw) })
  }, async ({ baseUrl }) => {
    const post = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/demo/english_title/"
    });
    await waitForStatus(baseUrl, post.body.jobId, "ready_with_warning");
    const page = await getText(baseUrl, `/t/${post.body.jobId}`);

    assert.equal(page.status, 200);
    assert.match(page.text, /Перекладений заголовок для перевірки/);
    assert.match(page.text, /Перекладений коментар 1/);
    assert.match(page.text, /Перекладений коментар 2/);
    assert.match(page.text, /commenter_one/);
    assert.match(page.text, /7 points/);
    assert.match(page.text, /2026-06-02 17:10/);
    assert.doesNotMatch(page.text, /2026-06-02T17:10:00.000Z/);
    assert.match(page.text, /Comments were partially extracted/);
    assert.doesNotMatch(page.text, /English title for testing/);
    assert.doesNotMatch(page.text, /First English comment/);
  });
});

test("reader formats timestamps, preserves paragraphs, and marks OP comments", () => {
  const translatedThread = translatedFromRaw(sampleRaw());
  translatedThread.post.author = "nikthefurry";
  translatedThread.post.timestamp = "2025-11-16T23:36:12.085000+0000";
  translatedThread.comments[0] = {
    ...translatedThread.comments[0],
    author: "nikthefurry",
    timestamp: "2025-11-16T23:36:12.085000+0000",
    bodyMarkdown: [
      "оновлення:",
      "Дякуємо за ваш інтерес до використання Reddit Data API.",
      "Ми розглянули ваш нещодавній запит на доступ.",
      "Дякуємо,",
      "Команда Reddit Data API"
    ].join("\n\n")
  };

  const html = renderReaderPage({
    status: "ready",
    warningCodes: [],
    translatedThread
  });

  assert.equal(formatTimestamp("2025-11-16T23:36:12.085000+0000"), "2025-11-16 23:36");
  assert.match(html, /2025-11-16 23:36/);
  assert.doesNotMatch(html, /2025-11-16T23:36/);
  assert.match(html, /<span class="op-badge">OP<\/span>/);
  assert.match(html, /<p>оновлення:<\/p><p>Дякуємо за ваш інтерес/);
  assert.match(html, /<p>Дякуємо,<\/p><p>Команда Reddit Data API<\/p>/);
  assert.match(html, /main \{[^}]*text-align: left;/);
  assert.match(html, /\.body \{[^}]*text-align: left;/);
  assert.match(html, /\.comment \{[^}]*text-align: left;/);
});

test("reader shows counts, post links, comment permalinks, and clickable body links", () => {
  const raw = sampleRaw();
  raw.finalUrlAfterRedirect = "https://www.reddit.com/r/test/comments/demo/english_title/";
  raw.comments[0] = {
    ...raw.comments[0],
    id: "t1_commentabc"
  };
  const translatedThread = translatedFromRaw(raw);
  translatedThread.comments[0] = {
    ...translatedThread.comments[0],
    id: "t1_commentabc",
    bodyMarkdown: "Див. [документацію](https://example.com/docs) і https://example.com/plain."
  };

  const html = renderReaderPage({
    status: "ready",
    warningCodes: [],
    extractorReport: {
      metrics: {
        totalCommentCount: 9
      }
    },
    translatedThread
  });

  assert.match(html, /Comments: extracted 2 of 9/);
  assert.equal((html.match(/>Original<\/a>/g) || []).length, 2);
  assert.match(html, /href="https:\/\/www\.reddit\.com\/r\/test\/comments\/demo\/english_title\/commentabc\/"/);
  assert.match(html, /<a href="https:\/\/example\.com\/docs" rel="noopener noreferrer">документацію<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.com\/plain" rel="noopener noreferrer">https:\/\/example\.com\/plain<\/a>\./);
});

test("reader renders incremental progress without page refresh meta", () => {
  const translatedThread = translatedFromRaw(sampleRaw());
  translatedThread.comments = translatedThread.comments.slice(0, 1);
  const html = renderReaderPage({
    jobId: "job-incremental",
    status: "translating",
    warningCodes: [],
    extractorReport: {
      metrics: {
        totalCommentCount: 8
      }
    },
    translationProgress: {
      postTranslated: true,
      visibleBatchCount: 1,
      totalBatches: 4,
      translatedCommentCount: 1,
      totalCommentCount: 8
    },
    translatedThread
  });

  assert.match(html, /Translation: 1\/4 batches, 1\/8 comments/);
  assert.match(html, /\/api\/view\//);
  assert.match(html, /preserveScroll/);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
});

test("markdown renderer keeps unsafe schemes inert", () => {
  const html = renderMarkdown("[bad](javascript:alert(1)) https://safe.example/path");
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /href="https:\/\/safe\.example\/path"/);
});

test("unknown reader job shows expired placeholder", async () => {
  await withServer({
    name: "expired-placeholder",
    extractor: async () => ({ thread: sampleRaw() }),
    translator: async (raw) => ({ thread: translatedFromRaw(raw) })
  }, async ({ baseUrl }) => {
    const page = await getText(baseUrl, "/t/unknown-job-id");
    assert.equal(page.status, 200);
    assert.match(page.text, /Page unavailable/);
  });
});
