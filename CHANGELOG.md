# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2025-10-05

First release. Everything below is new.

### Added

**Tools (8)**

- `web_search` — multi-engine search with RRF fusion, de-duplication, per-engine weights, a consensus bonus and domain diversity caps. Supports `site:`, include/exclude domain filters, freshness, safe search, region and language hints.
- `research` — search → query expansion → concurrent fetch → passage extraction, returning a citable Markdown brief.
- `fetch_url` — HTML/PDF/DOCX/XLSX/PPTX/EPUB/ODT/CSV/JSON/text to Markdown, with a local cache, a continuation offset for long documents, and optional outgoing-link extraction.
- `fetch_urls` — bounded-concurrency batch fetching with per-URL error reporting.
- `parse_document` — local files and remote documents, including single-sheet extraction from spreadsheets.
- `search_index` — full-text search over the local page index, with CJK bigram support and no network access.
- `local_index` — stats, clear, prune and vacuum for the local index.
- `list_engines` — engine catalogue with tiers, key requirements and live health.

**Engines (24)**

- Primary keyless defaults: DuckDuckGo (HTML with lite fallback), Mojeek, Google News RSS.
- Fallback keyless: Bing, Baidu, Sogou, 360.
- Optional keyless: Startpage, Brave (HTML), SearXNG (own instance, with instance failover).
- Subject indexes: Wikipedia, Hacker News, GitHub, Stack Exchange, arXiv, OpenAlex, Crossref, npm, crates.io.
- Keyed: Brave Search API, Serper, Tavily, Exa, Google Programmable Search.

**Retrieval and ranking**

- Reciprocal Rank Fusion with per-engine weights, a multi-engine consensus bonus, promotion/demotion lists and a configurable damping constant.
- URL normalisation for de-duplication: tracking parameters, parameter ordering, `www.`, default ports, fragments, trailing slashes and `index.html`.
- Near-duplicate title collapsing using word-shingle Jaccard similarity, with merged engine attribution.
- Domain diversity caps and domain interleaving.
- Offline decoding of redirect wrappers (`baidu.com/link?url=`, `sogou.com/link?url=`, `so.com/link?m=`, `duckduckgo.com/l/?uddg=`, `bing.com/ck/a?u=`), with redirect-following as the fallback for wrappers that cannot be decoded.

**Resilience**

- Tiered escalation: primary → fallback → query-matched subject indexes.
- Circuit breaker with two failure classes: a block or a captcha benches an engine for the full cooldown after one occurrence; an unreachable host (DNS failure, connection refused, connect timeout) is benched for a shorter window. State persists in the local SQLite index so it survives a restart.
- No retry on fatal transport errors, which halves the cost of a search on a network that blocks a provider outright.
- Engines that return nothing, fail, or are skipped are all reported in the output rather than hidden.

**Local index**

- SQLite FTS5 (via the built-in `node:sqlite`, so there are no native modules), with `porter unicode61` tokenisation and CJK bigram expansion at index time.
- Conditional-request metadata and a JSON payload column so a cache hit rehydrates exactly as first returned.
- Short-TTL raw engine response cache.
- Graceful degradation to an in-process LRU when `node:sqlite` is unavailable, reported by `doctor`.

**Content pipeline**

- linkedom + Mozilla Readability + Turndown with GFM tables, task lists and fenced code blocks carrying language tags.
- Relative URL absolutisation before extraction, and `<base>` removal.
- A selector-free structural fallback extractor, so an engine markup change degrades quality instead of returning nothing.
- Document parsing built on `fflate` and `unpdf`: DOCX headings/lists/tables, XLSX per-sheet Markdown tables with shared strings and column alignment, PPTX one section per slide, EPUB in spine order, ODT, RFC-4180 CSV/TSV, JSON with a shape summary for large payloads, and PDF text repair for hyphenation and column artefacts.

**Networking**

- Proxy support (`FREE_SEARCH_PROXY`, `HTTPS_PROXY`, …), browser-like header sets, User-Agent rotation, bounded retries with jitter and `Retry-After` handling, response size caps, and SSRF protection against loopback and private address ranges.
- robots.txt parsing with longest-match precedence and per-host caching.

**Interfaces**

- MCP server over stdio and stateless streamable HTTP (with `/health` and a status page).
- CLI with 12 subcommands that call the same handlers the server registers.
- Installer for 13 clients (Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, Cline, Roo Code, Zed, Codex CLI, Gemini CLI, opencode, LM Studio, Continue) with detection, `.bak` backups, JSONC tolerance, TOML editing for Codex, dry runs and surgical uninstall.
- Markdown-first output for every tool, with an opt-in `format: "json"` path returning `structuredContent`.
- `doctor` diagnostics covering the runtime, the index backend, the data directory, the proxy, HTTPS reachability, a per-engine sweep and client registration.

### Notes

- Measured output cost: Markdown is 32 % fewer tokens than the equivalent JSON for a ten-result search; a fetched page's Markdown is 96–99 % smaller than the raw HTML it came from (mostly content extraction rather than the format itself).
- Verified against live traffic: Bing, Baidu, Sogou, 360, Hacker News, GitHub, Stack Exchange, npm, crates.io, OpenAlex, Crossref, arXiv. Verified against fixtures only, because the development network cannot reach them: DuckDuckGo, Mojeek, Google News, Startpage, Brave, SearXNG, Wikipedia. See the README's verification status section.

[0.1.0]: https://github.com/lhswgzy/free-search-mcp-ts/releases/tag/v0.1.0
