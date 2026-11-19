/**
 * packages/mcp-server/src/schema-reflect.ts
 *
 * Shallow reflection of the runtime Zod schemas owned by @routersync/core.
 *
 * The previous `get_schema` tool returned a hand-written draft-07 document that
 * described fields no schema in this build declares. This module reads the real
 * schemas instead, and the caller labels the result as a reflection rather than
 * a complete JSON Schema document.
 *
 * Zod exposes its internals through `_def`; that is not part of the public type
 * surface, so the shape is narrowed once here instead of using `any` per call.
 */

interface ZodDefLike {
  /** Zod 3 uses typeName; Zod 4 uses type. */
  typeName?: string;
  type?: string;
  /** Zod 3 exposes a shape factory; Zod 4 exposes the shape object. */
  shape?: (() => Record<string, unknown>) | Record<string, unknown>;
  values?: readonly string[];
  entries?: Record<string, unknown> | readonly string[];
  innerType?: unknown;
  element?: unknown;
  valueType?: unknown;
  /** Zod 3 stores a factory; Zod 4 stores the value. */
  defaultValue?: (() => unknown) | unknown;
  options?: unknown[];
  schema?: unknown;
}

function defOf(schema: unknown): ZodDefLike | undefined {
  if (schema === null || typeof schema !== 'object') return undefined;
  return (schema as { _def?: ZodDefLike })._def;
}

export interface ReflectedField {
  type: string;
  optional?: boolean;
  default?: unknown;
  enum?: readonly string[] | undefined;
  items?: ReflectedField;
  properties?: Record<string, ReflectedField>;
  additionalProperties?: ReflectedField | boolean;
  inner?: ReflectedField;
  anyOf?: ReflectedField[];
}

export function describeZod(schema: unknown, depth = 0): ReflectedField {
  const def = defOf(schema);
  if (!def) return { type: 'unknown' };
  if (depth > 5) return { type: 'truncated' };

  const kind = def.typeName ?? def.type;
  const enumValues = def.values ?? (Array.isArray(def.entries) ? def.entries : def.entries ? Object.keys(def.entries) : undefined);

  switch (kind) {
    case 'ZodString':
    case 'string':
      return { type: 'string' };
    case 'ZodNumber':
    case 'number':
      return { type: 'number' };
    case 'ZodBoolean':
    case 'boolean':
      return { type: 'boolean' };
    case 'ZodUnknown':
    case 'ZodAny':
    case 'unknown':
      return { type: 'unknown' };
    case 'ZodLiteral':
    case 'literal':
      return { type: 'literal', enum: enumValues };
    case 'ZodEnum':
    case 'enum':
      return { type: 'string', enum: enumValues };
    case 'ZodArray':
    case 'array':
      return { type: 'array', items: describeZod(def.type ?? def.element, depth + 1) };
    case 'ZodRecord':
    case 'record':
      return {
        type: 'object',
        additionalProperties: def.valueType ? describeZod(def.valueType, depth + 1) : true,
      };
    case 'ZodObject':
    case 'object': {
      const shape = typeof def.shape === 'function' ? def.shape() : (def.shape ?? {});
      const properties: Record<string, ReflectedField> = {};
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = describeZod(value, depth + 1);
      }
      return { type: 'object', properties };
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'optional':
    case 'nullable': {
      const inner = describeZod(def.innerType, depth + 1);
      return { ...inner, optional: true };
    }
    case 'ZodDefault':
    case 'default': {
      const inner = describeZod(def.innerType, depth + 1);
      const rawDefault = def.defaultValue;
      const value = typeof rawDefault === 'function' ? (rawDefault as () => unknown)() : rawDefault;
      return { ...inner, default: value };
    }
    case 'ZodUnion':
    case 'union':
      return {
        type: 'union',
        anyOf: (def.options ?? []).map((option) => describeZod(option, depth + 1)),
      };
    case 'ZodEffects':
    case 'pipe':
      return describeZod(def.schema, depth + 1);
    default:
      return { type: kind ?? 'unknown' };
  }
}

export function describeZodObject(schema: unknown): Record<string, ReflectedField> {
  const reflected = describeZod(schema);
  return reflected.properties ?? {};
}
