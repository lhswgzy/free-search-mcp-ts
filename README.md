# free-search-mcp

**Local-first web search, page fetching and document parsing for any MCP client — with no API key.**

`free-search-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude, GPT, Cursor, Codex, local Ollama front ends and any other MCP-capable client the ability to search the web, read pages and parse documents. It runs entirely on your machine, needs no account, and returns Markdown instead of JSON because Markdown costs a model roughly a third fewer tokens for the same information.

One command installs it and registers it with the clients it finds:

```bash
npx -y free-search-mcp install
```

[![CI](https://github.com/sweetcornna/free-search-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sweetcornna/free-search-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen.svg)](https://nodejs.org)

---

## Why this exists

Asking a model to "look it up" usually means one of three things: pay for a search API, hand the model a browser it cannot drive, or paste URLs manually. None of them work well for a local model, and none of them keep your queries on your machine.

This server takes a different position:

- **No keys by default.** DuckDuckGo, Mojeek and Google News are queried directly over their public endpoints. Nothing to sign up for, nothing to leak.
- **Several engines, not one.** Every engine's result list is merged with Reciprocal Rank Fusion, so a page that three engines independently surface outranks a page only one engine found. The result set is stable in a way a single provider's is not.
- **It degrades instead of failing.** Engines that are blocked, rate-limited or unreachable are detected, benched, and replaced by the next tier. The server keeps working on networks that filter some providers — one of the engines in the default fallback tier is there precisely because it stays reachable where others do not.
- **Everything stays local.** Queries go to the search engine; the pages you read are stored in a local SQLite index on your disk, and nothing else is uploaded anywhere. There is no telemetry.
- **Markdown first.** The output is a heading-and-list document a model can read directly. Measured on a ten-result search, the Markdown form is **32 % fewer tokens** than the equivalent JSON ([see the measurements](#measured-not-claimed)).

## Quick start

```bash
# 1. Register the server with the MCP clients installed on this machine
npx -y free-search-mcp install

# 2. Confirm the engines and network work from here
npx -y free-search-mcp doctor

# 3. Try it without involving a client at all
npx -y free-search-mcp search "state of the art in retrieval augmented generation"
npx -y free-search-mcp research "how does reciprocal rank fusion work" --depth 2
```

Restart your client afterwards. If you would rather see what the installer would do before it touches anything:

```bash
npx -y free-search-mcp install --dry-run
```

## Tools exposed to the model

| Tool | What it does |
|------|--------------|
| **`web_search`** | Searches several engines at once, fuses the results with RRF, de-duplicates and re-ranks. Use it when you do not yet know which page holds the answer. |
| **`research`** | The whole loop in one call: search, derive follow-up queries from the vocabulary the first results actually use, fetch the most relevant and diverse sources, then extract the passages that answer the question. Returns a citable Markdown brief. |
| **`fetch_url`** | Fetches one page or document and returns clean Markdown. Handles HTML, PDF, DOCX, XLSX, PPTX, EPUB, ODT, CSV, JSON and plain text. Long documents are truncated with a continuation offset instead of being refused. |
| **`fetch_urls`** | Fetches up to twelve URLs concurrently, reporting failures per URL. |
| **`parse_document`** | Parses a local file or a remote document: spreadsheets become Markdown tables, presentations become one section per slide, DOCX keeps headings, lists and tables. |
| **`search_index`** | Full-text search over everything fetched so far, using a local SQLite FTS5 index with CJK bigram support. Costs no network requests. |
| **`local_index`** | Reports on, prunes, clears or compacts that local index. |
| **`list_engines`** | Lists every engine with its tier, whether it needs a key, and its live health. |

Every tool accepts `format: "json"` for callers that want to post-process the output instead of reading it.

## Engines

Twenty-four engines, in tiers. The tier decides when an engine runs; you can always override with `engines: ["bing", "wikipedia"]` or ask for everything with `engines: ["all"]`.

### Primary — the documented keyless defaults

| Engine | Notes |
|--------|-------|
| `duckduckgo` | HTML endpoint with an automatic fallback to the lite endpoint; region, freshness and safe-search parameters. |
| `mojeek` | An independent index with its own crawler — useful for escaping the Bing/Google duopoly. |
| `googlenews` | Google News RSS: articles rather than a general web index, with `when:` recency operators. |

### Fallback — used automatically when the primary tier returns too little

| Engine | Notes |
|--------|-------|
| `bing` | Keyless HTML. Reachable on networks where DuckDuckGo and Google are not, which is what makes it the global fallback. |
| `baidu`, `sogou`, `so360` | Chinese-language engines, eligible for CJK queries or an explicit `region: "cn"`. Their redirect wrappers are decoded locally. |

### Subject indexes — selected automatically from the query

`wikipedia`, `hackernews`, `github`, `stackexchange`, `arxiv`, `openalex`, `crossref`, `npm`, `crates`

A question about a Rust crate quietly gains crates.io; a question containing an error message gains Stack Overflow. The trigger list lives in [`src/engines/registry.ts`](src/engines/registry.ts) and is plain readable regex.

### Optional and keyed

| Engine | Notes |
|--------|-------|
| `startpage`, `brave` | Keyless HTML front ends. Frequently behind a consent or anti-bot wall, which is detected and reported as a block rather than as "no results". |
| `searxng` | Point it at your own instance with `SEARXNG_URL`. Accepts a comma-separated list and fails over between them. |
| `brave-api`, `serper`, `tavily`, `exa`, `google-cse` | Optional API-key engines. When a key is present they join the first tier and get a higher RRF weight, because a documented JSON API beats a scraper. |

```bash
BRAVE_API_KEY=... npx -y free-search-mcp search "..."      # or SERPER_API_KEY, TAVILY_API_KEY, EXA_API_KEY
SEARXNG_URL=https://searx.example.org npx -y free-search-mcp search "..."
```

## How it works

**Reciprocal Rank Fusion.** Each engine contributes `1 / (k + rank)` for every document it returns, with per-engine weights and a small bonus when several engines agree. RRF needs no calibration between providers, which matters because a Bing relevance score, a Mojeek BM25 score and a Google News publish order are not comparable numbers. See [`src/rrf.ts`](src/rrf.ts).

**Tiered escalation.** The primary tier runs first. Only if it returns fewer than a threshold does the fallback tier run, and only then do the subject indexes that match the query. A query the primary tier answers costs two or three HTTP requests; a query on a filtered network still succeeds.

**A circuit breaker that survives restarts.** A provider that is blocked (403/429/captcha) is benched for ten minutes after a single occurrence; a provider whose host cannot be connected to at all is benched for five. That state is written to the local SQLite index, so a restarted server — or your next command-line search — does not pay the timeout again.

**Redirect wrappers decoded offline.** Baidu, Sogou, 360, DuckDuckGo and Bing all hand back `/link?url=` or `/ck/a?u=` wrappers. Those are decoded locally, which fixes both citation quality and cross-engine de-duplication; only wrappers that cannot be decoded cost a redirect-following request.

**A local full-text index.** Every fetched page is stored in SQLite with an FTS5 index over its title and body. CJK text is expanded into overlapping bigrams at index time, because `unicode61` would otherwise treat a whole Chinese sentence as a single token and make it unsearchable.

**Markdown extraction.** linkedom parses, Mozilla Readability isolates the article, and Turndown renders GitHub-flavoured Markdown — headings, lists, tables, fenced code with language tags and absolute links. When Readability declines a page (a changelog, a spec, a table-heavy docs site) a conservative fallback strips the chrome from the body instead of giving up.

## Measured, not claimed

| Claim | Measurement |
|-------|-------------|
| Markdown costs fewer tokens than JSON | On a ten-result search: **3,752 chars / ~938 tokens** as Markdown versus **5,550 chars / ~1,388 tokens** as JSON — **32 % fewer tokens**. |
| Fetching a page returns far less than the raw HTML | MDN's Fetch API page: 150 kB of HTML → **5.4 kB** of Markdown (**96 %** smaller, ~38,300 → ~1,378 estimated tokens). Bing's and Baidu's result pages measure 97 % and 99 %. |
| The circuit breaker pays for itself | On a network where DuckDuckGo and Google News are unreachable: first search **11.9 s**, subsequently **1.3 s**, because the dead engines are benched in between. |

Reproduce the first two with `npx tsx scripts/measure-savings.mts`; the third with two consecutive `free-search-mcp search` calls.

## Clients

`free-search-mcp install` detects and patches the following. Only clients whose config file already exists are touched, every write is preceded by a `.bak` copy, and only the one key the server owns is modified.

| Client | Config file |
|--------|-------------|
| Claude Desktop | `claude_desktop_config.json` |
| Claude Code | `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code (Copilot agent mode) | `.vscode/mcp.json` or the user profile |
| Cline | `cline_mcp_settings.json` |
| Roo Code | `mcp_settings.json` |
| Zed | `settings.json` (`context_servers`) |
| Codex CLI | `~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/settings.json` |
| opencode | `~/.config/opencode/opencode.json` |
| LM Studio | `~/.lmstudio/mcp.json` |
| Continue | `~/.continue/config.json` |

```bash
npx -y free-search-mcp clients                          # every supported client id
npx -y free-search-mcp install --client cursor --dry-run
npx -y free-search-mcp install --client claude-desktop,codex
npx -y free-search-mcp uninstall --client cursor
```

**Ollama does not speak MCP.** The tool-calling loop has to live in the client, so point an MCP-aware front end at this server instead — run it over HTTP and add it in Open WebUI, LibreChat or any other MCP-capable UI:

```bash
free-search-mcp serve --transport http --port 8765
# then add http://127.0.0.1:8765/mcp as a streamable-HTTP MCP server
```

## Command line

```
free-search-mcp                     # serve MCP over stdio (what a client runs)
free-search-mcp install             # register with the clients found here
free-search-mcp uninstall           # remove the registration
free-search-mcp doctor              # check the network, every engine and the local index
free-search-mcp search  "<query>"   # multi-engine search
free-search-mcp research "<query>"  # search + read + extract, as a citable brief
free-search-mcp fetch   <url>       # one page or document as Markdown
free-search-mcp parse   <file>      # a local document as Markdown
free-search-mcp engines [--check]   # list engines, tiers and health
free-search-mcp cache   <stats|search|clear|prune|vacuum|path>
free-search-mcp config              # the effective configuration
free-search-mcp tools [--json]      # the MCP tool manifest
free-search-mcp clients             # supported client ids
```

Useful flags: `--json`, `--max <n>`, `--engines a,b`, `--freshness day|week|month|year`, `--lang`, `--region`, `--depth 1-3`, `--sources <n>`, `--data-dir <path>`, `--verbose`.

The subcommands call the same handlers the MCP server registers, so `free-search-mcp search "…"` is a genuine end-to-end test of what a model would receive.

## Configuration

Everything is optional. Copy [`.env.example`](.env.example) to `~/.free-search-mcp/.env`, or set the variables in your client's `env` block.

| Variable | Default | Purpose |
|----------|---------|---------|
| `FREE_SEARCH_ENGINES` | `auto` | Comma-separated engine ids, or `auto` for the tiered policy. |
| `FREE_SEARCH_MAX_RESULTS` | `12` | Default result count. |
| `FREE_SEARCH_TIMEOUT` | `15000` | Per-request timeout in milliseconds. |
| `FREE_SEARCH_CACHE` | `1` | Set to `0` to disable the local SQLite index. |
| `FREE_SEARCH_CACHE_TTL_HOURS` | `24` | How long a fetched page stays fresh. |
| `FREE_SEARCH_PROXY` | — | HTTP(S) proxy, e.g. `http://127.0.0.1:7890`. Standard `HTTPS_PROXY` is also honoured. |
| `FREE_SEARCH_RESPECT_ROBOTS` | `1` | Set to `0` to ignore robots.txt when fetching. |
| `FREE_SEARCH_ALLOW_PRIVATE` | `0` | Set to `1` to allow loopback/private addresses (off by default as an SSRF guard). |
| `FREE_SEARCH_REGION`, `FREE_SEARCH_LANGUAGE` | — | Region and language hints, e.g. `us` / `en`, `cn` / `zh`. |
| `FREE_SEARCH_DATA_DIR` | `~/.free-search-mcp` | Where the index and configuration live. |
| `FREE_SEARCH_LOG_LEVEL` | `warn` | `silent`, `error`, `warn`, `info` or `debug`. |

A JSON config file at `~/.free-search-mcp/config.json` accepts the same keys in camelCase.

### Behind a proxy or on a filtered network

The server works out of the box on the open internet. If your network filters some providers, either point it at a proxy:

```bash
FREE_SEARCH_PROXY=http://127.0.0.1:7890 free-search-mcp search "..."
```

or leave it alone and let the tiered fallback do its job — the fallback engines were chosen because they are reachable from networks that block DuckDuckGo and Google. `free-search-mcp doctor` prints a per-engine sweep so you can see exactly which engines work from where you are.

## Security and privacy

- **Nothing leaves your machine except the search queries and the pages you ask for.** There is no telemetry, no analytics, and no server component.
- **`fetch_url` is model-driven, so it is guarded.** Loopback, link-local and private-range addresses are refused by default; set `FREE_SEARCH_ALLOW_PRIVATE=1` if you deliberately want to read a local service.
- **robots.txt is honoured** for `fetch_url` by default, and a disallowed path is reported as such rather than silently skipped.
- **Local file access is limited to regular files** under 100 MB, and only through the explicit `parse_document` tool.
- **Nothing is written to stdout** except JSON-RPC. Diagnostics go to stderr, so a misbehaving log line can never corrupt the protocol stream.

## Requirements

- **Node.js 20.19+** to run.
- **Node.js 22.5+** (24+ recommended) for the local SQLite index, which uses the built-in `node:sqlite` module. On older runtimes the cache degrades to an in-process LRU and everything else keeps working — `doctor` tells you which backend is active.
- No native modules, no compiler, no post-install build step.

## Verification status

Honesty about what has been tested matters more than a feature list.

- **Verified against live traffic from this machine:** Bing, Baidu, Sogou, 360, Hacker News (Algolia), GitHub, Stack Exchange, npm, crates.io, OpenAlex, Crossref, and the full fetch → Markdown → index → re-read pipeline. `doctor`'s engine sweep and the CLI subcommands were exercised end to end, and the MCP server completed a 17-check protocol handshake (`initialize`, `tools/list`, `tools/call`, `ping`) over stdio.
- **Verified against captured real responses:** arXiv, and every engine listed above.
- **Verified against fixtures only, because this network cannot reach them:** DuckDuckGo, Mojeek, Google News, Startpage, Brave, SearXNG, Wikipedia. Their parsers, parameter mapping and error paths are covered by tests built from the documented markup and API shapes, but they have not been exercised against a live response. If one of them misbehaves for you, that is the most likely place, and an issue with the raw response attached is the fastest fix.
- **Not verified at all:** the five keyed engines' live responses (no keys available here). Their request construction and response mapping are verified offline against fixtures.

## Development

```bash
git clone https://github.com/sweetcornna/free-search-mcp
cd free-search-mcp
npm install
npm run build          # tsc -> dist/
npm test               # vitest
npm run typecheck
node dist/cli.js doctor
```

`npm run verify` runs the whole acceptance sequence — typecheck, build, the test
suite, both MCP protocol probes, the CLI surface and a packaging leak check — and
prints one summary. `npm run verify:online` additionally performs a live search,
fetch and engine sweep. The two protocol probes are standalone scripts, so you
can also check a build directly:

```bash
node scripts/probe-stdio.mjs     # speaks MCP over stdio like a client does
node scripts/probe-http.mjs      # exercises the streamable-HTTP transport
```

Layout:

```
src/
  cli.ts            command line and the stdio/HTTP entry point
  server.ts         MCP server, tool registration, both transports
  search.ts         tiered orchestration, RRF, wrapper decoding
  research.ts       search -> fetch -> passage extraction
  rrf.ts            Reciprocal Rank Fusion and de-duplication
  cache.ts          SQLite FTS5 page index and circuit-breaker state
  http.ts           proxy, retries, size caps, the SSRF guard
  robots.ts         robots.txt parsing and caching
  config.ts         defaults <- config.json <- .env <- environment
  html/markdown.ts  HTML -> Markdown pipeline
  fetch/page.ts     the fetch-and-convert service
  fetch/documents.ts PDF, DOCX, XLSX, PPTX, EPUB, ODT, CSV, JSON
  engines/          one file per engine, plus kit.ts and registry.ts
  install/          client specs and the installer
  tools/            tool schemas, handlers and Markdown renderers
tests/              vitest suites and engine fixtures
```

Adding an engine is one file plus one line in [`src/engines/registry.ts`](src/engines/registry.ts). Every engine declares its own tier, RRF weight and, for subject indexes, the query patterns that make it eligible.

## Limitations

- **`research()` quotes, it does not summarise.** This server has no language model, so the brief is extractive by design: it selects and quotes the passages that match the query and labels every one with a citable source. The calling model writes the synthesis. Calling that a summary would be a lie.
- **HTML scraping is inherently fragile.** Engines change their markup. The structural fallback extractor adapts without selectors, and a broken engine degrades to zero results and gets benched rather than breaking the search — but a provider can still change its markup faster than a release cycle.
- **The subject indexes are narrow by design.** Wikipedia, GitHub, crates.io and arXiv index specific corpora, not the web.
- **No OCR.** A scanned PDF is reported as having no extractable text rather than silently returning nothing.

## License

MIT — see [LICENSE](LICENSE).

---

If this saves you a search API bill, a star is appreciated. Issues with a raw engine response attached are the most useful kind of bug report.
