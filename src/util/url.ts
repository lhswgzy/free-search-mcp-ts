/**
 * URL normalisation, dedupe keys and domain extraction.
 *
 * Search engines disagree wildly about trailing slashes, `www.`, tracking
 * parameters and casing. Normalising before fusion is what lets RRF collapse
 * "the same page from four engines" into one strong result.
 */

/** Query parameters that never change which page you land on. */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'utm_name', 'utm_reader', 'utm_brand', 'utm_social', 'utm_social-type',
  'gclid', 'gclsrc', 'dclid', 'fbclid', 'msclkid', 'twclid', 'igshid', 'mc_cid',
  'mc_eid', 'yclid', 'wickedid', 'vero_id', 'vero_conv', '_hsenc', '_hsmi',
  'hsCtaTracking', 'mkt_tok', 'oly_anon_id', 'oly_enc_id', 'rb_clickid',
  's_cid', 'spm', 'scm', 'ref_src', 'ref_url', 'share_source', 'from_source',
  'trk', 'trkCampaign', 'sc_campaign', 'sc_channel', 'sc_content', 'sc_medium',
  'sc_outcome', 'sc_geo', 'sc_country', 'si', 'wt_mc', 'cmpid', 'campaign_id',
  'ncid', 'cid', 'smid', 'partner', 'source', 'ref', 'referrer',
]);

/** Params that some engines append and that DO matter to a few sites. */
const KEEP_PARAMS = new Set(['id', 'p', 'page', 'v', 'q', 's', 't', 'lang', 'hl', 'article']);

export interface NormalizedUrl {
  /** Canonical form used as the dedupe key. */
  key: string;
  /** Cleaned URL that is safe to show to a user and to re-fetch. */
  url: string;
  host: string;
  /** Host without `www.` and without the leading sub-domain chain. */
  domain: string;
  path: string;
}

/**
 * Normalise a URL into a dedupe key.
 *
 * Rules: lowercase scheme+host, drop `www.`, drop default ports, drop the
 * fragment, sort the surviving query params, drop tracking params, strip a
 * trailing slash on non-root paths, and drop a trailing `index.html`.
 * Returns `null` for non-http(s) URLs.
 */
export function normalizeUrl(input: string): NormalizedUrl | null {
  const raw = (input || '').trim();
  if (!raw) return null;

  // Engines sometimes return protocol-relative or scheme-less links.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw)
    ? raw
    : raw.startsWith('//')
      ? `https:${raw}`
      : `https://${raw}`;

  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }

  const protocol = u.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return null;

  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host.includes('.')) return null; // e.g. "localhost" typos from nav links

  const isDefaultPort =
    u.port === '' || (protocol === 'http:' && u.port === '80') || (protocol === 'https:' && u.port === '443');
  const port = isDefaultPort ? '' : `:${u.port}`;

  const params = new URLSearchParams();
  const entries = [...u.searchParams.entries()].filter(([k]) => {
    const lk = k.toLowerCase();
    if (TRACKING_PARAMS.has(lk) && !KEEP_PARAMS.has(lk)) return false;
    // Drop empty params and pure analytics payloads.
    return true;
  });
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [k, v] of entries) {
    if (v === '' && !KEEP_PARAMS.has(k.toLowerCase())) continue;
    params.append(k, v);
  }
  // URLSearchParams encodes spaces as '+', which is wrong for non-form URLs.
  const query = params.toString().replace(/\+/g, '%20');

  let path = u.pathname || '/';
  path = path.replace(/\/index\.(html?|php|aspx?)$/i, '/');
  path = decodeSafe(path);
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  if (path === '') path = '/';

  const cleanUrl = `${protocol}//${host}${port}${path}${query ? `?${query}` : ''}`;
  const domain = registrableDomain(host);

  return { key: cleanUrl, url: cleanUrl, host, domain, path };
}

function decodeSafe(s: string): string {
  try {
    // Only decode when it round-trips; avoids mangling literal '%' in paths.
    const d = decodeURIComponent(s);
    return encodeURI(d) === s || !s.includes('%') ? d : s;
  } catch {
    return s;
  }
}

/**
 * Best-effort registrable domain (eTLD+1) without shipping a 200 kB PSL.
 * Handles the common multi-part suffixes; anything unknown degrades to the
 * last two labels, which is fine for display and diversity scoring.
 */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.tw', 'com.hk', 'com.sg',
  'com.my', 'com.ph', 'com.vn', 'com.pk', 'com.eg', 'com.sa', 'com.ua',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'ne.kr',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'co.za', 'org.za',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'co.il', 'org.il', 'ac.il',
  'com.pl', 'com.ru', 'co.at', 'or.at', 'co.id', 'or.id', 'web.id',
  'com.sg', 'edu.sg', 'gov.sg', 'com.hk', 'edu.hk', 'gov.hk',
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app',
  'netlify.app', 'herokuapp.com', 's3.amazonaws.com', 'blogspot.com',
  'medium.com', 'substack.com', 'wordpress.com', 'readthedocs.io',
]);

export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const lastTwo = parts.slice(-2).join('.');
  const lastThree = parts.slice(-3).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return lastThree;
  return lastTwo;
}

/** Human-friendly source label: `en.wikipedia.org` -> `wikipedia.org`. */
export function displaySource(url: string): string {
  const n = normalizeUrl(url);
  if (!n) return '';
  return n.domain;
}

/** Strip an engine's redirect wrapper, e.g. DuckDuckGo's `/l/?uddg=`. */
export function unwrapRedirect(href: string): string {
  const raw = (href || '').trim();
  if (!raw) return raw;
  let u: URL;
  try {
    u = new URL(raw, 'https://placeholder.invalid');
  } catch {
    return raw;
  }
  const passthrough = ['uddg', 'url', 'u', 'q', 'target', 'to', 'redirect', 'redirect_url', 'r', 'link'];
  for (const key of passthrough) {
    const v = u.searchParams.get(key);
    if (!v) continue;
    let candidate = v;
    // Google/Bing sometimes return `/url?q=...` style relative wrappers.
    if (/^https?:\/\//i.test(candidate)) {
      try {
        return decodeURIComponent(candidate);
      } catch {
        return candidate;
      }
    }
    if (candidate.startsWith('/') || candidate.startsWith('//')) {
      try {
        const decoded = decodeURIComponent(candidate);
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch {
        /* ignore */
      }
    }
  }
  return raw;
}

/** True when two URLs point at the same document. */
export function sameUrl(a: string, b: string): boolean {
  const na = normalizeUrl(a);
  const nb = normalizeUrl(b);
  if (!na || !nb) return a === b;
  return na.key === nb.key;
}

/* ------------------------------------------------------------------ *
 * Redirect-wrapper unwrapping
 * ------------------------------------------------------------------ */

/** Query parameters that engines use to carry the real destination. */
const WRAPPER_PARAMS = ['u', 'url', 'uddg', 'target', 'to', 'redirect', 'redirect_url', 'link', 'r', 'q'];

/**
 * Decode an *encoded parameter value* into a URL.
 *
 * Engines usually prepend a short version marker to the encoded value (Bing
 * sends `u=a1aHR0cHM6Ly8…`). Rather than hard-code every marker, each leading
 * offset is tried and only a result that decodes to a complete http(s) URL is
 * accepted — garbage decodes almost never satisfy that.
 *
 * A value that is already a plain URL is returned unchanged.
 */
export function decodeBase64Target(value: string): string | undefined {
  const raw = (value || '').trim();
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;

  for (let offset = 0; offset <= 3 && offset < raw.length; offset++) {
    const candidate = raw.slice(offset);
    const base64 = candidate.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.length % 4 === 0 ? base64 : base64 + '='.repeat(4 - (base64.length % 4));
    let decoded: string;
    try {
      decoded = Buffer.from(padded, 'base64').toString('utf8');
    } catch {
      continue;
    }
    // Reject anything with replacement characters or control bytes: a wrong
    // offset produces mojibake that would not match this pattern anyway.
    if (/^https?:\/\/[^\s\u0000-\u001f]+$/i.test(decoded) && !decoded.includes('\ufffd')) {
      try {
        return new URL(decoded).toString();
      } catch {
        /* try the next offset */
      }
    }
  }
  return undefined;
}

/**
 * Extract the real destination from a redirect *wrapper href* without any
 * network request.
 *
 * Returns undefined when the URL is not a wrapper we understand, in which case
 * the caller can fall back to following the redirect. Accepts protocol-relative
 * hrefs (`//duckduckgo.com/l/?uddg=…`), which is the form DuckDuckGo returns.
 */
export function extractWrapperTarget(href: string): string | undefined {
  const raw = (href || '').trim();
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw, 'https://wrapper.invalid');
  } catch {
    return undefined;
  }
  for (const key of WRAPPER_PARAMS) {
    const value = u.searchParams.get(key);
    if (!value) continue;
    const decoded = decodeBase64Target(value);
    if (decoded) return decoded;
  }
  return undefined;
}

/** Host-level containment used by include/exclude domain filters. */
export function hostMatches(host: string, filter: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  const f = filter.toLowerCase().replace(/^www\./, '').replace(/^\./, '');
  if (!f) return false;
  return h === f || h.endsWith(`.${f}`);
}
