import { z } from 'zod'
import type { ZodType } from 'zod'

type JsonSchema = Record<string, unknown>

/**
 * 将 MCP 的 JSON Schema 描述转换为运行时校验器。
 * MCP 服务端可能返回比当前版本更丰富的 Schema，因此未知关键字会被安全忽略，
 * 但已声明的类型、必填字段和枚举仍会在工具执行前校验。
 */
export function zodFromJsonSchema(schema?: JsonSchema): ZodType<unknown> {
  if (!schema) {
    return z.record(z.string(), z.unknown())
  }

  const enumValues = schema.enum
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    const values = enumValues.filter(
      (value): value is string | number | boolean =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
    )
    if (values.length === enumValues.length && values.every((value) => typeof value === 'string')) {
      return z.enum(values as [string, ...string[]])
    }
    if (values.length === enumValues.length) {
      const literals = values.map((value) => z.literal(value))
      return literals.length === 1
        ? literals[0]!
        : z.union(
            literals as unknown as [ZodType<unknown>, ZodType<unknown>, ...ZodType<unknown>[]],
          )
    }
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const variants = schema.anyOf.filter(isSchema).map((variant) => zodFromJsonSchema(variant))
    if (variants.length === 1) {
      return variants[0]!
    }
    if (variants.length > 1) {
      return z.union(variants as [ZodType<unknown>, ZodType<unknown>, ...ZodType<unknown>[]])
    }
  }

  switch (schema.type) {
    case 'object':
      return objectSchema(schema)
    case 'array':
      return z.array(isSchema(schema.items) ? zodFromJsonSchema(schema.items) : z.unknown())
    case 'string': {
      let value = z.string()
      if (typeof schema.minLength === 'number' && schema.minLength >= 0) {
        value = value.min(schema.minLength)
      }
      if (typeof schema.maxLength === 'number' && schema.maxLength >= 0) {
        value = value.max(schema.maxLength)
      }
      return value
    }
    case 'number':
      return z.number()
    case 'integer':
      return z.number().int()
    case 'boolean':
      return z.boolean()
    case 'null':
      return z.null()
    default:
      return z.unknown()
  }
}

function objectSchema(schema: JsonSchema): ZodType<unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [],
  )
  const shape: Record<string, ZodType<unknown>> = {}
  for (const [name, property] of Object.entries(properties)) {
    const parsed = isSchema(property) ? zodFromJsonSchema(property) : z.unknown()
    shape[name] = required.has(name) ? parsed : parsed.optional()
  }
  const object = z.object(shape)
  return schema.additionalProperties === false ? object.strict() : object.passthrough()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSchema(value: unknown): value is JsonSchema {
  return isRecord(value)
}
