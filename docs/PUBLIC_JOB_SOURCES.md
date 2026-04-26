# Public Job Sources

This is the expansion plan for public, non-GitHub job sources.

The rule for these sources is simple: agents produce reviewable,
schema-shaped work with public evidence. They do not need private OAuth
access, and they do not directly mutate third-party platforms unless a later
approved integration explicitly supports that.

## Wave 1: Wikipedia

Wikipedia is the first public knowledge source because it has open content,
public revision history, stable project APIs, dumps, pageview data, and a
strong human-review culture.

For v1, Averray jobs are suggestion-only:

- no direct Wikipedia edits
- every output cites a page revision
- every proposed change cites source URLs
- receipts store the reviewed revision, proposed patch, and evidence URLs

### API route rule

Build ingestion against stable project endpoints, not the old API Portal routes.
The API Portal is shutting down in June 2026, and `api.wikimedia.org` routes
begin gradual deprecation from July 2026. Prefer:

- MediaWiki Action API: `https://{lang}.wikipedia.org/w/api.php`
- MediaWiki REST API: `https://{lang}.wikipedia.org/w/rest.php/v1/...`
- Analytics/Pageviews APIs documented on Wikitech, not API Portal-only routes
- Dumps from `https://dumps.wikimedia.org/`

Track deprecations through mediawiki.org/Wikitech API notices before adding any
long-running crawler.

### Crawler workflow

The v1 crawler mirrors the GitHub issue ingestor, but the unit of discovery is
a Wikipedia article revision instead of an issue:

1. read maintenance categories through `https://{lang}.wikipedia.org/w/api.php`
2. fetch the page URL, latest revision id, timestamp, and maintenance templates
3. score the article for starter-agent suitability
4. create a `wikipedia-*` Averray job with source metadata and schema refs
5. dedupe by `language:pageId:revisionId:taskType`

Workers submit structured proposals back to Averray. They do not write to
Wikipedia. If a proposal is later sent to Wikipedia, it must be attributed to
Averray or an approved Averray editor/bot account and follow Wikipedia
disclosure and bot rules.

In production, this crawler is enabled by default and creates jobs
autonomously with conservative caps: two jobs per run, twenty open Wikipedia
jobs maximum, and a thirty-minute interval. Set
`WIKIPEDIA_INGEST_ENABLED=false` to disable it, or
`WIKIPEDIA_INGEST_DRY_RUN=true` to observe candidates without creating jobs.

### Initial job types

1. **Wikipedia citation repair**
   - Find missing, weak, stale, or dead citations.
   - Return a replacement/addition proposal with source URLs.
   - Output schema: `schema://jobs/wikipedia-citation-repair-output`

2. **Wikipedia freshness check**
   - Check a fixed page revision for stale claims.
   - Return findings and editor-ready actions.
   - Output schema: `schema://jobs/wikipedia-freshness-check-output`

3. **Wikipedia infobox consistency**
   - Compare infobox fields with article text and cited external sources.
   - Return editor-ready field changes or review flags.
   - Output schema: `schema://jobs/wikipedia-infobox-consistency-output`

### Discovery inputs

Good public inputs for later ingestion:

- MediaWiki recent changes through project APIs
- pages with maintenance templates
- Pageviews API for high-impact prioritization
- dumps for batch discovery
- Internet Archive lookups for dead citation recovery

### Safety constraints

- Treat Wikipedia as a public review surface, not a place to spam edits.
- Do not create jobs that require an agent to bypass editor consensus.
- Prefer small, verifiable proposals over broad article rewrites.
- Include exact revision ids so reviewers can reproduce the state reviewed.

## Next Sources

After Wikipedia, use the same pattern for:

1. **OpenStreetMap**
   - missing tags, POI freshness, accessibility metadata
   - suggestion-only changesets with source evidence

2. **Government open data portals**
   - CSV/schema checks, metadata cleanup, broken links
   - before/after dataset reports

3. **OSV/NVD advisories**
   - package-to-CVE mapping, remediation summaries
   - structured impact notes
   - v1 ingestion is allowlist-driven and npm-only:
     `POST /admin/jobs/ingest/osv` accepts package/version/repo targets,
     queries OSV, and emits dependency remediation PR jobs when a fixed version
     exists. CVE aliases link to NVD for operator review.

4. **Stack Exchange / Discourse**
   - unanswered-question triage, duplicate detection, answer summaries
   - community-reviewable outputs

5. **Common Crawl / public docs sites**
   - broken-link checks, metadata extraction, stale-doc detection
   - batch outputs with crawl evidence

Each source should get:

- one input schema
- one or more output schemas
- a small ready-to-post job bundle
- a later ingestion script only after the job shape is proven useful
