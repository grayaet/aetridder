const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const OUTPUT_SCHEMA_FILES = Object.freeze([
  "translated-post.schema.json",
  "translated-initial-batch.schema.json",
  "translated-comment-batch.schema.json",
  "translated-thread.schema.json"
]);

const STRICT_OUTPUT_KEYWORDS = new Set([
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "anyOf",
  "const",
  "description",
  "enum",
  "items",
  "properties",
  "required",
  "title",
  "type"
]);

function readSchema(name) {
  const filePath = path.join(__dirname, "..", "schemas", name);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function childSchemas(schema) {
  const children = [];
  if (!schema || typeof schema !== "object") {
    return children;
  }
  for (const key of ["items", "additionalProperties", "not"]) {
    if (schema[key] && typeof schema[key] === "object") {
      children.push([key, schema[key]]);
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    if (Array.isArray(schema[key])) {
      schema[key].forEach((child, index) => children.push([`${key}[${index}]`, child]));
    }
  }
  for (const key of ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]) {
    if (schema[key] && typeof schema[key] === "object" && !Array.isArray(schema[key])) {
      Object.entries(schema[key]).forEach(([name, child]) => children.push([`${key}.${name}`, child]));
    }
  }
  return children;
}

function isObjectSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  if (schema.type === "object") {
    return true;
  }
  return Array.isArray(schema.type) && schema.type.includes("object");
}

function collectStrictOutputProblems(schema, location = "$", problems = [], options = {}) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return problems;
  }

  for (const key of Object.keys(schema)) {
    if (!STRICT_OUTPUT_KEYWORDS.has(key)) {
      problems.push(`${location}: unsupported strict output schema keyword ${key}`);
    }
  }

  if (options.root && schema.type !== "object") {
    problems.push(`${location}: root schema must have type object`);
  }

  if (isObjectSchema(schema) && schema.additionalProperties !== false) {
    problems.push(`${location}: object schema must set additionalProperties false`);
  }

  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const propertyName of Object.keys(schema.properties)) {
      if (!required.has(propertyName)) {
        problems.push(`${location}: properties.${propertyName} is not listed in required`);
      }
    }
  }

  for (const [childLocation, child] of childSchemas(schema)) {
    collectStrictOutputProblems(child, `${location}.${childLocation}`, problems);
  }
  return problems;
}

test("Codex output schemas are compatible with strict structured output requirements", () => {
  const problems = OUTPUT_SCHEMA_FILES.flatMap((name) =>
    collectStrictOutputProblems(readSchema(name), "$", [], { root: true }).map((problem) => `${name} ${problem}`)
  );
  assert.deepEqual(problems, []);
});
