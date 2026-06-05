const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeRedditUrl, validateFinalRedditUrl } = require("../src/url");
const { fixtureJson } = require("./helpers");

const hosts = ["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com", "redd.it"];

test("invalid URL fixture is rejected", () => {
  const fixture = fixtureJson("cases/invalid-url.json");
  const result = normalizeRedditUrl(fixture.requestBody.url, hosts);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, fixture.expectedErrorCode);
});

test("non-Reddit URL fixture is rejected", () => {
  const fixture = fixtureJson("cases/non-reddit-url.json");
  const result = normalizeRedditUrl(fixture.requestBody.url, hosts);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, fixture.expectedErrorCode);
});

test("Reddit-looking suffix attack is rejected", () => {
  const result = normalizeRedditUrl("https://reddit.com.example/path", hosts);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "non_reddit_url");
});

test("Reddit and redd.it URLs are normalized to https", () => {
  const reddit = normalizeRedditUrl("http://old.reddit.com/r/test/comments/demo#frag", hosts);
  const short = normalizeRedditUrl("https://redd.it/demo", hosts);
  assert.equal(reddit.ok, true);
  assert.equal(reddit.normalizedUrl, "https://old.reddit.com/r/test/comments/demo");
  assert.equal(short.ok, true);
});

test("Reddit mobile share /s/ URLs are accepted for browser redirect resolution", () => {
  const shared = normalizeRedditUrl("https://www.reddit.com/r/codex/s/Zm2i7sDp9W", hosts);
  assert.equal(shared.ok, true);
  assert.equal(shared.normalizedUrl, "https://www.reddit.com/r/codex/s/Zm2i7sDp9W");
});

test("final redirect target outside Reddit is rejected", () => {
  const fixture = fixtureJson("cases/redirect-target-outside-reddit.json");
  const result = validateFinalRedditUrl(fixture.finalUrlAfterRedirect, hosts);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, fixture.expectedErrorCode);
});
