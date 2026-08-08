/**
 * Strict JSON extraction and schema validation for model output.
 *
 * Models return JSON wrapped in prose, fenced in markdown, prefixed with
 * "Here is the JSON:", or truncated mid-object. This module turns all of that
 * into either a validated object or a typed error — never a half-parsed one.
 *
 * The validator covers the JSON Schema subset this project actually uses. That
 * is a deliberate trade against pulling in ajv: the schemas here are small and
 * hand-written, and an unsupported keyword failing loudly (see `assertSchema`)
 * is safer than a dependency that silently accepts more than we intend.
 */
import { LlmError } from './errors.js';

const SUPPORTED_KEYWORDS = new Set([
  'type', 'properties', 'required', 'items', 'enum', 'additionalProperties',
  'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems',
  'nullable', 'description',
]);

/**
 * Reject schemas using keywords this validator does not implement.
 *
 * Without this, a future `pattern` or `oneOf` would be ignored rather than
 * enforced, and the validation would quietly mean less than it appears to.
 */
export function assertSchema(schema, path = '$') {
  if (!schema || typeof schema !== 'object') throw new Error(`Schema at ${path} must be an object`);
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new Error(`Unsupported JSON Schema keyword "${key}" at ${path}`);
    }
  }
  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) assertSchema(child, `${path}.${key}`);
  }
  if (schema.items) assertSchema(schema.items, `${path}[]`);
  return true;
}

const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

function matchesType(value, expected) {
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeOf(value) === expected;
}

/**
 * Validate a value against the supported schema subset.
 *
 * @param {any} value
 * @param {object} schema
 * @param {{stripUnknown?: boolean}} [options]
 * @returns {{valid: boolean, errors: string[], value: any}} value has unknown keys removed when stripping
 */
export function validateSchema(value, schema, options = {}) {
  const { stripUnknown = false } = options;
  const errors = [];

  const walk = (node, spec, path) => {
    if (!spec || typeof spec !== 'object') return node;

    if (node === null && spec.nullable) return node;

    if (spec.type) {
      const types = Array.isArray(spec.type) ? spec.type : [spec.type];
      if (!types.some((type) => matchesType(node, type))) {
        errors.push(`${path}: expected ${types.join(' or ')}, received ${typeOf(node)}`);
        return node;
      }
    }

    if (spec.enum && !spec.enum.includes(node)) {
      errors.push(`${path}: expected one of ${JSON.stringify(spec.enum)}, received ${JSON.stringify(node)}`);
    }

    if (typeof node === 'string') {
      if (spec.minLength !== undefined && node.length < spec.minLength) {
        errors.push(`${path}: shorter than minLength ${spec.minLength} (got ${node.length})`);
      }
      if (spec.maxLength !== undefined && node.length > spec.maxLength) {
        errors.push(`${path}: longer than maxLength ${spec.maxLength} (got ${node.length})`);
      }
    }

    if (typeof node === 'number') {
      if (spec.minimum !== undefined && node < spec.minimum) errors.push(`${path}: below minimum ${spec.minimum}`);
      if (spec.maximum !== undefined && node > spec.maximum) errors.push(`${path}: above maximum ${spec.maximum}`);
    }

    if (Array.isArray(node)) {
      if (spec.minItems !== undefined && node.length < spec.minItems) {
        errors.push(`${path}: expected at least ${spec.minItems} items, received ${node.length}`);
      }
      if (spec.maxItems !== undefined && node.length > spec.maxItems) {
        errors.push(`${path}: expected at most ${spec.maxItems} items, received ${node.length}`);
      }
      if (spec.items) return node.map((entry, index) => walk(entry, spec.items, `${path}[${index}]`));
      return node;
    }

    if (node && typeof node === 'object') {
      for (const key of spec.required || []) {
        if (!(key in node) || node[key] === undefined) errors.push(`${path}.${key}: required field is missing`);
      }

      const properties = spec.properties || {};
      const known = new Set(Object.keys(properties));
      const out = {};

      for (const [key, child] of Object.entries(node)) {
        if (known.has(key)) {
          out[key] = walk(child, properties[key], `${path}.${key}`);
          continue;
        }
        // An unexpected field is either an error or noise to drop, never a
        // silent pass-through into a stored document.
        if (spec.additionalProperties === false) {
          errors.push(`${path}.${key}: unexpected field`);
          if (!stripUnknown) out[key] = child;
        } else if (!stripUnknown) {
          out[key] = child;
        }
      }
      return out;
    }

    return node;
  };

  const result = walk(value, schema, '$');
  return { valid: errors.length === 0, errors, value: result };
}

/** Strip a ```json ... ``` fence, with or without the language tag. */
function stripFence(text) {
  const fence = text.match(/```(?:json|JSON)?\s*\r?\n?([\s\S]*?)```/);
  return fence ? fence[1] : text;
}

/**
 * Find the outermost balanced {...} or [...] in a string.
 *
 * String-aware: a brace inside a quoted value must not close the object, which
 * a naive lastIndexOf('}') gets wrong on any JSON containing punctuation.
 */
function sliceBalanced(text) {
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const opener = text[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

/**
 * Parse model output into JSON.
 *
 * @param {string} text
 * @returns {any}
 * @throws {LlmError} `empty_response` or `invalid_response`
 */
export function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new LlmError('Provider returned an empty response', 'empty_response');
  }

  const unfenced = stripFence(text).trim();

  for (const candidate of [unfenced, sliceBalanced(unfenced)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Fall through to the next strategy.
    }
  }

  const preview = unfenced.slice(0, 120).replace(/\s+/g, ' ');
  throw new LlmError(`Provider response was not valid JSON (starts: "${preview}")`, 'invalid_response');
}

/**
 * Parse and validate in one step.
 *
 * @param {string} text
 * @param {object} schema
 * @param {{stripUnknown?: boolean}} [options]
 * @returns {any}
 * @throws {LlmError} `empty_response`, `invalid_response`, or `schema_invalid`
 */
export function parseJsonWithSchema(text, schema, options = {}) {
  const parsed = extractJson(text);
  if (!schema) return parsed;

  const { valid, errors, value } = validateSchema(parsed, schema, options);
  if (!valid) {
    throw new LlmError(`Provider JSON failed schema validation: ${errors.join('; ')}`, 'schema_invalid', {
      details: errors,
    });
  }
  return value;
}
