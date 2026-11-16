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
  typeName?: string;
  type?: string;
  shape?: () => Record<string, unknown>;
  values?: readonly string[];
  innerType?: unknown;
  element?: unknown;
  valueType?: unknown;
  defaultValue?: () => unknown;
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

  switch (def.typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodUnknown':
    case 'ZodAny':
      return { type: 'unknown' };
    case 'ZodLiteral':
      return { type: 'literal', enum: def.values };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodArray':
      return { type: 'array', items: describeZod(def.type ?? def.element, depth + 1) };
    case 'ZodRecord':
      return {
        type: 'object',
        additionalProperties: def.valueType ? describeZod(def.valueType, depth + 1) : true,
      };
    case 'ZodObject': {
      const shape = def.shape ? def.shape() : {};
      const properties: Record<string, ReflectedField> = {};
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = describeZod(value, depth + 1);
      }
      return { type: 'object', properties };
    }
    case 'ZodOptional':
    case 'ZodNullable': {
      const inner = describeZod(def.innerType, depth + 1);
      return { ...inner, optional: true };
    }
    case 'ZodDefault': {
      const inner = describeZod(def.innerType, depth + 1);
      return { ...inner, default: def.defaultValue ? def.defaultValue() : undefined };
    }
    case 'ZodUnion':
      return {
        type: 'union',
        anyOf: (def.options ?? []).map((option) => describeZod(option, depth + 1)),
      };
    case 'ZodEffects':
      return describeZod(def.schema, depth + 1);
    default:
      return { type: def.typeName ?? 'unknown' };
  }
}

export function describeZodObject(schema: unknown): Record<string, ReflectedField> {
  const reflected = describeZod(schema);
  return reflected.properties ?? {};
}
