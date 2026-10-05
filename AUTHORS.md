# Authorship and origin

## Copyright holder

**lhswg** — GitHub [`lhswgzy`](https://github.com/lhswgzy) — © 2025.

All code in this repository was written for it. The MIT License in
[LICENSE](LICENSE) names this holder, because the copyright in this codebase
belongs to whoever wrote it, not to the author of a different project that
addresses a similar problem.

## Origin

This repository is an **independent, from-scratch TypeScript implementation** of
a local-first, key-free search MCP server.

The idea, and the far more mature project that came first, belong to
**`sweetcornna`**:

- Repository: <https://github.com/sweetcornna/free-search-mcp>
- Language: Python (`requires-python >=3.11`), packaged with `uv` and published
  on PyPI as `free-search-mcp`
- License: MIT

That project is the original. It is older, has a larger feature surface and a
real user base, and it reached all of that first.

To put it plainly: **this is not a fork, and no code was copied from it.**

## What the relationship is, precisely

| | |
|---|---|
| Fork? | **No.** These repositories share no commit history and no code. |
| Copied code? | **No.** No source file, engine parser or test from the Python project was read or reused while writing this one. It was written against a written description of the desired behaviour, the public search-provider endpoints, and the MCP specification. |
| Same name? | **No, on purpose.** The npm package is `free-search-mcp-ts`, not `free-search-mcp`. The original publishes to PyPI under `free-search-mcp`; claiming that name on npm would have crowded out the author's own project and sent anyone who typed it to a different codebase. |
| Parity claimed? | **No.** This is a smaller, younger project. Where the two differ, the original is the safer default. |
| Feature-set overlap? | **Yes, by intent.** Multi-engine search fused with reciprocal rank fusion, key-free default engines, Markdown-first output, a local cache and a `research()`-style combined tool are the design described for the original project. Ideas and behaviour are not copyrightable, and the original is MIT-licensed in any case; what is asserted as original here is this code. |

Attribution was added to the documentation rather than removed, because "which
project came first" is the one thing a reader of a near-namesake needs to know.

## Reporting an issue in the right place

- A bug in **this** TypeScript server → open an issue in this repository.
- A bug in the **original Python** project → open an issue at
  <https://github.com/sweetcornna/free-search-mcp/issues>.
