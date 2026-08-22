import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { schemaDisplayFields } from "@/lib/work/schema-shape.js";

type SchemaNode = {
  type: string;
  description: string;
  enum: unknown[] | null;
  minLength: number | null;
  minItems: number | null;
  fields: SchemaField[];
  items: SchemaNode | null;
};

type SchemaField = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  enum: unknown[] | null;
  node: SchemaNode;
};

export function SchemaPreview({ schema, schemaRef }: { schema: unknown; schemaRef: string }) {
  const fields = schemaDisplayFields(schema) as SchemaField[];
  return (
    <Card>
      <CardContent className="py-6">
        <p className="eyebrow">Output schema</p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">What you will submit</h2>
          <code className="rounded bg-[var(--paper)] px-2 py-1 text-xs text-[var(--muted)]">{schemaRef || "Schema loading"}</code>
        </div>
        {!schema ? (
          <p className="mt-4 text-sm text-[var(--muted)]">Loading the live schema. Claiming stays disabled until its terms are readable.</p>
        ) : fields.length ? (
          <div className="mt-5 grid gap-2">
            <SchemaFields fields={fields} />
          </div>
        ) : (
          <p className="mt-4 text-sm text-[var(--warn)]">The advertised schema has no readable object fields. The submission workspace will not guess a form.</p>
        )}
      </CardContent>
    </Card>
  );
}

function SchemaFields({ fields, nested = false }: { fields: SchemaField[]; nested?: boolean }) {
  return fields.map((field) => (
    <div
      key={field.name}
      className={nested
        ? "rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper-solid)] px-3 py-3"
        : "rounded-[var(--radius-sm)] border border-[var(--line)] px-4 py-3"}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="text-sm font-semibold text-[var(--ink)]">{field.name}</code>
        <div className="flex flex-wrap gap-2">
          <Badge tone={field.required ? "accent" : "muted"}>{field.required ? "required" : "optional"}</Badge>
          <Badge tone="neutral">{field.type}</Badge>
          {field.node.minLength !== null ? <Badge tone="neutral">minLength {field.node.minLength}</Badge> : null}
          {field.node.minItems !== null ? <Badge tone="neutral">minItems {field.node.minItems}</Badge> : null}
        </div>
        <SchemaConstraint node={field.node} fallback={field.description} />
      </div>
      {field.node.items ? (
        <div className="mt-3 border-l-2 border-[var(--line-strong)] pl-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
            Array item contract · {field.node.items.type}
          </p>
          <NodeContract node={field.node.items} />
        </div>
      ) : field.node.fields.length ? (
        <div className="mt-3 grid gap-2 border-l-2 border-[var(--line-strong)] pl-3">
          <SchemaFields fields={field.node.fields} nested />
        </div>
      ) : null}
    </div>
  ));
}

function NodeContract({ node }: { node: SchemaNode }) {
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
        {node.enum ? <span>Allowed: {node.enum.join(", ")}</span> : null}
        {node.minLength !== null ? <Badge tone="neutral">minLength {node.minLength}</Badge> : null}
        {node.minItems !== null ? <Badge tone="neutral">minItems {node.minItems}</Badge> : null}
        {!node.enum && node.description ? <span>{node.description}</span> : null}
      </div>
      {node.fields.length ? <SchemaFields fields={node.fields} nested /> : null}
      {node.items ? (
        <div className="border-l-2 border-[var(--line-strong)] pl-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
            Nested array item · {node.items.type}
          </p>
          <NodeContract node={node.items} />
        </div>
      ) : null}
    </div>
  );
}

function SchemaConstraint({ node, fallback }: { node: SchemaNode; fallback: string }) {
  return (
    <p className="text-xs text-[var(--muted)] sm:ml-auto sm:max-w-[52%] sm:text-right">
      {node.enum ? `Allowed: ${node.enum.join(", ")}` : fallback || (node.fields.length || node.items ? "Shape shown below." : "Validated against this field type.")}
    </p>
  );
}
