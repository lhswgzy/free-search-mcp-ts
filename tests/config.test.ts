import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FALLBACK_ENGINES,
  PRIMARY_ENGINES,
  defaultDataDir,
  ensureDataDir,
  loadConfig,
  parseDotEnv,
  redactConfig,
} from '../src/config.js';

/**
 * Every environment variable `loadConfig` can read from. Tests start from a
 * clean slate and the whole environment is restored afterwards, because
 * `loadConfig` also *writes* to `process.env` (a `.env` file is merged in, and
 * a proxy is exported under the conventional names).
 */
const MANAGED_PREFIXES = ['FREE_SEARCH_', 'FSMCP_', 'BRAVE_', 'SERPER_', 'TAVILY_', 'EXA_', 'SEARXNG_', 'GOOGLE_'];
const MANAGED_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'LOG_LEVEL',
];

let snapshot: NodeJS.ProcessEnv;
const tempDirs: string[] = [];

function cleanEnv(extra: Record<string, string> = {}): void {
  for (const key of Object.keys(process.env)) {
    if (MANAGED_PREFIXES.some((prefix) => key.startsWith(prefix)) || MANAGED_KEYS.includes(key)) delete process.env[key];
  }
  Object.assign(process.env, extra);
}

/** A temp data directory, optionally seeded with a config.json and/or a .env file. */
function tempDataDir(files: { config?: unknown; dotenv?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'fsmcp-config-'));
  tempDirs.push(dir);
  if (files.config !== undefined) {
    writeFileSync(join(dir, 'config.json'), typeof files.config === 'string' ? files.config : JSON.stringify(files.config));
  }
  if (files.dotenv !== undefined) writeFileSync(join(dir, '.env'), files.dotenv);
  return dir;
}

function load(dir: string, overrides?: Parameters<typeof loadConfig>[0]) {
  return loadConfig({ dataDir: dir, skipDotEnv: true, ...(overrides ?? {}) });
}

beforeEach(() => {
  snapshot = { ...process.env };
  cleanEnv();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('parseDotEnv', () => {
  it('parses comments, quotes, export prefixes and values containing "="', () => {
    const parsed = parseDotEnv(
      [
        '# a comment',
        '   # an indented comment',
        '',
        'A=1',
        'QUOTED="hello world"',
        "SINGLE='single value'",
        'export EXPORTED=x',
        'WITH_EQUALS=key=value',
        'TOKEN="abc=def"',
        'TRAILING=unquoted   ',
        'EMPTY=',
        '=novalue',
        'not a pair',
        'HASH=a#b',
      ].join('\n'),
    );

    expect(parsed).toEqual({
      A: '1',
      QUOTED: 'hello world',
      SINGLE: 'single value',
      EXPORTED: 'x',
      // Only the first "=" separates key from value, so a value may contain
      // more of them (secrets and JSON snippets do).
      WITH_EQUALS: 'key=value',
      TOKEN: 'abc=def',
      TRAILING: 'unquoted',
      EMPTY: '',
      HASH: 'a#b', // "#" only starts a comment at the beginning of a line
    });
  });

  it('handles CRLF line endings', () => {
    expect(parseDotEnv('A=1\r\n# note\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('loadConfig defaults', () => {
  it('falls back to the built-in defaults with an empty environment', () => {
    const dir = tempDataDir();
    const config = load(dir);

    expect(config.dataDir).toBe(resolve(dir));
    expect(config.cachePath).toBe(resolve(join(dir, 'cache.sqlite')));
    expect(config.configPath).toBe(join(resolve(dir), 'config.json'));

    expect(config.maxResults).toBe(12);
    expect(config.perEngineResults).toBe(10);
    expect(config.timeoutMs).toBe(15_000);
    expect(config.retries).toBe(1);
    expect(config.concurrency).toBe(6);
    expect(config.cacheEnabled).toBe(true);
    expect(config.cacheTtlMs).toBe(24 * 60 * 60 * 1000);
    expect(config.searchCacheTtlMs).toBe(15 * 60 * 1000);
    expect(config.respectRobots).toBe(true);
    expect(config.allowPrivateHosts).toBe(false);
    expect(config.safeSearch).toBe('moderate');
    expect(config.logLevel).toBe('warn');
    expect(config.rrfK).toBe(60);
    expect(config.proxy).toBeUndefined();

    // An empty engine list means "use the primary + fallback policy".
    expect(config.engines).toEqual([]);
    expect(config.autoEngines).toBe(true);
    expect(config.primaryEngines).toEqual([...PRIMARY_ENGINES]);
    expect(config.fallbackEngines).toEqual([...FALLBACK_ENGINES]);

    expect(config.keys.brave).toBeUndefined();
    expect(config.keys.googleCse.key).toBeUndefined();
  });

  it('ignores a config.json that is not a JSON object instead of crashing', () => {
    const broken = load(tempDataDir({ config: '{ not json at all' }));
    expect(broken.maxResults).toBe(12);

    const array = load(tempDataDir({ config: [1, 2, 3] }));
    expect(array.maxResults).toBe(12);
  });
});

describe('loadConfig precedence', () => {
  it('layers defaults < config.json < environment variables', () => {
    const dir = tempDataDir({ config: { maxResults: 30, timeoutMs: 5000, perEngineResults: 4 } });

    const fromFile = load(dir);
    expect(fromFile.maxResults).toBe(30);
    expect(fromFile.timeoutMs).toBe(5000);
    expect(fromFile.perEngineResults).toBe(4);
    expect(fromFile.retries).toBe(1); // untouched default

    process.env.FREE_SEARCH_MAX_RESULTS = '99';
    const fromEnv = load(dir);
    expect(fromEnv.maxResults).toBe(99); // the environment wins
    expect(fromEnv.timeoutMs).toBe(5000); // config.json still beats the default
  });

  it('reads .env from the data directory, but a real variable wins', () => {
    const dir = tempDataDir({ dotenv: 'FSMCP_MAX_RESULTS=42\nFREE_SEARCH_TIMEOUT=1234\n' });

    const fromDotEnv = loadConfig({ dataDir: dir });
    expect(fromDotEnv.maxResults).toBe(42);
    expect(fromDotEnv.timeoutMs).toBe(1234);

    const dir2 = tempDataDir({ dotenv: 'FSMCP_MAX_RESULTS=42\n' });
    process.env.FREE_SEARCH_MAX_RESULTS = '7';
    expect(loadConfig({ dataDir: dir2 }).maxResults).toBe(7);
  });

  it('can skip the .env file', () => {
    const dir = tempDataDir({ dotenv: 'FSMCP_MAX_RESULTS=42\n' });
    expect(load(dir).maxResults).toBe(12);
  });

  it('lets the environment override the engine list from config.json', () => {
    const dir = tempDataDir({ config: { engines: ['duckduckgo', 'mojeek'] } });
    expect(load(dir).engines).toEqual(['duckduckgo', 'mojeek']);

    process.env.FREE_SEARCH_ENGINES = 'brave';
    expect(load(dir).engines).toEqual(['brave']);
  });

  it('merges key overrides instead of replacing the whole key block', () => {
    process.env.SERPER_API_KEY = 'serper-key';
    const config = load(tempDataDir(), { overrides: { maxResults: 3, keys: { brave: 'brave-key', googleCse: {} } } });
    expect(config.maxResults).toBe(3);
    expect(config.keys.brave).toBe('brave-key');
    // A caller that only supplies one key must not silently drop the keys that
    // were loaded from the environment.
    expect(config.keys.serper).toBe('serper-key');
  });
});

describe('environment parsing', () => {
  it('honours the short FSMCP_* alias and prefers the long name', () => {
    const dir = tempDataDir();

    process.env.FSMCP_MAX_RESULTS = '7';
    expect(load(dir).maxResults).toBe(7);

    process.env.FREE_SEARCH_MAX_RESULTS = '9';
    expect(load(dir).maxResults).toBe(9);

    // A third alias exists for the language knob.
    process.env.FSMCP_LANG = 'zh';
    expect(load(dir).language).toBe('zh');
    process.env.FREE_SEARCH_LANGUAGE = 'en';
    expect(load(dir).language).toBe('en');
  });

  it('picks up the vendor-standard API key names', () => {
    const dir = tempDataDir();

    process.env.FREE_SEARCH_BRAVE_KEY = 'from-fsmcp';
    expect(load(dir).keys.brave).toBe('from-fsmcp');

    // A machine that already has BRAVE_API_KEY set just works.
    process.env.BRAVE_API_KEY = 'from-vendor';
    expect(load(dir).keys.brave).toBe('from-vendor');

    process.env.SERPER_API_KEY = 'serper';
    process.env.TAVILY_API_KEY = 'tavily';
    process.env.EXA_API_KEY = 'exa';
    process.env.SEARXNG_URL = 'https://searx.example.com';
    process.env.GOOGLE_CSE_KEY = 'google-key';
    process.env.GOOGLE_CSE_ID = 'google-cx';

    const keys = load(dir).keys;
    expect(keys).toMatchObject({
      serper: 'serper',
      tavily: 'tavily',
      exa: 'exa',
      searxng: 'https://searx.example.com',
    });
    expect(keys.googleCse).toEqual({ key: 'google-key', cx: 'google-cx' });
  });

  it('parses booleans the way shell users write them', () => {
    const dir = tempDataDir();
    for (const value of ['1', 'true', 'yes', 'on', 'Y', ' On ']) {
      process.env.FSMCP_CACHE = value;
      expect(load(dir).cacheEnabled, `FSMCP_CACHE=${value}`).toBe(true);
    }
    for (const value of ['0', 'false', 'no', 'off', 'N', ' OFF ']) {
      process.env.FSMCP_CACHE = value;
      expect(load(dir).cacheEnabled, `FSMCP_CACHE=${value}`).toBe(false);
    }

    // An unrecognised value keeps whatever the lower layer said: the default…
    process.env.FSMCP_CACHE = 'maybe';
    expect(load(dir).cacheEnabled).toBe(true);
    // …or the value from config.json.
    process.env.FSMCP_CACHE = 'maybe';
    expect(load(tempDataDir({ config: { cacheEnabled: false } })).cacheEnabled).toBe(false);

    process.env.FSMCP_RESPECT_ROBOTS = 'off';
    expect(load(dir).respectRobots).toBe(false);
    process.env.FSMCP_ALLOW_PRIVATE = '1';
    expect(load(dir).allowPrivateHosts).toBe(true);
    process.env.FSMCP_ROTATE_UA = 'no';
    expect(load(dir).rotateUserAgent).toBe(false);
  });

  it('validates booleans coming from config.json instead of casting them', () => {
    // A real JSON boolean always worked…
    expect(load(tempDataDir({ config: { cacheEnabled: false } })).cacheEnabled).toBe(false);
    // …but a quoted one used to stay a truthy string, so "false" quietly kept
    // the cache enabled. Both spellings now agree with the environment parser.
    expect(load(tempDataDir({ config: { cacheEnabled: 'false' } })).cacheEnabled).toBe(false);
    expect(load(tempDataDir({ config: { cacheEnabled: 'off' } })).cacheEnabled).toBe(false);
    expect(load(tempDataDir({ config: { cacheEnabled: 'yes' } })).cacheEnabled).toBe(true);
    expect(load(tempDataDir({ config: { respectRobots: 'no' } })).respectRobots).toBe(false);
    expect(load(tempDataDir({ config: { allowPrivateHosts: 'on' } })).allowPrivateHosts).toBe(true);
    // An unrecognised value keeps the default rather than guessing.
    expect(load(tempDataDir({ config: { cacheEnabled: 'maybe' } })).cacheEnabled).toBe(true);
  });

  it('falls back to the default when a numeric variable is unparseable', () => {
    process.env.FREE_SEARCH_MAX_RESULTS = 'abc'; // not a number at all
    process.env.FREE_SEARCH_TIMEOUT = '-5'; // a negative timeout is meaningless
    process.env.FSMCP_RETRIES = ''; // empty means unset
    process.env.FSMCP_CONCURRENCY = ' 25 '; // padding is tolerated

    const config = load(tempDataDir());
    expect(config.maxResults).toBe(12);
    expect(config.timeoutMs).toBe(15_000);
    expect(config.retries).toBe(1);
    expect(config.concurrency).toBe(25);
  });

  it('validates numbers coming from config.json instead of casting them', () => {
    // A hand-edited JSON file easily holds a string; a bare cast would put a
    // string into a field typed `number` and turn arithmetic into NaN.
    const config = load(tempDataDir({ config: { maxResults: '30', perEngineResults: 'abc', timeoutMs: -5 } }));
    expect(config.maxResults).toBe(30);
    expect(config.perEngineResults).toBe(10);
    expect(config.timeoutMs).toBe(15_000);
  });

  it('never turns the cache TTL into NaN and honours the hours form', () => {
    // With nothing configured the documented 24 hour default applies.
    expect(load(tempDataDir()).cacheTtlMs).toBe(24 * 60 * 60 * 1000);

    // These two knobs are the reason the hours form exists; they used to be
    // shadowed by the millisecond default and had no effect at all.
    process.env.FREE_SEARCH_CACHE_TTL_HOURS = '2';
    expect(load(tempDataDir()).cacheTtlMs).toBe(2 * 60 * 60 * 1000);

    // ...and config.json can set the same knob, as long as the environment is
    // silent (the environment always wins).
    delete process.env.FREE_SEARCH_CACHE_TTL_HOURS;
    expect(load(tempDataDir({ config: { cacheTtlHours: 3 } })).cacheTtlMs).toBe(3 * 60 * 60 * 1000);

    // Unparseable values fall back to the default rather than becoming NaN
    // (a NaN TTL silently disables expiry checks in PageCache.getPage).
    process.env.FREE_SEARCH_CACHE_TTL_HOURS = 'lots';
    expect(load(tempDataDir()).cacheTtlMs).toBe(24 * 60 * 60 * 1000);

    // An explicit millisecond value wins over the hours form.
    process.env.FREE_SEARCH_CACHE_TTL_MS = '60000';
    expect(load(tempDataDir()).cacheTtlMs).toBe(60_000);
  });

  it('derives autoEngines from an empty list or an "auto" entry', () => {
    const dir = tempDataDir();
    const none = load(dir);
    expect(none.engines).toEqual([]);
    expect(none.autoEngines).toBe(true);

    process.env.FSMCP_ENGINES = 'duckduckgo, mojeek';
    const explicit = load(dir);
    expect(explicit.engines).toEqual(['duckduckgo', 'mojeek']);
    expect(explicit.autoEngines).toBe(false);

    // One "auto" switches the whole policy on, and the rest of the list is
    // dropped rather than being interpreted as an explicit override.
    process.env.FSMCP_ENGINES = 'duckduckgo, auto, Brave';
    const mixed = load(dir);
    expect(mixed.autoEngines).toBe(true);
    expect(mixed.engines).toEqual([]);

    process.env.FSMCP_ENGINES = 'Brave,brave,MOJEEK';
    expect(load(dir).engines).toEqual(['brave', 'mojeek']);
  });
});

describe('proxy normalisation', () => {
  it('adds a missing scheme and exports the conventional variables', () => {
    process.env.FSMCP_PROXY = 'proxy.local:3128';
    const config = load(tempDataDir());
    expect(config.proxy).toBe('http://proxy.local:3128/');
    // Some transitive fetchers only read the conventional names.
    expect(process.env.HTTP_PROXY).toBe('http://proxy.local:3128/');
    expect(process.env.HTTPS_PROXY).toBe('http://proxy.local:3128/');
  });

  it('keeps an explicit scheme and drops an unusable value', () => {
    process.env.FSMCP_PROXY = 'socks5://127.0.0.1:1080';
    expect(load(tempDataDir()).proxy).toBe('socks5://127.0.0.1:1080');

    process.env.FSMCP_PROXY = 'http://';
    expect(load(tempDataDir()).proxy).toBeUndefined();
  });

  it('treats none/off as "no proxy"', () => {
    for (const value of ['none', 'off']) {
      cleanEnv({ FSMCP_PROXY: value });
      expect(load(tempDataDir()).proxy, `FSMCP_PROXY=${value}`).toBeUndefined();
    }
  });

  it('reads a proxy from config.json or HTTPS_PROXY when nothing else is set', () => {
    expect(load(tempDataDir({ config: { proxy: 'file-proxy.local:8080' } })).proxy).toBe('http://file-proxy.local:8080/');

    process.env.HTTPS_PROXY = 'http://from-env:8080';
    expect(load(tempDataDir()).proxy).toBe('http://from-env:8080/');
  });
});

describe('redactConfig', () => {
  it('masks API keys without ever printing them in full', () => {
    const secret = 'brave-secret-0123456789';
    process.env.BRAVE_API_KEY = secret;
    process.env.SEARXNG_URL = 'https://searx.example.com';
    const config = load(tempDataDir());

    const redacted = redactConfig(config) as { keys: Record<string, unknown> };
    const rendered = JSON.stringify(redacted);

    expect(rendered).not.toContain(secret);
    expect(redacted.keys.brave).toBe(`${secret.slice(0, 4)}…${secret.slice(-2)} (${secret.length} chars)`);
    expect(redacted.keys.brave).not.toBe(secret);
    // searxng is an instance URL, not a credential, so it is shown as-is.
    expect(redacted.keys.searxng).toBe('https://searx.example.com');
    // Keys that are absent stay absent instead of becoming "undefined".
    expect(redacted.keys.serper).toBeUndefined();
    // Redaction is display-only: the live config keeps the real key.
    expect(config.keys.brave).toBe(secret);
  });
});

describe('data directory', () => {
  it('resolves the data directory from the environment and creates it on demand', () => {
    const root = tempDataDir();
    const nested = join(root, 'nested', 'data');
    process.env.FSMCP_DATA_DIR = nested;

    const config = loadConfig({ skipDotEnv: true }); // no dataDir option, so the default applies
    expect(config.dataDir).toBe(resolve(nested));
    expect(existsSync(config.dataDir)).toBe(false);
    expect(ensureDataDir(config)).toBe(config.dataDir);
    expect(existsSync(config.dataDir)).toBe(true);
  });

  it('defaults to ~/.free-search-mcp', () => {
    expect(defaultDataDir()).toBe(join(homedir(), '.free-search-mcp'));
  });
});
