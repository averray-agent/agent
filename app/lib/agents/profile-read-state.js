export function profileReadFailure(error) {
  if (!error) return null;
  const body = error.body;
  const code = body && typeof body === "object" ? (body.error ?? body.code) : undefined;
  return error.status === 404 && code === "agent_not_found"
    ? { kind: "unlisted", message: "This wallet is not listed in the public agent directory." }
    : { kind: "unavailable", message: "The agent profile could not be loaded. Retry the live read." };
}
