// #region types
/** The subset of JSON Schema that model output schemas actually need. */
export type Schema =
  | { type: 'object'; properties: Record<string, Schema>; required?: string[]; additionalProperties?: false; description?: string }
  | { type: 'array'; items: Schema; minItems?: number; maxItems?: number; description?: string }
  | { type: 'string'; enum?: string[]; pattern?: string; maxLength?: number; description?: string }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'null' }
  | { anyOf: Schema[]; description?: string };

export interface ValidationError {
  /** JSON Pointer to the offending value, e.g. /lines/2/amount */
  path: string;
  message: string;
}
// #endregion types

// #region validate
/**
 * Returns every error, not just the first: the list is fed back to the model
 * in a repair attempt, and fixing all problems at once saves a round trip.
 */
export function validate(value: unknown, schema: Schema, path = ''): ValidationError[] {
  const err = (message: string): ValidationError[] => [{ path: path || '/', message }];
  if ('anyOf' in schema) {
    const results = schema.anyOf.map((s) => validate(value, s, path));
    return results.some((r) => r.length === 0) ? [] : err(`does not match any allowed shape`);
  }
  switch (schema.type) {
    case 'null':
      return value === null ? [] : err('expected null');
    case 'boolean':
      return typeof value === 'boolean' ? [] : err('expected boolean');
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return err(`expected ${schema.type}`);
      if (schema.type === 'integer' && !Number.isInteger(value)) return err('expected integer');
      if (schema.minimum !== undefined && value < schema.minimum) return err(`must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) return err(`must be <= ${schema.maximum}`);
      return [];
    }
    case 'string': {
      if (typeof value !== 'string') return err('expected string');
      if (schema.enum && !schema.enum.includes(value)) return err(`must be one of ${schema.enum.join(', ')}`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return err(`longer than ${schema.maxLength}`);
      if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) return err(`does not match ${schema.pattern}`);
      return [];
    }
    case 'array': {
      if (!Array.isArray(value)) return err('expected array');
      const out: ValidationError[] = [];
      if (schema.minItems !== undefined && value.length < schema.minItems) out.push(...err(`fewer than ${schema.minItems} items`));
      if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(...err(`more than ${schema.maxItems} items`));
      value.forEach((v, i) => out.push(...validate(v, schema.items, `${path}/${i}`)));
      return out;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return err('expected object');
      const obj = value as Record<string, unknown>;
      const out: ValidationError[] = [];
      for (const k of schema.required ?? []) if (!(k in obj)) out.push({ path: `${path}/${k}`, message: 'is required' });
      for (const [k, v] of Object.entries(obj)) {
        const sub = schema.properties[k];
        if (sub) out.push(...validate(v, sub, `${path}/${k}`));
        else if (schema.additionalProperties === false) out.push({ path: `${path}/${k}`, message: 'is not allowed' });
      }
      return out;
    }
  }
}
// #endregion validate
