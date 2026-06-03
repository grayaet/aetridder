const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getText,
  requestJson,
  sampleRaw,
  translatedFromRaw,
  waitForStatus,
  withServer
} = require("./helpers");

test("reader renders Russian-only translated content with nested comments and metadata", async () => {
  await withServer({
    name: "reader-russian",
    extractor: async () => ({ thread: sampleRaw({ warningCodes: ["partial_comments"] }) }),
    translator: async (raw) => ({ thread: translatedFromRaw(raw) })
  }, async ({ baseUrl }) => {
    const post = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/demo/english_title/"
    });
    await waitForStatus(baseUrl, post.body.jobId, "ready_with_warning");
    const page = await getText(baseUrl, `/t/${post.body.jobId}`);

    assert.equal(page.status, 200);
    assert.match(page.text, /Русский заголовок для проверки/);
    assert.match(page.text, /Первый русский комментарий|Русский комментарий 1/);
    assert.match(page.text, /Вложенный русский ответ|Русский комментарий 2/);
    assert.match(page.text, /commenter_one/);
    assert.match(page.text, /7 очков/);
    assert.match(page.text, /2026-06-02T17:10:00.000Z/);
    assert.match(page.text, /Комментарии извлечены частично/);
    assert.doesNotMatch(page.text, /English title for testing/);
    assert.doesNotMatch(page.text, /First English comment/);
  });
});

test("unknown reader job shows expired placeholder", async () => {
  await withServer({
    name: "expired-placeholder",
    extractor: async () => ({ thread: sampleRaw() }),
    translator: async (raw) => ({ thread: translatedFromRaw(raw) })
  }, async ({ baseUrl }) => {
    const page = await getText(baseUrl, "/t/unknown-job-id");
    assert.equal(page.status, 200);
    assert.match(page.text, /Страница недоступна/);
  });
});

