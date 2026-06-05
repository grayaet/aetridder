const JOB_STATUSES = Object.freeze([
  "queued",
  "extracting",
  "extracted",
  "translating",
  "validating",
  "ready",
  "ready_with_warning",
  "invalid_url",
  "extraction_unavailable",
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
  "extraction_unavailable",
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
    extractionSelector: source.extractionSelector || null,
    originalDomId: source.originalDomId || null,
    parentInferenceSource: source.parentInferenceSource || null,
    parentInferenceWarning: source.parentInferenceWarning || null,
    duplicateMerge: source.duplicateMerge || null
  };
}

function normalizeParserMetrics(metrics) {
  const source = metrics && typeof metrics === "object" ? metrics : {};
  const intField = (name) => Number.isSafeInteger(source[name]) && source[name] >= 0 ? source[name] : 0;
  return {
    visibleCommentCount: intField("visibleCommentCount"),
    totalCommentCount: intField("totalCommentCount"),
    discoveredMoreRequestCount: intField("discoveredMoreRequestCount"),
    uniqueMoreRequestCount: intField("uniqueMoreRequestCount"),
    fetchedMoreRequestCount: intField("fetchedMoreRequestCount"),
    duplicateMoreRequestCount: intField("duplicateMoreRequestCount"),
    failedMoreRequestCount: intField("failedMoreRequestCount"),
    unresolvedMoreRequestCount: intField("unresolvedMoreRequestCount"),
    limitReached: Boolean(source.limitReached),
    extractedUniqueCommentCount: intField("extractedUniqueCommentCount"),
    maxDepthExtracted: intField("maxDepthExtracted"),
    partialArtifactsCount: intField("partialArtifactsCount")
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function expectedTargetLanguageCode(options = {}) {
  return options.targetLanguageCode || "uk";
}

function targetLanguageErrorMessage(expected) {
  return `Translated JSON must declare configured target language ${expected}.`;
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
      warningCodes: unique(warningCodes),
      parserMetrics: normalizeParserMetrics(thread.parserMetrics)
    }
  };
}

function metadataFieldsMatch(translatedItem, rawItem) {
  if (!translatedItem || !rawItem) {
    return false;
  }
  return translatedItem.id === rawItem.id &&
    translatedItem.parentId === rawItem.parentId &&
    translatedItem.order === rawItem.order &&
    translatedItem.depth === rawItem.depth &&
    translatedItem.author === rawItem.author &&
    translatedItem.authorProfileUrl === rawItem.authorProfileUrl &&
    translatedItem.score === rawItem.score &&
    translatedItem.timestamp === rawItem.timestamp;
}

function compactStableFieldsMatch(translatedItem, rawItem) {
  if (!translatedItem || !rawItem || translatedItem.id !== rawItem.id) {
    return false;
  }
  if (translatedItem.parentId !== undefined && translatedItem.parentId !== rawItem.parentId) {
    return false;
  }
  if (translatedItem.order !== undefined && translatedItem.order !== rawItem.order) {
    return false;
  }
  if (translatedItem.depth !== undefined && translatedItem.depth !== rawItem.depth) {
    return false;
  }
  return true;
}

function rehydrateTranslatedPost(translated, rawThread) {
  if (!translated || !translated.post || metadataFieldsMatch(translated.post, rawThread.post)) {
    return translated;
  }
  if (!compactStableFieldsMatch(translated.post, rawThread.post)) {
    return translated;
  }
  return {
    ...translated,
    post: {
      ...rawThread.post,
      title: String(translated.post.title || ""),
      bodyMarkdown: String(translated.post.bodyMarkdown || "")
    }
  };
}

function rehydrateTranslatedComments(translatedComments, rawComments) {
  return translatedComments.map((comment, index) => {
    const rawComment = rawComments[index];
    if (!comment || metadataFieldsMatch(comment, rawComment)) {
      return comment;
    }
    if (!compactStableFieldsMatch(comment, rawComment)) {
      return comment;
    }
    return {
      ...rawComment,
      bodyMarkdown: String(comment.bodyMarkdown || "")
    };
  });
}

function validateTranslatedPost(translated, rawThread, options = {}) {
  translated = rehydrateTranslatedPost(translated, rawThread);
  const expectedLanguage = expectedTargetLanguageCode(options);
  if (!translated || typeof translated !== "object") {
    return { ok: false, errorCode: "translated_post_missing", errorMessageSafe: "Translated post JSON is missing." };
  }
  if (translated.language !== expectedLanguage) {
    return { ok: false, errorCode: "translated_language_mismatch", errorMessageSafe: targetLanguageErrorMessage(expectedLanguage) };
  }
  if (!translated.post || !nonEmptyString(translated.post.title)) {
    return { ok: false, errorCode: "translated_title_missing", errorMessageSafe: "Translated post title is missing." };
  }
  if (!metadataFieldsMatch(translated.post, rawThread.post)) {
    return { ok: false, errorCode: "post_metadata_mismatch", errorMessageSafe: "Translated post metadata does not match extraction metadata." };
  }

  return {
    ok: true,
    post: {
      ...rawThread.post,
      title: String(translated.post.title),
      bodyMarkdown: String(translated.post.bodyMarkdown || "")
    },
    warningCodes: unique([...(rawThread.warningCodes || []), ...(translated.warningCodes || [])])
  };
}

function validateTranslatedCommentBatch(translated, rawComments, batchIndex, totalBatches, options = {}) {
  const expectedLanguage = expectedTargetLanguageCode(options);
  if (!translated || typeof translated !== "object") {
    return { ok: false, errorCode: "translated_batch_missing", errorMessageSafe: "Translated comment batch JSON is missing." };
  }
  if (translated.language !== expectedLanguage) {
    return { ok: false, errorCode: "translated_language_mismatch", errorMessageSafe: targetLanguageErrorMessage(expectedLanguage) };
  }
  if (translated.batchIndex !== batchIndex || translated.totalBatches !== totalBatches) {
    return { ok: false, errorCode: "batch_metadata_mismatch", errorMessageSafe: "Translated comment batch metadata does not match the requested batch." };
  }

  const translatedComments = rehydrateTranslatedComments(asArray(translated.comments), rawComments);
  if (translatedComments.length !== rawComments.length) {
    return { ok: false, errorCode: "batch_comment_count_mismatch", errorMessageSafe: "Translated comment batch count does not match the requested batch." };
  }

  for (let index = 0; index < rawComments.length; index += 1) {
    const translatedComment = translatedComments[index];
    const rawComment = rawComments[index];
    if (!translatedComment || !metadataFieldsMatch(translatedComment, rawComment)) {
      return {
        ok: false,
        errorCode: "batch_comment_metadata_mismatch",
        errorMessageSafe: "Translated comment batch metadata does not match extraction metadata."
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
    comments: translatedComments.map((comment, index) => ({
      ...rawComments[index],
      bodyMarkdown: String(comment.bodyMarkdown || "")
    })),
    warningCodes: unique(asArray(translated.warningCodes))
  };
}

function validateTranslatedThread(translated, rawThread, options = {}) {
  translated = rehydrateTranslatedPost(translated, rawThread);
  const expectedLanguage = expectedTargetLanguageCode(options);
  if (!translated || typeof translated !== "object") {
    return { ok: false, errorCode: "translated_payload_missing", errorMessageSafe: "Translated JSON is missing." };
  }
  if (translated.language !== expectedLanguage) {
    return { ok: false, errorCode: "translated_language_mismatch", errorMessageSafe: targetLanguageErrorMessage(expectedLanguage) };
  }
  if (!translated.post || !nonEmptyString(translated.post.title)) {
    return { ok: false, errorCode: "translated_title_missing", errorMessageSafe: "Translated post title is missing." };
  }
  if (!metadataFieldsMatch(translated.post, rawThread.post)) {
    return { ok: false, errorCode: "post_metadata_mismatch", errorMessageSafe: "Translated post metadata does not match extraction metadata." };
  }

  const translatedComments = rehydrateTranslatedComments(asArray(translated.comments), rawThread.comments);
  if (!options.allowPartialComments && translatedComments.length !== rawThread.comments.length) {
    return { ok: false, errorCode: "comment_count_mismatch", errorMessageSafe: "Translated comments do not match extracted comments." };
  }
  if (options.allowPartialComments && translatedComments.length > rawThread.comments.length) {
    return { ok: false, errorCode: "comment_count_mismatch", errorMessageSafe: "Translated comments do not match extracted comments." };
  }

  for (let index = 0; index < translatedComments.length; index += 1) {
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
      language: expectedLanguage,
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
      warningCodes: unique([
        ...(rawThread.warningCodes || []),
        ...(translated.warningCodes || []),
        ...(options.allowPartialComments && translatedComments.length < rawThread.comments.length ? ["partial_translation"] : [])
      ])
    }
  };
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

module.exports = {
  JOB_STATUSES,
  validateExtractedThread,
  validateTranslatedPost,
  validateTranslatedCommentBatch,
  validateTranslatedThread,
  isTerminalStatus
};
