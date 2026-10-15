/**
 * A small JSON Schema validator for tool arguments. It supports the keywords tool
 * schemas use most and refuses any other validation keyword, so a schema never
 * looks stricter than it is.
 */

export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/** The supported subset of JSON Schema. */
export interface JsonSchema {
  type?: JsonType | JsonType[];
  enum?: readonly unknown[];
  const?: unknown;
  // strings
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  // numbers
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  // objects
  properties?: Record<string, JsonSchema | boolean>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  // arrays
  items?: JsonSchema | boolean;
  minItems?: number;
  maxItems?: number;
  // annotations, accepted and ignored
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown;
  format?: string;
  $schema?: string;
  $id?: string;
  $comment?: string;
  deprecated?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
}

/** One validation failure. `path` is like `args.files[2].name`. */
export interface SchemaError {
  path: string;
  message: string;
}

const TYPES = new Set<JsonType>(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const VALIDATION_KEYWORDS = new Set([
  'type', 'enum', 'const', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems',
]);
const ANNOTATION_KEYWORDS = new Set([
  'title', 'description', 'default', 'examples', 'format', '$schema', '$id', '$comment',
  'deprecated', 'readOnly', 'writeOnly',
]);

/** Thrown by {@link compileSchema} for a schema it cannot enforce. */
export class SchemaDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaDefinitionError';
  }
}

/** A compiled schema: call it with a value, get the errors (empty when valid). */
export type SchemaValidator = (value: unknown) => SchemaError[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return isPlainObject(value);
  }
}

/** Deep equality for JSON values, used by `enum` and `const`. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function nonNegativeInt(schema: Record<string, unknown>, key: string, at: string): number | undefined {
  const v = schema[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new SchemaDefinitionError(`${at}: "${key}" must be a non-negative integer`);
  }
  return v;
}

function finiteNumber(schema: Record<string, unknown>, key: string, at: string): number | undefined {
  const v = schema[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new SchemaDefinitionError(`${at}: "${key}" must be a number (the boolean form of draft 4 is not supported)`);
  }
  return v;
}

/**
 * Compiles a schema once, checking that every keyword is supported. Throws
 * {@link SchemaDefinitionError} for unknown keywords (such as `anyOf`, `$ref` or
 * `uniqueItems`) instead of silently not enforcing them. `format` and the other
 * annotations are accepted and not checked, as JSON Schema 2020-12 does by default.
 */
export function compileSchema(schema: JsonSchema | boolean, at = 'schema'): SchemaValidator {
  if (schema === true) return () => [];
  if (schema === false) return () => [{ path: '', message: 'no value is allowed here' }];
  if (!isPlainObject(schema)) throw new SchemaDefinitionError(`${at}: a schema must be an object or a boolean`);
  const s = schema as Record<string, unknown>;

  const unknown = Object.keys(s).filter((k) => !VALIDATION_KEYWORDS.has(k) && !ANNOTATION_KEYWORDS.has(k));
  if (unknown.length) {
    throw new SchemaDefinitionError(
      `${at}: unsupported keyword${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}; ` +
        'use a validate() function for anything beyond the supported subset',
    );
  }

  let types: JsonType[] | undefined;
  if (s.type !== undefined) {
    types = Array.isArray(s.type) ? (s.type as JsonType[]) : [s.type as JsonType];
    if (!types.length || types.some((t) => !TYPES.has(t))) throw new SchemaDefinitionError(`${at}: invalid "type"`);
  }
  if (s.enum !== undefined && !Array.isArray(s.enum)) throw new SchemaDefinitionError(`${at}: "enum" must be an array`);
  const enumValues = s.enum as unknown[] | undefined;
  const hasConst = Object.hasOwn(s, 'const');

  const minLength = nonNegativeInt(s, 'minLength', at);
  const maxLength = nonNegativeInt(s, 'maxLength', at);
  let pattern: RegExp | undefined;
  if (s.pattern !== undefined) {
    if (typeof s.pattern !== 'string') throw new SchemaDefinitionError(`${at}: "pattern" must be a string`);
    try {
      pattern = new RegExp(s.pattern, 'u');
    } catch (err) {
      throw new SchemaDefinitionError(`${at}: invalid "pattern": ${(err as Error).message}`);
    }
  }
  const minimum = finiteNumber(s, 'minimum', at);
  const maximum = finiteNumber(s, 'maximum', at);
  const exclusiveMinimum = finiteNumber(s, 'exclusiveMinimum', at);
  const exclusiveMaximum = finiteNumber(s, 'exclusiveMaximum', at);

  let properties: [string, SchemaValidator][] | undefined;
  if (s.properties !== undefined) {
    if (!isPlainObject(s.properties)) throw new SchemaDefinitionError(`${at}: "properties" must be an object`);
    properties = Object.entries(s.properties).map(([k, v]) => [k, compileSchema(v as JsonSchema, childPath(`${at}.properties`, k))]);
  }
  const propertyNames = new Set(properties?.map(([k]) => k));
  let required: string[] | undefined;
  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || s.required.some((r) => typeof r !== 'string')) {
      throw new SchemaDefinitionError(`${at}: "required" must be an array of strings`);
    }
    required = s.required as string[];
  }
  let additional: SchemaValidator | undefined;
  if (s.additionalProperties !== undefined) {
    if (typeof s.additionalProperties !== 'boolean' && !isPlainObject(s.additionalProperties)) {
      throw new SchemaDefinitionError(`${at}: "additionalProperties" must be a boolean or a schema`);
    }
    additional = compileSchema(s.additionalProperties as JsonSchema | boolean, `${at}.additionalProperties`);
  }

  let items: SchemaValidator | undefined;
  if (s.items !== undefined) {
    if (!isPlainObject(s.items) && typeof s.items !== 'boolean') {
      throw new SchemaDefinitionError(`${at}: "items" must be a schema (the array form is not supported)`);
    }
    items = compileSchema(s.items as JsonSchema | boolean, `${at}.items`);
  }
  const minItems = nonNegativeInt(s, 'minItems', at);
  const maxItems = nonNegativeInt(s, 'maxItems', at);

  const validate = (value: unknown, path: string, errors: SchemaError[]): void => {
    if (types && !types.some((t) => matchesType(value, t))) {
      errors.push({ path, message: `expected ${types.join(' or ')}, got ${typeOf(value)}` });
      return;
    }
    if (enumValues && !enumValues.some((e) => jsonEqual(e, value))) {
      errors.push({ path, message: `must be one of ${enumValues.map((e) => JSON.stringify(e)).join(', ')}` });
    }
    if (hasConst && !jsonEqual(s.const, value)) {
      errors.push({ path, message: `must equal ${JSON.stringify(s.const)}` });
    }
    if (typeof value === 'string') {
      // JSON Schema counts characters as Unicode code points.
      const length = minLength !== undefined || maxLength !== undefined ? [...value].length : 0;
      if (minLength !== undefined && length < minLength) errors.push({ path, message: `must be at least ${minLength} characters` });
      if (maxLength !== undefined && length > maxLength) errors.push({ path, message: `must be at most ${maxLength} characters` });
      if (pattern && !pattern.test(value)) errors.push({ path, message: `must match the pattern ${s.pattern as string}` });
    }
    if (typeof value === 'number') {
      if (minimum !== undefined && value < minimum) errors.push({ path, message: `must be >= ${minimum}` });
      if (maximum !== undefined && value > maximum) errors.push({ path, message: `must be <= ${maximum}` });
      if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) errors.push({ path, message: `must be > ${exclusiveMinimum}` });
      if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) errors.push({ path, message: `must be < ${exclusiveMaximum}` });
    }
    if (isPlainObject(value)) {
      for (const key of required ?? []) {
        if (!Object.hasOwn(value, key)) errors.push({ path: childPath(path, key), message: 'is required' });
      }
      for (const [key, child] of properties ?? []) {
        if (Object.hasOwn(value, key)) {
          for (const e of child(value[key])) errors.push({ path: childPath(path, key) + e.path, message: e.message });
        }
      }
      if (additional) {
        for (const key of Object.keys(value)) {
          if (propertyNames.has(key)) continue;
          if (s.additionalProperties === false) {
            errors.push({ path: childPath(path, key), message: 'is not an allowed property' });
          } else {
            for (const e of additional(value[key])) errors.push({ path: childPath(path, key) + e.path, message: e.message });
          }
        }
      }
    }
    if (Array.isArray(value)) {
      if (minItems !== undefined && value.length < minItems) errors.push({ path, message: `must have at least ${minItems} items` });
      if (maxItems !== undefined && value.length > maxItems) errors.push({ path, message: `must have at most ${maxItems} items` });
      if (items) {
        value.forEach((item, i) => {
          for (const e of items(item)) errors.push({ path: `${path}[${i}]${e.path}`, message: e.message });
        });
      }
    }
  };

  return (value) => {
    const errors: SchemaError[] = [];
    validate(value, '', errors);
    return errors;
  };
}

/**
 * Validates `value` against `schema` in one step. Paths in the errors start with
 * `args`. Prefer {@link compileSchema} when validating many values.
 */
export function validateSchema(schema: JsonSchema | boolean, value: unknown): SchemaError[] {
  return compileSchema(schema)(value).map((e) => ({ path: `args${e.path}`, message: e.message }));
}

/** Formats errors into one line, at most `limit` of them. */
export function formatSchemaErrors(errors: SchemaError[], limit = 3): string {
  const shown = errors.slice(0, limit).map((e) => `${e.path || 'args'} ${e.message}`);
  const more = errors.length > limit ? `; and ${errors.length - limit} more` : '';
  return shown.join('; ') + more;
}
