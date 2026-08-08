import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJson, validateSchema, parseJsonWithSchema, assertSchema,
} from '../../src/services/llm/json.js';
import { DECISION_SCHEMA, VALID_DECISION } from '../fixtures/llm.js';

test('json: parses plain JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('  [1,2,3]  '), [1, 2, 3]);
});

test('json: unwraps a markdown-fenced block', () => {
  const fenced = '```json\n{"selectedId": 2, "publish": true}\n```';
  assert.deepEqual(extractJson(fenced), { selectedId: 2, publish: true });

  // Models omit the language tag about as often as they include it.
  assert.deepEqual(extractJson('```\n{"ok":true}\n```'), { ok: true });
});

test('json: recovers JSON buried in prose', () => {
  const chatty = 'Sure! Here is the decision you asked for:\n\n{"publish": false}\n\nLet me know if you need changes.';
  assert.deepEqual(extractJson(chatty), { publish: false });
});

test('json: a brace inside a string does not end the object', () => {
  // The naive lastIndexOf('}') approach truncates this one.
  const tricky = 'Result: {"rationale": "the payload was {\\"role\\": \\"system\\"} injected", "publish": true} done';
  assert.deepEqual(extractJson(tricky), {
    rationale: 'the payload was {"role": "system"} injected',
    publish: true,
  });
});

test('json: an empty response is its own error code', () => {
  for (const empty of ['', '   ', '\n\n', null, undefined]) {
    assert.throws(() => extractJson(empty), (err) => {
      assert.equal(err.code, 'empty_response');
      return true;
    });
  }
});

test('json: malformed JSON throws invalid_response and never returns a partial object', () => {
  for (const bad of ['{"a": 1,', 'not json at all', '{oops}', '{"a": }']) {
    assert.throws(() => extractJson(bad), (err) => {
      assert.equal(err.code, 'invalid_response', `for input ${JSON.stringify(bad)}`);
      assert.equal(err.retryable, false);
      return true;
    });
  }
});

test('json: truncated output fails rather than parsing the fragment', () => {
  const truncated = '{"selectedId": 2, "rationale": "the model ran out of tok';
  assert.throws(() => extractJson(truncated), (err) => err.code === 'invalid_response');
});

test('schema: a valid object passes', () => {
  const { valid, errors } = validateSchema(VALID_DECISION, DECISION_SCHEMA);
  assert.equal(valid, true, errors.join('; '));
});

test('schema: missing required fields are reported individually', () => {
  const { valid, errors } = validateSchema({ selectedId: 1 }, DECISION_SCHEMA);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('publish')));
  assert.ok(errors.some((e) => e.includes('rationale')));
});

test('schema: wrong types are rejected', () => {
  const { valid, errors } = validateSchema(
    { selectedId: 'two', publish: 'yes', rationale: 'long enough to pass' }, DECISION_SCHEMA);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /expected integer/.test(e)));
  assert.ok(errors.some((e) => /expected boolean/.test(e)));
});

test('schema: bounds are enforced', () => {
  const short = validateSchema({ ...VALID_DECISION, rationale: 'too short' }, DECISION_SCHEMA);
  assert.equal(short.valid, false);
  assert.ok(short.errors.some((e) => /minLength/.test(e)));

  const outOfRange = validateSchema({ ...VALID_DECISION, confidence: 1.5 }, DECISION_SCHEMA);
  assert.equal(outOfRange.valid, false);
  assert.ok(outOfRange.errors.some((e) => /above maximum/.test(e)));

  const tooMany = validateSchema({ ...VALID_DECISION, tags: ['a', 'b', 'c', 'd', 'e', 'f'] }, DECISION_SCHEMA);
  assert.equal(tooMany.valid, false);
  assert.ok(tooMany.errors.some((e) => /at most 5 items/.test(e)));
});

test('schema: unexpected fields are stripped, not passed through to storage', () => {
  const withExtra = { ...VALID_DECISION, injectedField: 'ignore me', another: { nested: true } };

  const stripped = validateSchema(withExtra, DECISION_SCHEMA, { stripUnknown: true });
  assert.equal(stripped.valid, false, 'additionalProperties:false still reports them');
  assert.ok(!('injectedField' in stripped.value), 'the unknown key is gone from the value');

  // With a permissive schema the same input is clean once stripped.
  const permissive = { ...DECISION_SCHEMA, additionalProperties: true };
  const kept = validateSchema(withExtra, permissive, { stripUnknown: true });
  assert.equal(kept.valid, true);
  assert.deepEqual(Object.keys(kept.value).sort(), ['confidence', 'publish', 'rationale', 'selectedId', 'tags']);
});

test('schema: nested arrays of objects validate per element', () => {
  const schema = {
    type: 'object',
    required: ['posts'],
    properties: {
      posts: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['text'],
          properties: { text: { type: 'string', minLength: 5 } },
        },
      },
    },
  };

  assert.equal(validateSchema({ posts: [{ text: 'long enough' }] }, schema).valid, true);
  const bad = validateSchema({ posts: [{ text: 'ok' }, { nope: 1 }] }, schema);
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.includes('$.posts[0].text')));
  assert.ok(bad.errors.some((e) => e.includes('$.posts[1].text')));
});

test('schema: nullable fields accept null', () => {
  const schema = { type: 'object', properties: { publishedAt: { type: 'string', nullable: true } } };
  assert.equal(validateSchema({ publishedAt: null }, schema).valid, true);
  assert.equal(validateSchema({ publishedAt: 'x' }, schema).valid, true);
  assert.equal(validateSchema({ publishedAt: 7 }, schema).valid, false);
});

test('schema: an unsupported keyword fails loudly instead of being ignored', () => {
  // Silently ignoring `pattern` would make validation weaker than it looks.
  assert.throws(() => assertSchema({ type: 'string', pattern: '^a' }), /Unsupported JSON Schema keyword "pattern"/);
  assert.throws(() => assertSchema({ type: 'object', properties: { a: { oneOf: [] } } }), /oneOf/);
  assert.equal(assertSchema(DECISION_SCHEMA), true);
});

test('parseJsonWithSchema: schema failure is a distinct, non-retryable code', () => {
  assert.throws(() => parseJsonWithSchema('{"selectedId": 1}', DECISION_SCHEMA), (err) => {
    assert.equal(err.code, 'schema_invalid');
    assert.equal(err.retryable, false);
    assert.ok(Array.isArray(err.details) && err.details.length >= 2);
    return true;
  });
});

test('parseJsonWithSchema: fenced + valid returns the parsed object', () => {
  const text = `\`\`\`json\n${JSON.stringify(VALID_DECISION)}\n\`\`\``;
  assert.deepEqual(parseJsonWithSchema(text, DECISION_SCHEMA), VALID_DECISION);
});
