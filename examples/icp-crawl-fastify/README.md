# Async crawl API ICP

A Firecrawl-style async job API. Job creation and in-progress polls are left
untouched. The completed job response receives feedback instructions and is
grouped by the application's own crawl ID. The runnable demo accepts
`Authorization: Bearer demo-crawl-team-token` as a stand-in for product
authentication and derives `accountRef` and `userRef` from that verified server-side result
(`customerRef` is added only as the identical Ask-once account subject);
caller-supplied team or run headers are ignored.
