#!/usr/bin/env node
// FourA public benchmark harness. https://foura.ai/benchmarks
//
// Sends every page in corpus.json through each FourA endpoint, one request at a time,
// and records what came back. Node 18 or newer, no dependencies.
//
//   FOURA_API_KEY=pk_live_... node benchmark.mjs --corpus corpus.json --out results/
//   node benchmark.mjs --discover            one Single and one Browser fetch per page, no verdicts
//   node benchmark.mjs --discover --dump DIR also save each body, to choose a page's marker
//
// Options:
//   --corpus FILE     page list (default: corpus.json next to this file)
//   --out DIR         where records, the CSV and the summary go (default: ./results)
//   --sweeps N        passes over the whole list (default 3)
//   --engines LIST    comma list of single,proxy,browser,auto (default: all four), and
//                     premium: Proxy Finder with exitClass "premium", for a plan that has it
//   --only LIST       comma list of page ids
//   --gap-ms N        pause between two requests (default 3000)
//   --base URL        API base (default https://eu.api.foura.ai)
//   --from-records F  rebuild the CSV and the summary from a records file, no requests
//
// How a request is judged. Only the response decides; nothing is taken on trust.
//   content    the page's own marker is in the body: a piece of its HTML (an id, a class,
//              an attribute) that its check and refusal pages lack, so it holds in any
//              language the site answers in
//   challenge  the body is a bot-check page from a known vendor
//   blocked    the site answered with anything else: a refusal status, or a page
//              without the marker
//   error      no answer from the site at all: a timeout, or an error on our side
// Time is the wall clock of the whole API call as the client saw it. X-FourA-Credits
// reports the work a call used, on failures too; only a successful call is billed. So a
// record keeps both: `credits` (the header) and `billed` (whether the call succeeded, which
// is what the bill counts). Cost per page is billed credits divided by pages received.
// Auto makes calls of its own and is billed for those that succeeded, which a client cannot
// see; a record may carry `billedCredits` read from the billing records, and then that
// number is used. FourA's published runs carry it for every call.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const has = name => args.includes(`--${name}`);

const BASE = opt('base', 'https://eu.api.foura.ai').replace(/\/$/, '');
const KEY = process.env.FOURA_API_KEY;
const CORPUS = JSON.parse(readFileSync(resolve(opt('corpus', join(HERE, 'corpus.json'))), 'utf8'));
const OUT = resolve(opt('out', 'results'));
const SWEEPS = Number(opt('sweeps', 3));
const ENGINES = opt('engines', 'single,proxy,browser,auto').split(',');
const ONLY = opt('only') ? opt('only').split(',') : null;
const GAP = Number(opt('gap-ms', 3000));

if (!KEY && !has('from-records')) { console.error('Set FOURA_API_KEY.'); process.exit(2); }

// Bot-check pages, by the text their vendors put in them. A match means the site
// answered with a check instead of the page. Only the check page's own text counts:
// several vendors add a script to the real page too (Cloudflare's /cdn-cgi/ script,
// Imperva's _Incapsula_Resource, Kasada's KPSDK), so those never decide a verdict. A
// check page is small, and a body over CHECK_MAX_BYTES is never read as one.
const CHECK_MAX_BYTES = 300_000;
const CHALLENGES = [
  ['Radware', /<title>Radware Block Page<\/title>|validate\.perfdrive\.com/i],
  ['Cloudflare', /<title>Just a moment\.\.\.<\/title>|window\._cf_chl_opt|Checking your browser before accessing/i],
  ['DataDome', /captcha-delivery\.com/i],
  ['PerimeterX', /id="px-captcha"|Press &amp; Hold|Press & Hold/i],
  ['Akamai', /sec-if-cpt|\/_sec\/cp_challenge|bm-verify/i],
  ['AWS WAF', /awsWafCookieDomainList/],
  ['Imperva', /Pardon Our Interruption/i],
  ['Google', /\/sorry\/index|unusual traffic from your computer network/i],
  ['Amazon', /validateCaptcha|Enter the characters you see below|Type the characters you see in this image/i],
  ['Reddit', /<title>Reddit - Prove your humanity<\/title>|<title>Reddit - Please wait for verification<\/title>/],
];
// Who fronts a site, by the response headers its edge adds. Used to label the corpus.
const EDGES = [
  ['Cloudflare', h => /cloudflare/i.test(h.server || '') || 'cf-ray' in h],
  ['DataDome', h => Object.keys(h).some(k => k.startsWith('x-datadome'))],
  ['Akamai', h => 'akamai-grn' in h || /akamai/i.test(h.server || '') || 'x-akamai-transformed' in h],
  ['Imperva', h => 'x-iinfo' in h || /incap_ses|visid_incap/i.test(String(h['set-cookie'] || ''))],
  ['PerimeterX', h => /_px[0-9a-z]*=/i.test(String(h['set-cookie'] || ''))],
  ['CloudFront', h => 'x-amz-cf-id' in h],
  ['Fastly', h => /fastly/i.test(String(h['x-served-by'] || '') + String(h.via || ''))],
];
const flatHeaders = hs => {
  const out = {};
  for (const h of Array.isArray(hs) ? hs : [hs || {}]) for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = v;
  return out;
};

// Refusal pages that are not a check: nothing to solve, the answer is no.
const REFUSALS = [
  ['Cloudflare block', /Sorry, you have been blocked|Error 1020|Attention Required! \| Cloudflare/i],
  ['Access denied', /<title>Access Denied<\/title>|Request unsuccessful\. Incapsula incident|The requested URL was rejected/i],
  ['Reddit', /whoa there, pardner|blocked by network security/i],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const bodyOf = v => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

function requestFor(engine, page) {
  const marker = page.marker ? { validate: { data: { accept: [page.marker] } } } : {};
  switch (engine) {
    case 'single':
      return { path: '/api/single/', timeout: 30_000, body: { method: 'GET', url: page.url, unblocker: true, followRedirects: 5, timeout_ms: 30_000 } };
    case 'proxy':
      return { path: '/api/proxy/', timeout: 60_000, body: { maxTries: 10, timeout_ms: 60_000, request: { method: 'GET', url: page.url, unblocker: true, followRedirects: 5, ...marker } } };
    case 'premium':
      return { path: '/api/proxy/', timeout: 60_000, body: { exitClass: 'premium', maxTries: 10, timeout_ms: 60_000, request: { method: 'GET', url: page.url, unblocker: true, followRedirects: 5, ...marker } } };
    case 'browser':
      return { path: '/api/browser/', timeout: 60_000, body: { url: page.url, timeout_ms: 60_000, ...(page.marker ? { checkText: page.marker } : {}) } };
    case 'auto':
      return { path: '/api/auto/', timeout: 120_000, body: { url: page.url, timeout_ms: 120_000, ...marker } };
    default:
      throw new Error(`unknown engine ${engine}`);
  }
}

async function call(engine, page) {
  const { path, timeout, body } = requestFor(engine, page);
  const started = Date.now();
  let res; let json = null;
  try {
    res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout + 15_000),
    });
    json = await res.json().catch(() => null);
  } catch (e) {
    return { ms: Date.now() - started, apiStatus: 0, error: String(e.name === 'TimeoutError' ? 'client timeout' : e.message) };
  }
  const ms = Date.now() - started;
  // Proxy wraps the fetch it made; Auto reports its rung in meta.
  const inner = json && typeof json.data === 'object' && json.data && ('status' in json.data) ? json.data : json;
  return {
    ms,
    apiStatus: res.status,
    credits: Number(res.headers.get('x-foura-credits') ?? 0) || 0,
    limit: res.headers.get('x-foura-limit') || null,
    requestId: res.headers.get('x-foura-request-id') || null,
    exitClass: json?.exitClass ?? res.headers.get('x-foura-exit-class') ?? null,
    targetStatus: inner?.status ?? null,
    text: bodyOf(inner?.data ?? inner?.body),
    rung: json?.meta?.rung ?? null,
    error: json?.error ? String(json.error) : null,
    attemptReport: json?.attemptReport ?? null,
    headers: inner?.headers ?? null,
  };
}

function judge(page, r) {
  const text = r.text || '';
  const found = page.marker ? text.includes(page.marker) : text.length > 1000;
  if (r.limit) return { verdict: 'error', reason: `plan limit ${r.limit}` };
  if (found && (r.targetStatus == null || (r.targetStatus >= 200 && r.targetStatus < 300))) return { verdict: 'content', reason: '' };
  if (text.length <= CHECK_MAX_BYTES) {
    for (const [name, re] of CHALLENGES) if (re.test(text)) return { verdict: 'challenge', reason: name };
    for (const [name, re] of REFUSALS) if (re.test(text)) return { verdict: 'blocked', reason: name };
  }
  const rep = r.attemptReport;
  if (rep) {
    if (rep.defense > 0) return { verdict: 'challenge', reason: (rep.vendors || []).join('+') || 'bot check' };
    if (rep.noResponse === rep.total) return { verdict: 'error', reason: 'no exit answered' };
    return { verdict: 'blocked', reason: rep.summary ? String(rep.summary).slice(0, 80) : 'refused' };
  }
  if (r.targetStatus != null) return { verdict: 'blocked', reason: `status ${r.targetStatus}${found ? '' : ', no marker'}` };
  return { verdict: 'error', reason: r.error || `api ${r.apiStatus}` };
}

const pages = CORPUS.pages.filter(p => !ONLY || ONLY.includes(p.id));

if (has('discover')) {
  const dump = opt('dump');
  if (dump) mkdirSync(resolve(dump), { recursive: true });
  for (const page of pages) {
    for (const engine of (opt('engines') ? ENGINES : ['single', 'browser'])) {
      const r = await call(engine, { ...page, marker: null });
      if (dump) writeFileSync(join(resolve(dump), `${page.id}.${engine}.html`), r.text || '');
      const title = (r.text.match(/<title[^>]*>([^<]{0,120})/i) || [])[1] || '';
      const small = r.text.length <= CHECK_MAX_BYTES;
      const check = small ? (CHALLENGES.find(([, re]) => re.test(r.text))?.[0] || REFUSALS.find(([, re]) => re.test(r.text))?.[0] || '') : '';
      const h = flatHeaders(r.headers);
      const edge = EDGES.filter(([, f]) => f(h)).map(([n]) => n).join('+');
      console.log(JSON.stringify({ id: page.id, engine, status: r.targetStatus, api: r.apiStatus, bytes: r.text.length, ms: r.ms, credits: r.credits, edge, title: title.trim(), check, error: r.error }));
      await sleep(GAP);
    }
  }
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
let day = new Date().toISOString().slice(0, 10);
const records = [];
if (has('from-records')) {
  const saved = JSON.parse(readFileSync(resolve(opt('from-records')), 'utf8'));
  day = saved.day;
  // Records written before `billed` existed: a success is HTTP 200 on Single (no validate
  // rule) and a received page on the others, whose marker rule is the success rule.
  records.push(...saved.records.map(r => ('billed' in r ? r : { ...r, billed: r.engine === 'single' ? r.targetStatus === 200 : r.verdict === 'content' })));
  writeOut();
  process.exit(0);
}
// One run at a time: the pid file says which process to stop.
writeFileSync(join(OUT, 'run.pid'), String(process.pid));
for (let sweep = 1; sweep <= SWEEPS; sweep++) {
  for (const page of pages) {
    for (const engine of ENGINES) {
      const startedAt = new Date().toISOString();
      const r = await call(engine, page);
      const { verdict, reason } = judge(page, r);
      // Billed: the API reported a success. Without a validate rule that is HTTP 200 from
      // the site; with one (Proxy, Auto) or checkText (Browser), a miss comes back as an error.
      const billed = r.apiStatus === 200 && !r.error && r.targetStatus === 200;
      const rec = { sweep, page: page.id, url: page.url, engine, verdict, reason, targetStatus: r.targetStatus, ms: r.ms, credits: r.credits, billed, bytes: (r.text || '').length, rung: r.rung, exitClass: r.exitClass, requestId: r.requestId ?? null, startedAt };
      records.push(rec);
      console.log(`${sweep} ${page.id.padEnd(18)} ${engine.padEnd(8)} ${verdict.padEnd(9)} ${String(r.targetStatus ?? '-').padEnd(4)} ${(r.ms / 1000).toFixed(1).padStart(6)}s ${String(r.credits).padStart(4)}cr ${reason}`);
      if (r.limit) { console.error(`Stopped: the plan refused the call (${r.limit}).`); writeOut(); process.exit(1); }
      await sleep(GAP);
    }
  }
}
writeOut();

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function writeOut() {
  writeFileSync(join(OUT, `records-${day}.json`), JSON.stringify({ day, base: BASE, corpus: CORPUS.version, records }, null, 1));
  const cols = ['sweep', 'page', 'url', 'engine', 'verdict', 'reason', 'targetStatus', 'ms', 'credits', 'billed', 'billedCredits', 'bytes', 'rung', 'exitClass', 'startedAt'];
  const esc = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  writeFileSync(join(OUT, `results-${day}.csv`), [cols.join(','), ...records.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n');

  const engines = {};
  for (const engine of ENGINES) {
    const rs = records.filter(r => r.engine === engine);
    const ok = rs.filter(r => r.verdict === 'content');
    const billed = rs.reduce((a, r) => a + (r.billedCredits ?? (r.billed ? r.credits : 0)), 0);
    engines[engine] = {
      runs: rs.length,
      content: ok.length,
      challenge: rs.filter(r => r.verdict === 'challenge').length,
      blocked: rs.filter(r => r.verdict === 'blocked').length,
      error: rs.filter(r => r.verdict === 'error').length,
      medianMs: median(ok.map(r => r.ms)),
      creditsPerContent: ok.length ? Math.round((billed / ok.length) * 10) / 10 : null,
      // Calls a premium exit answered (the response says so only on a success).
      premiumServed: rs.filter(r => r.exitClass === 'premium').length,
    };
  }
  const byPage = pages.map(page => {
    const cells = {};
    for (const engine of ENGINES) {
      const rs = records.filter(r => r.page === page.id && r.engine === engine);
      const verdicts = rs.map(r => r.verdict);
      const counts = verdicts.reduce((a, v) => ({ ...a, [v]: (a[v] || 0) + 1 }), {});
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const ok = rs.filter(r => r.verdict === 'content');
      cells[engine] = { verdict: top, content: ok.length, runs: rs.length, stable: new Set(verdicts).size <= 1, medianMs: median(ok.map(r => r.ms)) };
    }
    return { id: page.id, site: page.site, protection: page.protection, cells };
  });
  const sweeps = Math.max(...records.map(r => r.sweep));
  const summary = { day, corpus: CORPUS.version, sweeps, pages: pages.length, engines, byPage };
  writeFileSync(join(OUT, `summary-${day}.json`), JSON.stringify(summary, null, 1));
}
