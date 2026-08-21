export function deriveSchemaExample(schema, fieldName = "value") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "";
  if (schema.default !== undefined) return clone(schema.default);
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return clone(schema.examples[0]);
  if (schema.const !== undefined) return clone(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return clone(schema.enum[0]);
  if (schema.type === "object" || schema.properties) {
    const properties = objectValue(schema.properties) ?? {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const selected = Object.keys(properties).filter((key, index) => required.has(key) || index < 3);
    return Object.fromEntries(selected.map((key) => [key, deriveSchemaExample(properties[key], key)]));
  }
  if (schema.type === "array") {
    const count = Math.max(Number.isInteger(schema.minItems) ? schema.minItems : 0, 1);
    return Array.from({ length: count }, () => deriveSchemaExample(schema.items, singular(fieldName)));
  }
  if (schema.type === "integer" || schema.type === "number") {
    return Number.isFinite(schema.minimum) ? schema.minimum : 1;
  }
  if (schema.type === "boolean") return true;
  return `<${fieldName.replace(/[_-]+/gu, " ")}>`;
}

export function schemaFields(schema) {
  const properties = objectValue(schema?.properties) ?? {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  return Object.entries(properties).map(([name, raw]) => {
    const property = objectValue(raw) ?? {};
    const type = Array.isArray(property.type)
      ? property.type.filter((entry) => entry !== "null").join(" or ")
      : String(property.type ?? inferType(property));
    return {
      name,
      type,
      required: required.has(name),
      description: typeof property.description === "string" ? property.description : "",
      enum: Array.isArray(property.enum) ? property.enum : null,
      schema: property
    };
  });
}

export function rawFieldDraft(schema, example = deriveSchemaExample(schema)) {
  const record = objectValue(example) ?? {};
  return Object.fromEntries(schemaFields(schema).map((field) => {
    const value = record[field.name];
    if (value === undefined || value === null) return [field.name, ""];
    if (typeof value === "object") return [field.name, JSON.stringify(value, null, 2)];
    return [field.name, String(value)];
  }));
}

function inferType(schema) {
  if (schema?.properties) return "object";
  if (schema?.items) return "array";
  return "string";
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function singular(value) {
  return String(value).endsWith("s") ? String(value).slice(0, -1) : String(value);
}
