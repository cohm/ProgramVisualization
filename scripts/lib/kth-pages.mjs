// HTTP and study-plan page helpers shared by the scripts that read kth.se.
//
// Moved out of extract-from-kopps.mjs unchanged, so a second script that reads
// study-plan pages (extract-master-mapping.mjs) uses the same retry policy, host
// allow-list and state-blob decoder instead of a copy of them.

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// KTH's www host rejects requests without a browser-ish UA.
export const UA = 'Mozilla/5.0 (compatible; ProgramVisualization data extractor)';

// A transient failure is worth retrying; a 4xx is an answer. Without this a
// single blip anywhere in a run of hundreds of requests took the whole run down
// — or, worse, was caught by a caller and became a silently wrong value. Both
// happened: a rate-limited course page once returned a fallback shape that
// collapsed five CTMAT courses to an identical {P1: 7.5}, which only showed up
// because the committed data disagreed.
export const RETRY_ATTEMPTS = 3;
export const RETRY_BASE_MS = 400;
export const isTransient = (status) => status === 408 || status === 429 || status >= 500;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every URL this script fetches is built by interpolating a course or programme
// code into a fixed template, and those codes come from files in this repo and
// from KTH's own pages. CodeQL flags that as file data reaching an outbound
// request (js/file-access-to-http), and while a code sits in the PATH — so it
// cannot move the request to another host — nothing in the code SAID so.
//
// Now it does. The extractor talks to exactly two hosts, and a value that tried
// to reach anywhere else fails loudly instead of being silently fetched.
export const ALLOWED_HOSTS = new Set(['www.kth.se', 'api.kth.se']);

// Course and programme codes are interpolated into those URLs, and they come
// from files in this repo: `--prereqs`, `--exams` and `--align` all read a
// curated data file and then fetch each code they find. That is the flow CodeQL
// reports (js/file-access-to-http), and it is a fair description — a value read
// off disk decides what gets requested.
//
// Validating the shape is the honest answer to it. A KTH course code is two to
// four letters, three or four digits and an optional trailing character; a
// programme code is four to six letters. Anything else is a malformed data file,
// and failing here names the bad value instead of quietly fetching a nonsense
// URL and reporting "no page" three retries later.
// Distinct from COURSE_CODE_RE further down, which is a GLOBAL scanning regex
// for finding codes inside free text. These are anchored whole-string checks.
export const URL_COURSE_CODE_RE = /^[A-ZÅÄÖ]{2,4}\d{3,4}[A-Z0-9]?$/;
export const URL_PROGRAMME_CODE_RE = /^[A-ZÅÄÖ]{4,6}$/;

export function checkedCode(value, pattern, what) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`refusing to build a URL from an invalid ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}
export const courseCode = (c) => checkedCode(c, URL_COURSE_CODE_RE, 'course code');
export const programmeCode = (p) => checkedCode(p, URL_PROGRAMME_CODE_RE, 'programme code');

export function assertKthHost(url) {
  let host;
  try {
    ({ host } = new URL(url));
  } catch {
    throw new Error(`refusing to fetch a malformed URL: ${String(url).slice(0, 120)}`);
  }
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(
      `refusing to fetch ${host}: this extractor only talks to ${[...ALLOWED_HOSTS].join(' and ')}. ` +
      `A course or programme code in the data files may be malformed.`);
  }
}

export async function fetchWithRetry(url, init, { allow404 = false } = {}) {
  assertKthHost(url);
  let last = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      last = new Error(`network error for ${url}: ${e.message}`);
      if (attempt < RETRY_ATTEMPTS) { await sleep(RETRY_BASE_MS * 2 ** (attempt - 1)); continue; }
      throw last;
    }
    if (res.status === 404 && allow404) return null;
    if (res.ok) return res;
    last = new Error(`HTTP ${res.status} for ${url}`);
    if (!isTransient(res.status) || attempt === RETRY_ATTEMPTS) throw last;
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
  }
  throw last;
}

export async function getText(url) {
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': UA } });
  return res.text();
}

export async function getJson(url, { allow404 = false } = {}) {
  const res = await fetchWithRetry(url,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } }, { allow404 });
  return res ? res.json() : null;
}

// ---------------------------------------------------------------------------
// Study-plan SSR state
// ---------------------------------------------------------------------------

// The blob is one contiguous run of percent-encoded characters. Rather than
// guess where it starts, find a marker we know is inside it and expand outwards
// to the run boundaries. `decodeURIComponent` then yields the JSON.
export const PCT_SAFE = /[%0-9A-Za-z._~\-*!'()]/;
export const STATE_MARKER = '%22programmeCode%22';

export function decodeStateBlob(html, what) {
  const marker = html.indexOf(STATE_MARKER);
  if (marker < 0) throw new Error(`no SSR state blob found in ${what} (page structure changed?)`);

  let start = marker;
  while (start > 0 && PCT_SAFE.test(html[start - 1])) start--;
  let end = marker;
  while (end < html.length && PCT_SAFE.test(html[end])) end++;

  const decoded = decodeURIComponent(html.slice(start, end));
  const brace = decoded.indexOf('{');
  if (brace < 0) throw new Error(`no JSON object inside state blob for ${what}`);
  return JSON.parse(decoded.slice(brace));
}

export async function fetchStudyPlanState(prog, term, year, { english = false } = {}) {
  const url = `https://www.kth.se/student/kurser/program/${programmeCode(prog)}/${term}/arskurs${year}` +
    (english ? '?l=en' : '');
  return decodeStateBlob(await getText(url), `${prog}/${term}/arskurs${year}`);
}
