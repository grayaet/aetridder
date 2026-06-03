const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getJson,
  getText,
  requestJson,
  sampleRaw,
  translatedFromRaw,
  waitFor,
  waitForStatus,
  withServer
} = require("./helpers");

test("new job replaces active job and stale worker output cannot publish", async () => {
  let firstRelease;
  let firstStarted = false;
  let callCount = 0;
  const firstGate = new Promise((resolve) => {
    firstRelease = resolve;
  });

  await withServer({
    name: "replace-stale",
    extractor: async () => {
      callCount += 1;
      if (callCount === 1) {
        firstStarted = true;
        await firstGate;
        return { thread: sampleRaw({ post: { ...sampleRaw().post, id: "t3_first", title: "First English title" } }) };
      }
      return { thread: sampleRaw({ post: { ...sampleRaw().post, id: "t3_second", title: "Second English title" } }) };
    },
    translator: async (raw) => ({
      thread: translatedFromRaw(raw, { title: `Перевод ${raw.post.id}` })
    })
  }, async ({ baseUrl }) => {
    const first = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/first/first/"
    });
    await waitFor(() => firstStarted, "first extractor did not start");

    const second = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/second/second/"
    });
    assert.notEqual(first.body.jobId, second.body.jobId);

    const firstStatus = await getJson(baseUrl, `/api/threads/${first.body.jobId}/status`);
    assert.equal(firstStatus.body.status, "replaced");
    assert.equal(firstStatus.body.isCurrentLatestJob, false);

    firstRelease();
    const secondReady = await waitForStatus(baseUrl, second.body.jobId, "ready");
    assert.equal(secondReady.status, "ready");

    const firstAfter = await getJson(baseUrl, `/api/threads/${first.body.jobId}/status`);
    assert.equal(firstAfter.body.status, "replaced");

    const oldPage = await getText(baseUrl, `/t/${first.body.jobId}`);
    assert.equal(oldPage.status, 200);
    assert.match(oldPage.text, /Задача заменена/);

    const newPage = await getText(baseUrl, `/t/${second.body.jobId}`);
    assert.match(newPage.text, /Перевод t3_second/);
    assert.doesNotMatch(newPage.text, /Перевод t3_first/);
  });
});

