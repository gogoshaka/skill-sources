# skill-sources

Curated source library for [Slideless](https://github.com/gogoshaka/slideless) deck research.

URLs are organized by topic, pushed by a browser extension, and consumed by the Slideless researcher agent.

## How it works

```
Browser Extension → this repo → Researcher Agent → Deck Author
     (push URL)     (store)      (read + fetch)     (build slides)
```

1. **Browse** — find a useful article, blog post, or doc
2. **Save** — click the browser extension to push the URL here with topic, priority, and tags
3. **Research** — the Slideless researcher agent reads curated URLs to seed deck research
4. **Build** — the deck author uses extracted claims to build slides

## Structure

```
topics/
├── microsoft-sentinel.json
├── microsoft-sentinel-graph.json
├── microsoft-defender.json
└── ...
_index.json          ← auto-generated topic index
sources.schema.json  ← JSON schema for validation
```

## Topic file format

```json
{
  "topic": "microsoft-sentinel-graph",
  "description": "Microsoft Sentinel Graph — graph-based security analytics",
  "tags": ["sentinel", "graph", "security", "microsoft"],
  "sources": [
    {
      "url": "https://techcommunity.microsoft.com/blog/...",
      "title": "Introducing Sentinel Graph Public Preview",
      "author": "Microsoft",
      "date": "2026-03",
      "priority": "P0",
      "summary": "Official announcement of Sentinel Graph",
      "tags": ["incident-graph", "hunting-graph"],
      "addedAt": "2026-03-26T06:35:00Z",
      "addedBy": "gogoshaka"
    }
  ]
}
```

## Source Priority

| Priority | Meaning | Examples |
|----------|---------|----------|
| **P0** | Official first-party | Vendor blogs, official docs, vendor webinars |
| **P1** | Reputable third-party | Conference blogs, industry analysts, tech publications |
| **P2** | Community content | Forum threads, personal blogs, unverified posts |

## Contributing

### Via browser extension (recommended)

Install the Slideless Sources extension → click Save on any page.

### Manually

1. Edit or create a topic file in `topics/`
2. Add your source entry following the schema
3. Open a PR

All sources must include: `url`, `title`, `priority`, `summary`, `addedAt`, `addedBy`.
