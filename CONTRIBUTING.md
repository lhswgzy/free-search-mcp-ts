# Contributing

Thanks for wanting to help. This project lives or dies on the quality of its engine coverage, so the
most valuable contribution is usually a fixed parser or a new engine.

## Getting set up

```bash
git clone https://github.com/sweetcornna/free-search-mcp
cd free-search-mcp
npm install
npm run build
npm test
node dist/cli.js doctor        # what actually works from your network
```

Requirements: Node 20.19+ to run, Node 22.5+ (24+ recommended) for the local SQLite index. There are no
native dependencies and no post-install build step, and please keep it that way — `node:sqlite` is a
deliberate choice over `better-sqlite3` so that `npx` never has to compile anything.

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run build
```

All three must pass. The type checker is strict (`noUncheckedIndexedAccess`, `noImplicitOverride`) and
the source compiles with a Node-only `lib` set, so `fetch`, `Response` and `Headers` come from
`@types/node` rather than `lib.dom`. If you need DOM APIs, wrap them at the boundary as
`src/html/markdown.ts` does rather than adding `"DOM"` to `lib`.

## Fixing a broken engine

A parser that stopped matching is the most common bug. The useful report contains the raw response.

```bash
# Capture what the engine actually returned
FREE_SEARCH_LOG_LEVEL=debug node dist/cli.js search "your query" --engines the-engine

# Or save the response body directly
curl -A "Mozilla/5.0 ..." "https://the-engine.example/search?q=test" -o /tmp/engine.html
```

Every HTML engine exports a `parse<Engine>Results(html, baseUrl, limit)` helper precisely so a capture
can be turned into a test without touching the network. Add the response under `tests/fixtures/`, write
a test that asserts on it, then fix the selectors.

Prefer `[class*=…]` attribute-substring selectors and structural extraction over exact class names:
several engines obfuscate or hash their class suffixes, and they change them often.

## Adding an engine

1. Create `src/engines/<id>.ts` exporting `create<Id>Engine(deps: EngineDeps): SearchEngine`. Use
   [`src/engines/bing.ts`](src/engines/bing.ts) as the reference implementation: build the request,
   `fetchHtml`/`fetchJson` through the shared client, call `detectBlock` so a captcha is reported as a
   block rather than as "no results", extract with explicit selectors plus the structural fallback, then
   `cap(results, options.limit)`.
2. Export a `parse<Id>Results` / `map<Id>Response` helper so it can be tested offline.
3. Register it in [`src/engines/registry.ts`](src/engines/registry.ts) with an id, tier, RRF weight,
   affinity and — for subject indexes — the query patterns that make it eligible.
4. If it needs a key, declare `requiresKey: true`, `keyEnv` and `keyUrl`, add the key to
   `Config['keys']` in [`src/config.ts`](src/config.ts), and throw a clear `EngineError` naming the
   environment variable when it is missing.
5. Add a fixture and a test. Add a row to the README engine tables if the tier list changed.

Weights: a documented JSON API around 1.1–1.15, a reliable HTML endpoint around 1.0, a volatile scraper
around 0.8–0.95. Put the reasoning in the registry entry's comment.

## Style

- **Explain why, not what.** Comments should say what makes a piece of code non-obvious: a provider
  quirk, a measured number, an ordering constraint, a trade-off that was decided. A comment restating the
  code is noise.
- **No `any`** unless a third-party type boundary forces it, and then confine it to one line with a note.
- **Report failures honestly.** A tool that returns "no results" when an engine was actually blocked is
  worse than one that says it was blocked. `detectBlock` exists for this.
- **No magic numbers without a measurement or a source.** The RRF constant cites its paper; the circuit
  breaker thresholds cite what was measured.
- English for code, comments, commit messages and documentation. The Chinese README mirrors the English
  one and should be kept in step when user-facing behaviour changes.

## Tests

`npm test` runs vitest. The suite must never touch the network: use the captured fixtures in
`tests/fixtures/` and inject a stub `HttpClient`. Tests must also be deterministic — no dependence on the
clock, the timezone or the locale; `parseDateLoose` accepts an explicit `now` for exactly this reason.

```bash
npx vitest run tests/rrf.test.ts        # one file
npx vitest                              # watch mode
```

## Commit messages

Conventional-commit prefixes, imperative mood, one idea per commit:

```
fix(bing): force English results with ensearch=1

Bing geolocates by IP and redirects to cn.bing.com, after which mkt,
setlang and cc are ignored: an English query returned 7/10 Chinese
titles. ensearch=1 returns 0/10.
```

If a change alters a number quoted in the README, update the README and rerun
`npx tsx scripts/measure-savings.mts`.

## Scope

Things this project will not do, so that a pull request proposing them is not a surprise:

- **No LLM calls.** `research()` is extractive on purpose. Adding a summarisation step would mean either
  shipping a model or requiring a second API key, and both break the "no key" promise.
- **No browser automation.** Playwright or a headless Chrome would solve JS-rendered engines but cost
  ~300 MB and a download on first run. Scrapers adapt structurally instead.
- **No telemetry, ever.**
- **No native modules.**

## Reporting a security issue

See [SECURITY.md](SECURITY.md) — please use a private advisory rather than a public issue.

## License

By contributing you agree that your contribution is licensed under the MIT License.
