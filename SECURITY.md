# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/sweetcornna/free-search-mcp/security/advisories/new)
rather than a public issue. Please include the version, the platform, and the smallest reproduction you can manage.

## Threat model

`free-search-mcp` runs as a local process with your user's privileges, spawned by an MCP client. Two
properties of that arrangement drive every decision below:

1. **Its inputs are model-generated.** `fetch_url` and `parse_document` take URLs and paths chosen by a
   language model, which may itself have been influenced by content it read earlier. Tool arguments are
   therefore treated as untrusted input, not as user intent.
2. **It has no server side.** There is no hosted component, no account and no telemetry, so there is no
   central place where your queries accumulate. The local index on your disk is the only data store.

## Controls

### Server-side request forgery

`fetch_url`, `fetch_urls`, `parse_document` (remote) and every engine request pass through
`assertFetchable()` before a socket is opened. It rejects:

- any scheme other than `http`/`https` (`file:`, `gopher:`, `data:`, …);
- `localhost`, `*.localhost`, `*.local`, `*.internal`;
- `127.0.0.0/8`, `10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12`, `169.254.0.0/16`;
- IPv6 loopback (`::1`), unique-local (`fc00::/7`) and link-local (`fe80::/10`).

Private targets require an explicit opt-in via `FREE_SEARCH_ALLOW_PRIVATE=1`. This is what stops a
prompt-injected page from asking the model to read `http://169.254.169.254/` (cloud instance metadata) or
an intranet service and quote it back.

Redirects are followed by the HTTP client, so a public URL that 302s to a private one is the residual
gap. Closing it properly needs per-hop validation, which is not implemented; if your threat model
includes a hostile remote server rather than a hostile model, put the process behind an egress firewall.

### Resource exhaustion

- Response bodies are capped (`FREE_SEARCH_MAX_BYTES`, default 5 MB) and read through a bounded stream
  reader, so a malicious or broken server cannot exhaust memory.
- Returned content is capped (`FREE_SEARCH_MAX_CHARS`, default 120 000) with a continuation offset.
- Local file parsing is limited to regular files under 100 MB.
- Fetches per call are capped (12 for `fetch_urls`, 15 sources for `research`), and concurrency is bounded.
- Every request has a timeout, and retries are bounded and skipped entirely for fatal transport errors.

The guarantee is boundedness, not availability: a model can still ask for many fetches in sequence. The
client's own tool-call limits are the right place to bound that.

### Local file access

`parse_document` reads a path from the model. It resolves to an absolute path, refuses directories and
non-regular files, and refuses anything over 100 MB. It does not restrict paths to a sandbox, because
the server runs with your privileges and reading your documents is the point of the tool. If you do not
want the model to be able to read arbitrary local files, do not expose `parse_document`.

### Protocol integrity

Nothing is ever written to stdout except JSON-RPC frames. All diagnostics go to stderr. A verbose log
line therefore cannot corrupt the protocol stream, which is the failure mode that makes an MCP server
appear to hang.

### Credentials

API keys (when you configure them) are read from the environment or from `~/.free-search-mcp/.env`, are
sent only to that provider, and are never logged: `config` and `doctor` print redacted forms via
`redactConfig()`. Keys stored in a client's config file live in that client's config file, with the
file permissions that client uses.

### Cache poisoning between callers

The local index is shared per data directory. Two different agents pointed at the same
`FREE_SEARCH_DATA_DIR` share fetched pages and circuit-breaker state. Set a distinct data directory per
untrusted caller if that sharing matters to you.

### Third-party content

Fetched pages are returned as Markdown to the model and are, by construction, untrusted. The server does
not execute scripts, does not render pages, and strips `<script>`, `<style>`, `<iframe>`, `<form>` and
similar elements. It cannot, however, stop a page from containing text that tries to instruct the model —
that is a prompt-injection concern which belongs to the client's own defences.

## Non-goals

- **No authentication or multi-tenancy.** The HTTP transport is intended for `127.0.0.1` or a trusted
  network. Exposing it to the internet without a reverse proxy that terminates authentication would let
  anyone use your machine as a fetcher. It binds to `127.0.0.1` by default.
- **No content filtering beyond safe search.** The engines' own safe-search settings are forwarded;
  nothing else is filtered.
- **No OCR.** A scanned PDF is reported as having no extractable text.

## Supported versions

The latest minor release receives security fixes. This project is at `0.x`, so pin a version if you
depend on it in an automated pipeline.
