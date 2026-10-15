import { describe, expect, it } from 'vitest';
import { compileSchema, formatSchemaErrors, SchemaDefinitionError, validateSchema, type JsonSchema } from '../src/index.js';

const messages = (schema: JsonSchema | boolean, value: unknown) =>
  validateSchema(schema, value).map((e) => `${e.path} ${e.message}`);

describe('type', () => {
  it('checks each JSON type', () => {
    expect(messages({ type: 'string' }, 'a')).toEqual([]);
    expect(messages({ type: 'string' }, 1)).toEqual(['args expected string, got integer']);
    expect(messages({ type: 'number' }, 1.5)).toEqual([]);
    expect(messages({ type: 'number' }, '1')).toEqual(['args expected number, got string']);
    expect(messages({ type: 'boolean' }, false)).toEqual([]);
    expect(messages({ type: 'null' }, null)).toEqual([]);
    expect(messages({ type: 'array' }, [])).toEqual([]);
    expect(messages({ type: 'object' }, {})).toEqual([]);
  });

  it('treats integers as numbers, but not the reverse', () => {
    expect(messages({ type: 'number' }, 3)).toEqual([]);
    expect(messages({ type: 'integer' }, 3)).toEqual([]);
    expect(messages({ type: 'integer' }, 3.0)).toEqual([]);
    expect(messages({ type: 'integer' }, 3.5)).toEqual(['args expected integer, got number']);
  });

  it('does not count arrays or null as objects', () => {
    expect(messages({ type: 'object' }, [])).toEqual(['args expected object, got array']);
    expect(messages({ type: 'object' }, null)).toEqual(['args expected object, got null']);
  });

  it('rejects non-finite numbers', () => {
    expect(messages({ type: 'number' }, Number.NaN)).toHaveLength(1);
    expect(messages({ type: 'number' }, Number.POSITIVE_INFINITY)).toHaveLength(1);
  });

  it('accepts a list of types', () => {
    expect(messages({ type: ['string', 'null'] }, null)).toEqual([]);
    expect(messages({ type: ['string', 'null'] }, 2)).toEqual(['args expected string or null, got integer']);
  });
});

describe('enum and const', () => {
  it('compares deeply', () => {
    expect(messages({ enum: ['a', 1, { x: [1] }] }, { x: [1] })).toEqual([]);
    expect(messages({ enum: ['a', 1] }, '1')).toEqual(['args must be one of "a", 1']);
    expect(messages({ const: { a: 1 } }, { a: 1 })).toEqual([]);
    expect(messages({ const: { a: 1 } }, { a: 1, b: 2 })).toEqual(['args must equal {"a":1}']);
  });
});

describe('strings', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(messages({ maxLength: 2 }, '😀😀')).toEqual([]);
    expect(messages({ maxLength: 1 }, '😀😀')).toEqual(['args must be at most 1 characters']);
    expect(messages({ minLength: 3 }, 'ab')).toEqual(['args must be at least 3 characters']);
  });

  it('matches patterns anywhere unless anchored, with the u flag', () => {
    expect(messages({ pattern: 'b' }, 'abc')).toEqual([]);
    expect(messages({ pattern: '^b' }, 'abc')).toEqual(['args must match the pattern ^b']);
    expect(messages({ pattern: '^\\p{L}+$' }, 'héllo')).toEqual([]);
  });

  it('ignores string keywords on other types', () => {
    expect(messages({ maxLength: 1, pattern: '^x$' }, 12345)).toEqual([]);
  });
});

describe('numbers', () => {
  it('checks inclusive and exclusive bounds', () => {
    expect(messages({ minimum: 1, maximum: 3 }, 1)).toEqual([]);
    expect(messages({ minimum: 1, maximum: 3 }, 3)).toEqual([]);
    expect(messages({ minimum: 1 }, 0)).toEqual(['args must be >= 1']);
    expect(messages({ maximum: 3 }, 4)).toEqual(['args must be <= 3']);
    expect(messages({ exclusiveMinimum: 1 }, 1)).toEqual(['args must be > 1']);
    expect(messages({ exclusiveMaximum: 3 }, 3)).toEqual(['args must be < 3']);
  });
});

describe('objects', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: { path: { type: 'string' }, mode: { enum: ['r', 'w'] } },
    required: ['path'],
    additionalProperties: false,
  };

  it('requires properties and refuses extra ones', () => {
    expect(messages(schema, { path: 'a' })).toEqual([]);
    expect(messages(schema, {})).toEqual(['args.path is required']);
    expect(messages(schema, { path: 'a', extra: 1 })).toEqual(['args.extra is not an allowed property']);
  });

  it('reports nested paths', () => {
    expect(messages(schema, { path: 1, mode: 'x' })).toEqual([
      'args.path expected string, got integer',
      'args.mode must be one of "r", "w"',
    ]);
  });

  it('quotes keys that are not identifiers', () => {
    expect(messages({ type: 'object', required: ['a-b'] }, {})).toEqual(['args["a-b"] is required']);
  });

  it('validates additional properties against a schema', () => {
    const s: JsonSchema = { type: 'object', additionalProperties: { type: 'number' } };
    expect(messages(s, { a: 1, b: 2 })).toEqual([]);
    expect(messages(s, { a: 'x' })).toEqual(['args.a expected number, got string']);
  });

  it('does not treat inherited keys as present', () => {
    expect(messages({ type: 'object', required: ['toString'] }, {})).toEqual(['args.toString is required']);
  });

  it('handles __proto__ as an ordinary key', () => {
    const value = JSON.parse('{"__proto__": {"admin": true}}') as unknown;
    expect(messages({ type: 'object', additionalProperties: false }, value)).toEqual(['args.__proto__ is not an allowed property']);
  });
});

describe('arrays', () => {
  it('checks items and length', () => {
    const s: JsonSchema = { type: 'array', items: { type: 'string', maxLength: 3 }, minItems: 1, maxItems: 2 };
    expect(messages(s, ['a'])).toEqual([]);
    expect(messages(s, [])).toEqual(['args must have at least 1 items']);
    expect(messages(s, ['a', 'b', 'c'])).toEqual(['args must have at most 2 items']);
    expect(messages(s, ['a', 'long'])).toEqual(['args[1] must be at most 3 characters']);
  });

  it('reports paths through arrays of objects', () => {
    const s: JsonSchema = { type: 'array', items: { type: 'object', required: ['name'] } };
    expect(messages(s, [{ name: 'a' }, {}])).toEqual(['args[1].name is required']);
  });
});

describe('boolean schemas', () => {
  it('true allows anything, false allows nothing', () => {
    expect(messages(true, 'x')).toEqual([]);
    expect(messages(false, 'x')).toHaveLength(1);
    expect(messages({ type: 'object', properties: { a: false } }, { a: 1 })).toEqual(['args.a no value is allowed here']);
  });
});

describe('schema definition errors', () => {
  it('refuses unsupported keywords instead of ignoring them', () => {
    expect(() => compileSchema({ anyOf: [{ type: 'string' }] } as JsonSchema)).toThrow(SchemaDefinitionError);
    expect(() => compileSchema({ $ref: '#/x' } as JsonSchema)).toThrow(/unsupported keyword "\$ref"/);
    expect(() => compileSchema({ type: 'object', properties: { a: { uniqueItems: true } } } as JsonSchema)).toThrow(
      /schema\.properties\.a: unsupported keyword "uniqueItems"/,
    );
  });

  it('accepts annotations, including format, without checking them', () => {
    const v = compileSchema({ type: 'string', format: 'uri', description: 'x', title: 't', default: 'a', examples: ['a'] });
    expect(v('not a uri')).toEqual([]);
  });

  it('refuses invalid keyword values', () => {
    expect(() => compileSchema({ type: 'text' } as unknown as JsonSchema)).toThrow(/invalid "type"/);
    expect(() => compileSchema({ minLength: -1 })).toThrow(/non-negative integer/);
    expect(() => compileSchema({ pattern: '(' })).toThrow(/invalid "pattern"/);
    expect(() => compileSchema({ exclusiveMinimum: true } as unknown as JsonSchema)).toThrow(/must be a number/);
    expect(() => compileSchema({ items: [{ type: 'string' }] } as unknown as JsonSchema)).toThrow(/array form/);
    expect(() => compileSchema({ required: 'a' } as unknown as JsonSchema)).toThrow(/array of strings/);
    expect(() => compileSchema('x' as unknown as JsonSchema)).toThrow(/object or a boolean/);
  });
});

describe('formatSchemaErrors', () => {
  it('shows the first few and counts the rest', () => {
    const errors = [1, 2, 3, 4, 5].map((n) => ({ path: `args.f${n}`, message: 'is required' }));
    expect(formatSchemaErrors(errors)).toBe('args.f1 is required; args.f2 is required; args.f3 is required; and 2 more');
  });
});
