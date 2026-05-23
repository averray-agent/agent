export function createSchemaRoutes({
  getPublicBuiltinJobSchemaByName,
  listBuiltinJobSchemas,
  respond,
  schemaRefToJobSchemaPath,
}) {
  return async function handleSchemaRoute({ request, response, pathname }) {
    if (request.method === "GET" && pathname === "/schemas/jobs") {
      const schemas = listBuiltinJobSchemas().map((entry) => ({
        ...entry,
        path: schemaRefToJobSchemaPath(entry.$id)
      }));
      respond(
        response,
        200,
        {
          schemas,
          count: schemas.length,
          docs: "https://github.com/depre-dev/agent/tree/main/docs/schemas/jobs"
        },
        { "cache-control": "public, max-age=300" }
      );
      return true;
    }

    if (request.method === "GET" && pathname.startsWith("/schemas/jobs/")) {
      const schemaName = decodeURIComponent(pathname.slice("/schemas/jobs/".length));
      const schema = getPublicBuiltinJobSchemaByName(schemaName);
      if (!schema) {
        respond(response, 404, {
          status: "not_found",
          message: "Unknown built-in job schema."
        });
        return true;
      }
      respond(response, 200, schema, { "cache-control": "public, max-age=300" });
      return true;
    }

    return false;
  };
}
