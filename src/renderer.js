function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.href;
  } catch (_error) {
    return null;
  }
}

function restorePlaceholders(html, placeholders) {
  return html.replace(/\u0000(\d+)\u0000/g, (_match, index) => placeholders[Number(index)] || "");
}

function renderMarkdown(markdown) {
  let html = escapeHtml(markdown);
  const placeholders = [];
  const hold = (value) => {
    const index = placeholders.push(value) - 1;
    return `\u0000${index}\u0000`;
  };
  html = html.replace(/```([\s\S]*?)```/g, (_match, code) => hold(`<pre><code>${code}</code></pre>`));
  html = html.replace(/`([^`]+)`/g, (_match, code) => hold(`<code>${code}</code>`));
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) => {
    const href = safeHref(url);
    return href ? hold(`<a href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>`) : label;
  });
  html = html.replace(/(^|[\s(>])((?:https?:\/\/)[^\s<)]+)/g, (match, prefix, url) => {
    const trailing = (url.match(/[.,!?;:]+$/) || [""])[0];
    const cleanUrl = trailing ? url.slice(0, -trailing.length) : url;
    const href = safeHref(cleanUrl);
    if (!href) {
      return match;
    }
    return `${prefix}${hold(`<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(cleanUrl)}</a>`)}${trailing}`;
  });
  html = restorePlaceholders(html, placeholders);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/\n{2,}/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  return `<p>${html}</p>`;
}

function warningText(codes = []) {
  const labels = {
    partial_comments: "Comments were partially extracted.",
    truncated_comments: "Long thread was truncated by the configured limit.",
    partial_translation: "Comment translation finished partially."
  };
  return codes.map((code) => labels[code] || `Warning: ${escapeHtml(code)}`).join(" ");
}

function normalizeAuthor(value) {
  return String(value || "").replace(/^u\//i, "").trim().toLowerCase();
}

function formatTimestamp(value) {
  const raw = String(value || "").trim();
  const direct = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}):(\d{2})/);
  if (direct) {
    return `${direct[1]} ${direct[2]}:${direct[3]}`;
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const pad = (part) => String(part).padStart(2, "0");
    return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())} ${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())}`;
  }
  return raw;
}

function metaLine(item, options = {}) {
  const author = escapeHtml(item.author || "[deleted]");
  const profile = item.authorProfileUrl
    ? `<a href="${escapeHtml(item.authorProfileUrl)}" rel="noopener noreferrer">${author}</a>`
    : author;
  const opBadge = options.isOp ? '<span class="op-badge">OP</span>' : "";
  const score = item.score === null || item.score === undefined ? "score unknown" : `${escapeHtml(item.score)} points`;
  const time = item.timestamp ? escapeHtml(formatTimestamp(item.timestamp)) : "time unknown";
  const permalink = options.permalink
    ? `<a class="meta-action" href="${escapeHtml(options.permalink)}" rel="noopener noreferrer" aria-label="Open comment on Reddit">reddit</a>`
    : "";
  return `<div class="meta">${profile}${opBadge}<span>${score}</span><span>${time}</span>${permalink}</div>`;
}

function buildCommentTree(comments, postId) {
  const byParent = new Map();
  for (const comment of comments) {
    const parent = comment.parentId || postId || null;
    if (!byParent.has(parent)) {
      byParent.set(parent, []);
    }
    byParent.get(parent).push(comment);
  }
  for (const group of byParent.values()) {
    group.sort((a, b) => a.order - b.order);
  }
  return byParent;
}

function postUrlForThread(thread) {
  return safeHref(thread.finalUrlAfterRedirect) || safeHref(thread.normalizedUrl) || safeHref(thread.sourceUrl);
}

function commentPermalink(thread, comment) {
  const base = postUrlForThread(thread);
  if (!base || !comment || !comment.id) {
    return null;
  }
  try {
    const url = new URL(base);
    url.search = "";
    url.hash = "";
    const shortId = String(comment.id).replace(/^t1_/i, "");
    const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    if (/\/comments\/[^/]+\/[^/]+\//i.test(path)) {
      url.pathname = `${path}${shortId}/`;
    } else {
      url.hash = comment.id;
    }
    return url.href;
  } catch (_error) {
    return null;
  }
}

function commentCountStatus(job, translated) {
  const extracted = translated && Array.isArray(translated.comments) ? translated.comments.length : 0;
  const metrics = job && job.extractorReport && job.extractorReport.metrics ? job.extractorReport.metrics : {};
  const total = Number.isSafeInteger(metrics.totalCommentCount) && metrics.totalCommentCount > 0
    ? metrics.totalCommentCount
    : null;
  return total
    ? `Comments: extracted ${extracted} of ${total}`
    : `Comments: extracted ${extracted}; total unknown`;
}

function translationProgressStatus(progress) {
  if (!progress) {
    return "";
  }
  if (!progress.postTranslated) {
    return "Translation: post";
  }
  if (!progress.totalBatches) {
    return "Translation: post ready, no comments";
  }
  return `Translation: ${progress.visibleBatchCount || 0}/${progress.totalBatches} batches, ${progress.translatedCommentCount || 0}/${progress.totalCommentCount || 0} comments`;
}

function postLinkBar(thread, placement) {
  const href = postUrlForThread(thread);
  if (!href) {
    return "";
  }
  return `<nav class="post-links post-links-${placement}" aria-label="Reddit links"><a class="link-chip" href="${escapeHtml(href)}" rel="noopener noreferrer">Original</a></nav>`;
}

function renderComments(parentId, byParent, postAuthor, thread, depth = 0) {
  const comments = byParent.get(parentId) || [];
  return comments
    .map((comment) => {
      const childHtml = renderComments(comment.id, byParent, postAuthor, thread, depth + 1);
      const isOp = normalizeAuthor(comment.author) === normalizeAuthor(postAuthor);
      return `
        <article class="comment" style="--depth:${Math.min(depth, 8)}">
          ${metaLine(comment, { isOp, permalink: commentPermalink(thread, comment) })}
          <div class="body">${renderMarkdown(comment.bodyMarkdown)}</div>
          ${childHtml}
        </article>
      `;
    })
    .join("");
}

function pageShell(title, body, options = {}) {
  const script = options.script || "";
  const lang = options.lang || "uk";
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f7f4; color: #171717; }
    main { max-width: 760px; margin: 0 auto; padding: 18px 15px 42px; text-align: left; }
    h1 { font-size: 25px; line-height: 1.18; margin: 8px 0 10px; letter-spacing: 0; }
    h2 { font-size: 18px; margin: 28px 0 12px; letter-spacing: 0; }
    p { line-height: 1.52; margin: 0 0 12px; }
    a { color: #075e78; overflow-wrap: anywhere; }
    .status { background: #fff9df; border: 1px solid #e4cf75; border-radius: 8px; padding: 9px 11px; font-size: 14px; line-height: 1.35; margin: 10px 0 16px; }
    .summary { color: #4e585b; font-size: 13px; line-height: 1.35; margin: 4px 0 10px; }
    .progress { color: #3f5056; font-size: 13px; line-height: 1.35; margin: 4px 0 12px; }
    .post-links { display: flex; gap: 8px; align-items: center; margin: 6px 0 10px; }
    .post-links-bottom { margin-top: 22px; padding-top: 14px; border-top: 1px solid #d9d8d1; }
    .link-chip, .meta-action { display: inline-flex; align-items: center; min-height: 24px; border: 1px solid #b8c8cd; border-radius: 999px; padding: 2px 8px; font-size: 12px; line-height: 1.2; text-decoration: none; background: #eef5f6; color: #075e78; }
    .meta-action { min-height: 20px; padding: 1px 6px; }
    .post { padding-bottom: 18px; border-bottom: 1px solid #d9d8d1; text-align: left; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; color: #5b5b55; font-size: 13px; line-height: 1.35; margin: 6px 0 10px; text-align: left; }
    .op-badge { color: #006d9c; font-weight: 700; }
    .body { font-size: 16px; overflow-wrap: anywhere; text-align: left; }
    .comment { margin: 12px 0 0 calc(var(--depth) * 13px); padding: 10px 0 10px 12px; border-left: 3px solid #c9d7dc; text-align: left; }
    .comment .body { font-size: 15px; }
    code { background: #ecebe4; border-radius: 4px; padding: 1px 4px; }
    pre { overflow-x: auto; background: #ecebe4; border-radius: 8px; padding: 10px; }
    blockquote { margin: 8px 0; padding-left: 10px; border-left: 3px solid #aab4b8; color: #4b5558; }
    .placeholder { margin-top: 24vh; text-align: center; }
    .placeholder h1 { font-size: 22px; }
    @media (max-width: 430px) {
      main { padding: 14px 12px 34px; }
      h1 { font-size: 23px; }
      .comment { margin-left: calc(var(--depth) * 10px); }
    }
  </style>
</head>
<body>
${body}
${script}
</body>
</html>`;
}

function renderPlaceholder(kind, jobId = null) {
  const copy = {
    loading: ["Processing", "The translation will appear here automatically. No page refresh is needed."],
    replaced: ["Job replaced", "A new link was opened. This page no longer contains the current translation."],
    expired: ["Page unavailable", "This job is no longer the latest retained job."],
    error: ["Could not prepare translation", "Details are available in protected diagnostics."]
  }[kind];
  return pageShell(copy[0], `<main id="reader-root" class="placeholder"><h1>${copy[0]}</h1><p>${copy[1]}</p></main>`, {
    script: kind === "loading" && jobId ? readerClientScript(jobId) : ""
  });
}

function renderReaderMain(job) {
  const translated = job.translatedThread;
  if (!translated) {
    return `<main id="reader-root" class="placeholder"><h1>Processing</h1><p>The translation will appear here automatically. No page refresh is needed.</p></main>`;
  }

  const warnings = warningText(job.warningCodes);
  const progress = translationProgressStatus(job.translationProgress);
  const commentTree = buildCommentTree(translated.comments, translated.post.id);
  return `<main id="reader-root">
    ${postLinkBar(translated, "top")}
    <div class="summary">${escapeHtml(commentCountStatus(job, translated))}</div>
    ${progress ? `<div class="progress">${escapeHtml(progress)}</div>` : ""}
    ${warnings ? `<div class="status">${warnings}</div>` : ""}
    <article class="post" data-reader-anchor="post">
      <h1>${escapeHtml(translated.post.title)}</h1>
      ${metaLine(translated.post)}
      <div class="body">${renderMarkdown(translated.post.bodyMarkdown)}</div>
    </article>
    <h2>Comments</h2>
    ${renderComments(translated.post.id, commentTree, translated.post.author, translated)}
    ${postLinkBar(translated, "bottom")}
  </main>`;
}

function readerClientScript(jobId) {
  return `<script>
(() => {
  const jobId = ${JSON.stringify(jobId || "")};
  if (!jobId) return;
  const root = document.getElementById("reader-root");
  if (!root) return;
  const terminal = new Set(["ready", "ready_with_warning", "invalid_url", "extraction_unavailable", "reddit_unavailable", "extraction_failed", "translation_failed", "validation_failed", "timeout", "replaced", "expired"]);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const safeHref = (value) => {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch (_error) {
      return null;
    }
  };
  const markdown = (value) => {
    let html = esc(value);
    const placeholders = [];
    const hold = (part) => {
      const index = placeholders.push(part) - 1;
      return "\\u0000" + index + "\\u0000";
    };
    html = html.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, (_match, label, url) => {
      const href = safeHref(url);
      return href ? hold('<a href="' + esc(href) + '" rel="noopener noreferrer">' + label + '</a>') : label;
    });
    html = html.replace(/(^|[\\s(>])((?:https?:\\/\\/)[^\\s<)]+)/g, (match, prefix, url) => {
      const trailing = (url.match(/[.,!?;:]+$/) || [""])[0];
      const cleanUrl = trailing ? url.slice(0, -trailing.length) : url;
      const href = safeHref(cleanUrl);
      return href ? prefix + hold('<a href="' + esc(href) + '" rel="noopener noreferrer">' + esc(cleanUrl) + '</a>') + trailing : match;
    });
    html = html.replace(/\\u0000(\\d+)\\u0000/g, (_match, index) => placeholders[Number(index)] || "");
    html = html.replace(/^&gt;\\s?(.+)$/gm, "<blockquote>$1</blockquote>");
    html = html.replace(/\\n{2,}/g, "</p><p>").replace(/\\n/g, "<br>");
    return "<p>" + html + "</p>";
  };
  const warningText = (codes) => {
    const labels = {
      partial_comments: "Comments were partially extracted.",
      truncated_comments: "Long thread was truncated by the configured limit.",
      partial_translation: "Comment translation finished partially."
    };
    return (codes || []).map((code) => labels[code] || ("Warning: " + esc(code))).join(" ");
  };
  const normalizeAuthor = (value) => String(value || "").replace(/^u\\//i, "").trim().toLowerCase();
  const formatTimestamp = (value) => {
    const raw = String(value || "").trim();
    const direct = raw.match(/^(\\d{4}-\\d{2}-\\d{2})[T\\s](\\d{2}):(\\d{2})/);
    if (direct) return direct[1] + " " + direct[2] + ":" + direct[3];
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return raw;
    const pad = (part) => String(part).padStart(2, "0");
    return parsed.getUTCFullYear() + "-" + pad(parsed.getUTCMonth() + 1) + "-" + pad(parsed.getUTCDate()) + " " + pad(parsed.getUTCHours()) + ":" + pad(parsed.getUTCMinutes());
  };
  const postUrl = (thread) => safeHref(thread?.finalUrlAfterRedirect) || safeHref(thread?.normalizedUrl) || safeHref(thread?.sourceUrl);
  const commentPermalink = (thread, comment) => {
    const base = postUrl(thread);
    if (!base || !comment?.id) return null;
    try {
      const url = new URL(base);
      url.search = "";
      url.hash = "";
      const shortId = String(comment.id).replace(/^t1_/i, "");
      const path = url.pathname.endsWith("/") ? url.pathname : url.pathname + "/";
      if (/\\/comments\\/[^/]+\\/[^/]+\\//i.test(path)) url.pathname = path + shortId + "/";
      else url.hash = comment.id;
      return url.href;
    } catch (_error) {
      return null;
    }
  };
  const metaLine = (item, options = {}) => {
    const author = esc(item?.author || "[deleted]");
    const profile = item?.authorProfileUrl ? '<a href="' + esc(item.authorProfileUrl) + '" rel="noopener noreferrer">' + author + '</a>' : author;
    const op = options.isOp ? '<span class="op-badge">OP</span>' : "";
    const score = item?.score === null || item?.score === undefined ? "score unknown" : esc(item.score) + " points";
    const time = item?.timestamp ? esc(formatTimestamp(item.timestamp)) : "time unknown";
    const permalink = options.permalink ? '<a class="meta-action" href="' + esc(options.permalink) + '" rel="noopener noreferrer" aria-label="Open comment on Reddit">reddit</a>' : "";
    return '<div class="meta">' + profile + op + '<span>' + score + '</span><span>' + time + '</span>' + permalink + '</div>';
  };
  const buildTree = (comments, postId) => {
    const byParent = new Map();
    for (const comment of comments || []) {
      const parent = comment.parentId || postId || null;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(comment);
    }
    for (const group of byParent.values()) group.sort((a, b) => a.order - b.order);
    return byParent;
  };
  const renderComments = (parentId, byParent, postAuthor, thread, depth = 0) => {
    return (byParent.get(parentId) || []).map((comment) => {
      const children = renderComments(comment.id, byParent, postAuthor, thread, depth + 1);
      const isOp = normalizeAuthor(comment.author) === normalizeAuthor(postAuthor);
      return '<article class="comment" data-reader-anchor="' + esc(comment.id) + '" style="--depth:' + Math.min(depth, 8) + '">' +
        metaLine(comment, { isOp, permalink: commentPermalink(thread, comment) }) +
        '<div class="body">' + markdown(comment.bodyMarkdown) + '</div>' + children + '</article>';
    }).join("");
  };
  const progressText = (progress) => {
    if (!progress) return "";
    if (!progress.postTranslated) return "Translation: post";
    if (!progress.totalBatches) return "Translation: post ready, no comments";
    return "Translation: " + (progress.visibleBatchCount || 0) + "/" + progress.totalBatches + " batches, " + (progress.translatedCommentCount || 0) + "/" + (progress.totalCommentCount || 0) + " comments";
  };
  const countText = (payload) => {
    const translated = payload?.thread?.comments?.length || 0;
    const total = payload?.commentSummary?.totalCommentCount || 0;
    return total ? "Comments: extracted " + translated + " of " + total : "Comments: extracted " + translated + "; total unknown";
  };
  const postLinks = (thread, placement) => {
    const href = postUrl(thread);
    return href ? '<nav class="post-links post-links-' + placement + '" aria-label="Reddit links"><a class="link-chip" href="' + esc(href) + '" rel="noopener noreferrer">Original</a></nav>' : "";
  };
  const renderPayload = (payload) => {
    if (!payload?.thread) {
      if (payload?.errorMessageSafe) return '<h1>Could not prepare translation</h1><p>' + esc(payload.errorMessageSafe) + '</p>';
      return '<h1>Processing</h1><p>The translation will appear here automatically. No page refresh is needed.</p>' + (payload?.translationProgress ? '<div class="progress">' + esc(progressText(payload.translationProgress)) + '</div>' : "");
    }
    const thread = payload.thread;
    const tree = buildTree(thread.comments || [], thread.post.id);
    const warnings = warningText(payload.warningCodes || []);
    const progress = progressText(payload.translationProgress);
    return postLinks(thread, "top") +
      '<div class="summary">' + esc(countText(payload)) + '</div>' +
      (progress ? '<div class="progress">' + esc(progress) + '</div>' : "") +
      (warnings ? '<div class="status">' + warnings + '</div>' : "") +
      '<article class="post" data-reader-anchor="post"><h1>' + esc(thread.post.title) + '</h1>' +
      metaLine(thread.post) + '<div class="body">' + markdown(thread.post.bodyMarkdown) + '</div></article>' +
      '<h2>Comments</h2>' + renderComments(thread.post.id, tree, thread.post.author, thread) + postLinks(thread, "bottom");
  };
  const firstVisibleAnchor = () => {
    for (const element of root.querySelectorAll("[data-reader-anchor]")) {
      if (element.getBoundingClientRect().bottom >= 0) return element;
    }
    return null;
  };
  const preserveScroll = (fn) => {
    const anchor = firstVisibleAnchor();
    const key = anchor ? anchor.getAttribute("data-reader-anchor") : null;
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    fn();
    if (!key) return;
    const afterAnchor = Array.from(root.querySelectorAll("[data-reader-anchor]")).find((element) => element.getAttribute("data-reader-anchor") === key);
    if (!afterAnchor) return;
    window.scrollBy(0, afterAnchor.getBoundingClientRect().top - before);
  };
  async function poll() {
    try {
      const response = await fetch("/api/view/" + encodeURIComponent(jobId), { headers: { accept: "application/json" } });
      const payload = await response.json();
      if (payload?.thread?.post?.title) document.title = payload.thread.post.title;
      preserveScroll(() => { root.innerHTML = renderPayload(payload); });
      if (terminal.has(payload.status)) return;
    } catch (_error) {
      root.querySelector(".progress")?.replaceChildren(document.createTextNode("Refresh connection is temporarily unavailable."));
    }
    setTimeout(poll, 3000);
  }
  setTimeout(poll, 1000);
})();
</script>`;
}

function renderReaderPage(job) {
  if (!job) {
    return renderPlaceholder("expired");
  }
  if (job.status === "replaced") {
    return renderPlaceholder("replaced");
  }
  if (job.status === "expired") {
    return renderPlaceholder("expired");
  }
  if (["queued", "extracting", "extracted", "translating", "validating"].includes(job.status)) {
    if (!job.translatedThread) {
      return renderPlaceholder("loading", job.jobId);
    }
  }
  if (!["translating", "validating", "ready", "ready_with_warning"].includes(job.status)) {
    return renderPlaceholder("error");
  }

  const translated = job.translatedThread;
  return pageShell(translated ? translated.post.title : "Processing", renderReaderMain(job), {
    lang: job.targetLanguageCode || translated?.language || "uk",
    script: job.jobId && !["ready", "ready_with_warning"].includes(job.status) ? readerClientScript(job.jobId) : ""
  });
}

module.exports = {
  escapeHtml,
  renderReaderPage,
  renderMarkdown,
  formatTimestamp,
  commentPermalink,
  commentCountStatus,
  translationProgressStatus,
  warningText
};
