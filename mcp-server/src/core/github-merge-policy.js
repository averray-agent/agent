export function hasVerifiedGithubMerge(lookup) {
  return lookup?.status === "verified"
    && lookup.merged === true
    && ["open", "closed"].includes(lookup.state)
    && !Object.values(lookup.partial ?? {}).includes("unavailable");
}
