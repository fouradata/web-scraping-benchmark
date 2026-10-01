# Web scraping API benchmark on protected public sites

How often each FourA endpoint gets the real page from public sites behind Cloudflare, DataDome
and others, how long it takes and what it costs. The method, the page list, the script and every
request behind the published numbers are here. The current results are on
https://foura.ai/benchmarks.

We built the product we measured. That is why the list, the script and every request are public:
run the script on your own sites before you decide.

## What is here

| Path | What it is |
|---|---|
| `benchmark.mjs` | The Node.js script that ran every published run. Node 18 or newer, no dependencies. |
| `corpus.json` | The page list, each page with the marker that proves the real page arrived. |
| `corpus-2026-09-16.json` | The list the first run used (text markers; markup markers since 2026-09-17). |
| `runs/YYYY-MM-DD/results.csv` | One row per request: page, endpoint, verdict, status, time and credits. |
| `runs/YYYY-MM-DD/records.json` | The same requests as JSON, with the reason behind every verdict and the credits each call used and was billed. |
| `runs/YYYY-MM-DD/summary.json` | Per endpoint and per page: pages received, cost per page, time. What foura.ai/benchmarks shows. |

## How we measure

**The list.** 22 public pages. Most come from an independent 2026 benchmark of browser
automation tools ([anti-detect-browser-bench](https://github.com/ianlpaterson/anti-detect-browser-bench)),
without its bot-detection test pages; the other four are large public sites we added. No
customer's site is on it, and anyone can open every page.

**The requests.** Each endpoint as the documentation describes it. Single and Proxy Finder run
with the Unblocker. Every endpoint except Single is told which piece of the page's own HTML
proves it arrived: an id, a class or an attribute that holds in any language, so a rotation
keeps going until it sees it.

**The passes.** Every page goes through every endpoint three times, one request at a time and a
few seconds apart, from one office connection to the EU endpoint.

**The verdict.** Only the response decides; nothing is taken on trust. Each request lands in one
of four groups:

- `content` - the page's own marker is in the body (and the status is 2xx)
- `challenge` - the body is a bot-check page from a known vendor
- `blocked` - the site answered with anything else: a refusal status, or a page without the marker
- `error` - no answer from the site at all: a timeout, or an error on FourA's side

**Time and cost.** Time is the whole API call as the script saw it, from sending the request to
the last byte of the answer. Cost is what the call is billed. Failed calls are free, so a page
costs the credits of the call that brought it. Auto makes calls of its own and is billed for those
that succeeded; FourA's published records carry that figure (`billedCredits`) for every call.

**What this can't tell you.** It is one connection, one day and 22 pages. Sites change their
defences without notice, so a result holds for the day it was measured.

## Run it yourself

```bash
FOURA_API_KEY=your_key node benchmark.mjs --corpus corpus.json --out results/
```

Options: `--sweeps N` (passes over the list, default 3), `--engines single,proxy,browser,auto`
(and `premium`: Proxy Finder with `exitClass: "premium"`, for a plan that includes it),
`--only id1,id2`, `--gap-ms N` (pause between requests, default 3000), `--base URL`.
`--discover --dump DIR` fetches each page once and saves the body, to choose a page's marker.
`--from-records FILE` rebuilds the CSV and the summary from a records file without sending anything.

A marker is a case-sensitive substring of the raw HTML that the page's bot-check and refusal
pages do not contain. Since 2026-09-17 every marker is a piece of markup, so it holds whatever
language the site answers in. Verify a new marker against a dumped real page and against the
dumped refusal pages before a run.

An API key: https://foura.ai/dashboard/#api-keys (the free plan is enough for a small run).

## Licence

Code (`benchmark.mjs`): [MIT](LICENSE). Data (`corpus*.json`, `runs/`):
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) - free to reuse, commercially too,
as long as you credit FourA and link to https://foura.ai/benchmarks. See [DATA-LICENSE.md](DATA-LICENSE.md).

## Cite

FourA, "Web scraping API benchmark on protected public sites", run of 2026-10-01,
https://foura.ai/benchmarks.
