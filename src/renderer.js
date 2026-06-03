function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMarkdown(markdown) {
  let html = escapeHtml(markdown);
  html = html.replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
  html = html.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/\n{2,}/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  return `<p>${html}</p>`;
}

function warningText(codes = []) {
  const labels = {
    partial_comments: "Комментарии извлечены частично.",
    truncated_comments: "Длинная ветка обрезана по настроенному лимиту."
  };
  return codes.map((code) => labels[code] || `Предупреждение: ${escapeHtml(code)}`).join(" ");
}

function metaLine(item) {
  const author = escapeHtml(item.author || "[deleted]");
  const profile = item.authorProfileUrl
    ? `<a href="${escapeHtml(item.authorProfileUrl)}" rel="noopener noreferrer">${author}</a>`
    : author;
  const score = item.score === null || item.score === undefined ? "оценка неизвестна" : `${escapeHtml(item.score)} очков`;
  const time = item.timestamp ? escapeHtml(item.timestamp) : "время неизвестно";
  return `<div class="meta">${profile}<span>${score}</span><span>${time}</span></div>`;
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

function renderComments(parentId, byParent, depth = 0) {
  const comments = byParent.get(parentId) || [];
  return comments
    .map((comment) => {
      const childHtml = renderComments(comment.id, byParent, depth + 1);
      return `
        <article class="comment" style="--depth:${Math.min(depth, 8)}">
          ${metaLine(comment)}
          <div class="body">${renderMarkdown(comment.bodyMarkdown)}</div>
          ${childHtml}
        </article>
      `;
    })
    .join("");
}

function pageShell(title, body, options = {}) {
  const refresh = options.refresh ? '<meta http-equiv="refresh" content="4">' : "";
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${refresh}
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f7f4; color: #171717; }
    main { max-width: 760px; margin: 0 auto; padding: 18px 15px 42px; }
    h1 { font-size: 25px; line-height: 1.18; margin: 8px 0 10px; letter-spacing: 0; }
    h2 { font-size: 18px; margin: 28px 0 12px; letter-spacing: 0; }
    p { line-height: 1.52; margin: 0 0 12px; }
    a { color: #075e78; overflow-wrap: anywhere; }
    .status { background: #fff9df; border: 1px solid #e4cf75; border-radius: 8px; padding: 9px 11px; font-size: 14px; line-height: 1.35; margin: 10px 0 16px; }
    .post { padding-bottom: 18px; border-bottom: 1px solid #d9d8d1; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; color: #5b5b55; font-size: 13px; line-height: 1.35; margin: 6px 0 10px; }
    .body { font-size: 16px; overflow-wrap: anywhere; }
    .comment { margin: 12px 0 0 calc(var(--depth) * 13px); padding: 10px 0 10px 12px; border-left: 3px solid #c9d7dc; }
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
</body>
</html>`;
}

function renderPlaceholder(kind) {
  const copy = {
    loading: ["Идет обработка", "Страница обновится автоматически, пока поток переводится."],
    replaced: ["Задача заменена", "Открыта новая ссылка. Эта страница больше не содержит текущий перевод."],
    expired: ["Страница недоступна", "Эта задача больше не является последней сохраненной задачей."],
    error: ["Не удалось подготовить перевод", "Подробности доступны в защищенной диагностике."]
  }[kind];
  return pageShell(copy[0], `<main class="placeholder"><h1>${copy[0]}</h1><p>${copy[1]}</p></main>`, {
    refresh: kind === "loading"
  });
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
    return renderPlaceholder("loading");
  }
  if (!["ready", "ready_with_warning"].includes(job.status)) {
    return renderPlaceholder("error");
  }

  const translated = job.translatedThread;
  const warnings = warningText(job.warningCodes);
  const commentTree = buildCommentTree(translated.comments, translated.post.id);
  const body = `<main>
    ${warnings ? `<div class="status">${warnings}</div>` : ""}
    <article class="post">
      <h1>${escapeHtml(translated.post.title)}</h1>
      ${metaLine(translated.post)}
      <div class="body">${renderMarkdown(translated.post.bodyMarkdown)}</div>
    </article>
    <h2>Комментарии</h2>
    ${renderComments(translated.post.id, commentTree)}
  </main>`;
  return pageShell(translated.post.title, body);
}

module.exports = {
  escapeHtml,
  renderReaderPage,
  renderMarkdown,
  warningText
};

