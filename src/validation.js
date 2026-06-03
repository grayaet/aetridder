const JOB_STATUSES = Object.freeze([
  "queued",
  "extracting",
  "extracted",
  "translating",
  "validating",
  "ready",
  "ready_with_warning",
  "invalid_url",
  "reddit_unavailable",
  "extraction_failed",
  "translation_failed",
  "validation_failed",
  "timeout",
  "replaced",
  "expired"
]);

const TERMINAL_STATUSES = new Set([
  "ready",
  "ready_with_warning",
  "invalid_url",
  "reddit_unavailable",
  "extraction_failed",
  "translation_failed",
  "validation_failed",
  "timeout",
  "replaced",
  "expired"
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeMetadata(metadata) {
  const source = metadata && typeof metadata === "object" ? metadata : {};
  return {
    subreddit: source.subreddit || null,
    isSubmitter: typeof source.isSubmitter === "boolean" ? source.isSubmitter : null,
    extractionSelector: source.extractionSelector || null
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateExtractedThread(thread, config) {
  if (!thread || typeof thread !== "object") {
    return { ok: false, errorCode: "extracted_payload_missing", errorMessageSafe: "Extracted thread data is missing." };
  }
  if (!thread.post || typeof thread.post !== "object" || !nonEmptyString(thread.post.title)) {
    return { ok: false, errorCode: "post_title_missing", errorMessageSafe: "No usable Reddit post title was extracted." };
  }

  const comments = asArray(thread.comments);
  const hasBody = nonEmptyString(thread.post.bodyMarkdown);
  if (!hasBody && comments.length === 0) {
    return {
      ok: false,
      errorCode: "post_content_missing",
      errorMessageSafe: "No usable Reddit post body or comments were extracted."
    };
  }

  const warningCodes = unique(asArray(thread.warningCodes));
  let keptComments = comments;
  if (comments.length > config.maxComments) {
    keptComments = comments.slice(0, config.maxComments);
    warningCodes.push("truncated_comments");
  }

  const normalizedComments = keptComments.map((comment, index) => ({
    id: String(comment.id || `comment-${index + 1}`),
    parentId: comment.parentId === undefined || comment.parentId === null ? null : String(comment.parentId),
    order: Number.isSafeInteger(comment.order) ? comment.order : index,
    depth: Number.isSafeInteger(comment.depth) && comment.depth >= 0 ? comment.depth : 0,
    author: String(comment.author || "[deleted]"),
    authorProfileUrl: comment.authorProfileUrl || null,
    score: comment.score === undefined ? null : comment.score,
    timestamp: comment.timestamp || null,
    bodyMarkdown: String(comment.bodyMarkdown || ""),
    metadata: normalizeMetadata(comment.metadata)
  }));

  return {
    ok: true,
    thread: {
      schemaVersion: "aetridder.extracted-thread.v1",
      sourceUrl: thread.sourceUrl,
      normalizedUrl: thread.normalizedUrl,
      finalUrlAfterRedirect: thread.finalUrlAfterRedirect || thread.normalizedUrl,
      extractedAt: thread.extractedAt || new Date().toISOString(),
      post: {
        id: String(thread.post.id || "post"),
        title: String(thread.post.title),
        bodyMarkdown: String(thread.post.bodyMarkdown || ""),
        author: String(thread.post.author || "[deleted]"),
        authorProfileUrl: thread.post.authorProfileUrl || null,
        score: thread.post.score === undefined ? null : thread.post.score,
        timestamp: thread.post.timestamp || null,
        metadata: normalizeMetadata(thread.post.metadata)
      },
      comments: normalizedComments,
      warningCodes: unique(warningCodes)
    }
  };
}

function metadataFieldsMatch(translatedItem, rawItem) {
  return translatedItem.id === rawItem.id &&
    translatedItem.parentId === rawItem.parentId &&
    translatedItem.order === rawItem.order &&
    translatedItem.depth === rawItem.depth &&
    translatedItem.author === rawItem.author &&
    translatedItem.authorProfileUrl === rawItem.authorProfileUrl &&
    translatedItem.score === rawItem.score &&
    translatedItem.timestamp === rawItem.timestamp;
}

function validateTranslatedThread(translated, rawThread) {
  if (!translated || typeof translated !== "object") {
    return { ok: false, errorCode: "translated_payload_missing", errorMessageSafe: "Translated JSON is missing." };
  }
  if (translated.language !== "ru") {
    return { ok: false, errorCode: "translated_language_not_ru", errorMessageSafe: "Translated JSON must declare Russian output." };
  }
  if (!translated.post || !nonEmptyString(translated.post.title)) {
    return { ok: false, errorCode: "translated_title_missing", errorMessageSafe: "Translated post title is missing." };
  }
  if (!metadataFieldsMatch(translated.post, rawThread.post)) {
    return { ok: false, errorCode: "post_metadata_mismatch", errorMessageSafe: "Translated post metadata does not match extraction metadata." };
  }

  const translatedComments = asArray(translated.comments);
  if (translatedComments.length !== rawThread.comments.length) {
    return { ok: false, errorCode: "comment_count_mismatch", errorMessageSafe: "Translated comments do not match extracted comments." };
  }

  for (let index = 0; index < rawThread.comments.length; index += 1) {
    const translatedComment = translatedComments[index];
    const rawComment = rawThread.comments[index];
    if (!translatedComment || !metadataFieldsMatch(translatedComment, rawComment)) {
      return {
        ok: false,
        errorCode: "comment_metadata_mismatch",
        errorMessageSafe: "Translated comment metadata does not match extraction metadata."
      };
    }
    if (!nonEmptyString(translatedComment.bodyMarkdown)) {
      return {
        ok: false,
        errorCode: "comment_translation_missing",
        errorMessageSafe: "A translated comment body is missing."
      };
    }
  }

  return {
    ok: true,
    thread: {
      schemaVersion: "aetridder.translated-thread.v1",
      language: "ru",
      translatedAt: translated.translatedAt || new Date().toISOString(),
      sourceUrl: rawThread.sourceUrl,
      normalizedUrl: rawThread.normalizedUrl,
      finalUrlAfterRedirect: rawThread.finalUrlAfterRedirect,
      post: {
        ...rawThread.post,
        title: String(translated.post.title),
        bodyMarkdown: String(translated.post.bodyMarkdown || "")
      },
      comments: translatedComments.map((comment, index) => ({
        ...rawThread.comments[index],
        bodyMarkdown: String(comment.bodyMarkdown || "")
      })),
      warningCodes: unique([...(rawThread.warningCodes || []), ...(translated.warningCodes || [])])
    }
  };
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

module.exports = {
  JOB_STATUSES,
  validateExtractedThread,
  validateTranslatedThread,
  isTerminalStatus
};

