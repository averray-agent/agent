import { ValidationError } from "./errors.js";

export function validateAgainstSchema(value, schema, path = "value") {
  const expected = schema.type;
  if (expected === "object") {
    if (!isPlainObject(value)) {
      throw new ValidationError(`${path} must be an object`);
    }
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in value)) {
        throw new ValidationError(`${path}.${key} is required`);
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (key in value) {
        validateAgainstSchema(value[key], propertySchema, `${path}.${key}`);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          throw new ValidationError(`${path}.${key} is not an allowed field`);
        }
      }
    }
    return;
  }

  if (expected === "array") {
    if (!Array.isArray(value)) {
      throw new ValidationError(`${path} must be an array`);
    }
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      throw new ValidationError(`${path} must contain at least ${schema.minItems} item(s)`);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      throw new ValidationError(`${path} must contain at most ${schema.maxItems} item(s)`);
    }
    value.forEach((entry, index) => {
      validateAgainstSchema(entry, schema.items ?? {}, `${path}[${index}]`);
    });
    return;
  }

  if (expected === "string") {
    if (typeof value !== "string") {
      throw new ValidationError(`${path} must be a string`);
    }
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      throw new ValidationError(`${path} must be at least ${schema.minLength} character(s)`);
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      throw new ValidationError(`${path} must be at most ${schema.maxLength} character(s)`);
    }
    if (schema.pattern && !(new RegExp(schema.pattern, "u")).test(value)) {
      throw new ValidationError(`${path} does not match the expected format`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      throw new ValidationError(`${path} must be one of ${schema.enum.join(", ")}`);
    }
    return;
  }

  if (expected === "number") {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`${path} must be a number`);
    }
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      throw new ValidationError(`${path} must be at least ${schema.minimum}`);
    }
    return;
  }

  if (expected === "integer") {
    if (!Number.isInteger(value)) {
      throw new ValidationError(`${path} must be an integer`);
    }
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      throw new ValidationError(`${path} must be at least ${schema.minimum}`);
    }
    return;
  }

  if (expected === "boolean") {
    if (typeof value !== "boolean") {
      throw new ValidationError(`${path} must be a boolean`);
    }
    return;
  }
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
