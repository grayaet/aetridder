const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getJson,
  requestJson,
  sampleRaw,
  translatedFromRaw,
  waitForStatus,
  withServer
} = require("./helpers");

test("diagnostics require Bearer auth and expose read-only status fields", async () => {
  await withServer({
    name: "diagnostics",
    extractor: async () => ({ thread: sampleRaw() }),
    translator: async (raw) => ({ thread: translatedFromRaw(raw) })
  }, async ({ baseUrl }) => {
    const unauthorized = await fetch(`${baseUrl}/api/diagnostics/health`);
    assert.equal(unauthorized.status, 401);

    const post = await requestJson(baseUrl, "POST", "/api/threads", {
      url: "https://www.reddit.com/r/test/comments/demo/english_title/"
    });
    await waitForStatus(baseUrl, post.body.jobId, "ready");

    const health = await getJson(baseUrl, "/api/diagnostics/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.storage.reachable, true);
    assert.equal(health.body.queue.model, "single_slot_latest_job");
    assert.ok(health.body.currentJob.stageTimestamps.ready);
    assert.ok(health.body.artifactManifest.entries);
    assert.equal(typeof health.body.redactedLogTail, "string");

    const serialized = JSON.stringify(health.body).toLowerCase();
    for (const forbidden of ["retry", "cancel", "purge", "restart", "reprocess", "upload", "deploy"]) {
      assert.equal(serialized.includes(forbidden), false, `diagnostics exposed ${forbidden}`);
    }
  });
});
