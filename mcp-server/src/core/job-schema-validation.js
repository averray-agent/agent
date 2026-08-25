import { ValidationError } from "./errors.js";

export function validateAgainstSchema(value, schema, path = "value") {
  const [violation] = collectSchemaViolations(value, schema, path);
  if (violation) throw new ValidationError(violation.message);
}

export function validateAgainstSchemaAll(value, schema, path = "value") {
  const violations = collectSchemaViolations(value, schema, path);
  if (violations.length > 0) {
    throw new ValidationError(violations[0].message, { violations });
  }
}

export function collectSchemaViolations(value, schema, path = "value") {
  const expected = schema.type;
  if (expected === "object") {
    if (!isPlainObject(value)) {
      return [violation(path, `${path} must be an object`)];
    }
    const violations = [];
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in value)) {
        violations.push(violation(`${path}.${key}`, `${path}.${key} is required`));
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (key in value) {
        violations.push(...collectSchemaViolations(value[key], propertySchema, `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          violations.push(violation(`${path}.${key}`, `${path}.${key} is not an allowed field`));
        }
      }
    }
    return violations;
  }

  if (expected === "array") {
    if (!Array.isArray(value)) {
      return [violation(path, `${path} must be an array`)];
    }
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      return [violation(path, `${path} must contain at least ${schema.minItems} item(s)`)];
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      return [violation(path, `${path} must contain at most ${schema.maxItems} item(s)`)];
    }
    const violations = [];
    value.forEach((entry, index) => {
      violations.push(...collectSchemaViolations(entry, schema.items ?? {}, `${path}[${index}]`));
    });
    return violations;
  }

  if (expected === "string") {
    if (typeof value !== "string") {
      return [violation(path, `${path} must be a string`)];
    }
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      return [violation(path, `${path} must be at least ${schema.minLength} character(s)`)];
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      return [violation(path, `${path} must be at most ${schema.maxLength} character(s)`)];
    }
    if (schema.pattern && !(new RegExp(schema.pattern, "u")).test(value)) {
      return [violation(path, `${path} does not match the expected format`)];
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      return [violation(path, `${path} must be one of ${schema.enum.join(", ")}`)];
    }
    return [];
  }

  if (expected === "number") {
    if (!Number.isFinite(value)) {
      return [violation(path, `${path} must be a number`)];
    }
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      return [violation(path, `${path} must be at least ${schema.minimum}`)];
    }
    return [];
  }

  if (expected === "integer") {
    if (!Number.isInteger(value)) {
      return [violation(path, `${path} must be an integer`)];
    }
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      return [violation(path, `${path} must be at least ${schema.minimum}`)];
    }
    return [];
  }

  if (expected === "boolean") {
    if (typeof value !== "boolean") {
      return [violation(path, `${path} must be a boolean`)];
    }
    return [];
  }

  return [];
}

function violation(path, message) {
  return { path, message };
}

export function stringSchema(options = {}) {
  return {
    type: "string",
    ...options
  };
}

export function integerSchema(options = {}) {
  return {
    type: "integer",
    ...options
  };
}

export function booleanSchema() {
  return {
    type: "boolean"
  };
}

export function enumString(values) {
  return {
    type: "string",
    enum: values
  };
}

export function arrayOfStrings(options = {}) {
  return {
    type: "array",
    items: { type: "string", minLength: 1 },
    ...options
  };
}

export function objectSchema({ properties = {}, required = [], additionalProperties = false, ...rest }) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties,
    ...rest
  };
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
