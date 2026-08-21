import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { schemaFields } from "@/lib/work/schema-shape.js";

export function SchemaPreview({ schema, schemaRef }: { schema: unknown; schemaRef: string }) {
  const fields = schemaFields(schema) as Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
    enum: unknown[] | null;
  }>;
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
            {fields.map((field) => (
              <div key={field.name} className="flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--line)] px-4 py-3 sm:flex-row sm:items-center">
                <code className="text-sm font-semibold text-[var(--ink)]">{field.name}</code>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={field.required ? "accent" : "muted"}>{field.required ? "required" : "optional"}</Badge>
                  <Badge tone="neutral">{field.type}</Badge>
                </div>
                <p className="text-xs text-[var(--muted)] sm:ml-auto sm:max-w-[52%] sm:text-right">
                  {field.enum ? `Allowed: ${field.enum.join(", ")}` : field.description || "Validated against this field type."}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-[var(--warn)]">The advertised schema has no readable object fields. The submission workspace will not guess a form.</p>
        )}
      </CardContent>
    </Card>
  );
}
