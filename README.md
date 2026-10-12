<div align="center">

<img src="docs/header.svg" alt="blueprint-runtime: run and test Make scenario blueprints offline. 71 of 79 real Make runs reproduced exactly, 0 differ." width="100%">

# blueprint-runtime — test Make.com scenarios offline

**An offline test runner for Make.com (formerly Integromat) scenario blueprints. Replay real Make runs on your own machine, in CI, and see the first value that changed: no Make account, no credits, no network. Every behavior it claims was recorded in a real Make run; anything else is refused, never guessed.**

[![npm](https://img.shields.io/npm/v/blueprint-runtime?style=for-the-badge&logo=npm&color=2a78d6)](https://www.npmjs.com/package/blueprint-runtime)
[![License](https://img.shields.io/badge/license-MIT-2a78d6?style=for-the-badge)](LICENSE)
[![Node](https://img.shields.io/badge/node-24%2B-2a78d6?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Make runs](https://img.shields.io/badge/real%20Make%20runs-71%2F79%20match%2C%200%20differ-1baf7a?style=for-the-badge)](corpus/NOTES.md)
[![Tests](https://img.shields.io/badge/tests-472%20passing-1baf7a?style=for-the-badge)](test/)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-eb6834?style=for-the-badge)](package.json)

[Demo](#demo) · [Results](#results) · [Quick start](#quick-start) · [CI](#run-it-in-ci-github-actions) · [How it works](#how-it-works) · [Supported](#what-runs-today) · [Fixtures](#fixtures-http-and-third-party-modules) · [FAQ](#faq) · [Limitations](#limitations)

</div>

---

## What this is

You build a scenario in Make, it works, and then someone edits a mapping. The only way to know what broke is to run it again in Make, with real data and real credits.

`bpr` runs the blueprint locally instead. It replays inputs that went through the real scenario and compares every module's input and output bundles, every filter decision, the outcome and the webhook response with what Make actually produced, then points at the first difference:

```
$ bpr test examples/broken-mapping
FAIL  A-002-plain   module 2 input bundle 1 at /value: Make had "ADA LOVELACE", the local run "Ada Lovelace"
```

Someone changed `upper(1.name)` to `capitalize(1.name)`. See [examples/broken-mapping](examples/broken-mapping/).

**The rule.** Every behavior this runtime supports was observed in a real Make run, and the recordings are in [`corpus/`](corpus/NOTES.md). If a blueprint uses something that has not been observed (a module, an operator, a function, a setting), `bpr` says what and refuses. That is why some of Make's quirks are reproduced exactly: a field of a plain-text iterator bundle reads as the text itself, and arrays written as text use a comma plus a NO-BREAK SPACE. It is also why the one quirk that could not be explained is refused instead of copied: for the bundle `0`, Make returned the previous bundle's value.

## Demo

<img src="docs/demo.gif" alt="Terminal demo, real output. 1: bpr test examples/broken-mapping reports FAIL on three recorded runs at module 2 input /value (Make had TEST, the local run Test) and PASS on the empty-name case, exit 1. 2: bpr test examples/http-fixture/cases: PASS when the HTTP fixture matches, FIXT when the fixture expects a different request body, when a fixture is never used, and when no fixture exists, exit 5." width="100%">

Generated from real command output by [`docs/make_demo.py`](docs/make_demo.py).

## Results

![71 of 79 real Make runs reproduced exactly, 0 differ. A straight line 9/9, B router and filters 16/16, C iterator and aggregator 17/17, C2 iterator probes 13/14, E HTTP from fixtures 5/5, T multi-bundle trigger 8/8, N now and [] 3/3, D formula probes 0/7 refused.](docs/charts/1_conformance.png)

79 runs were recorded in a free Make account across eight scenario families. 71 are reproduced exactly and **none differ**. The 8 that are refused, not failed:

- **D (7):** the formula-probe blueprint contains `replace(s; /o/g; "0")`. Make ignored that regex in a real run for a reason nobody has recorded, so `bpr` refuses the file. The engine still matches 530 of 535 recorded formula results from these runs, plus 66 of 67 from the D2 probe set.
- **C2 (1):** the bundle `0` read the previous bundle's value in Make. That is refused rather than modeled.

On top of the runs, 225 single formulas were recorded through probe sets (D2, D3, F1) and are replayed in the tests.

![38 of 221 public blueprints pass inspect: 38 eligible, 175 not yet supported, 8 invalid exports. Most common blockers: error-handler routes 34, json:ParseJSON 33, util:SetVariables 26, other modules per iterator bundle 26, HTTP states-as-errors off 25, other first module 23, array aggregator 21, response headers 19.](docs/charts/2_survey.png)

**How much of the real world runs today: 37 of 221 public Make blueprints on GitHub (17%), all with fixtures** (38 pass `inspect`; one is refused at run time for `md5()` of a date). It was 18 at v0.1.0: polling and app triggers (v0.2) and `[]` plus `now` (v0.3) were the biggest blockers. The chart on the right is the roadmap. Method, full table and per-file results: [`corpus/survey/`](corpus/survey/README.md).

## Quick start

Requires Node 24 or newer.

```
npm install -g blueprint-runtime                   # puts `bpr` on your PATH
bpr inspect your-scenario.blueprint.json           # can it run offline? (or: npx blueprint-runtime inspect …)
```

To replay the 79 recorded Make runs and the examples, clone the repository (it runs the TypeScript source directly):

```
git clone https://github.com/intikhab49/blueprint-runtime
cd blueprint-runtime
npm ci
npm run build && npm link        # puts `bpr` on your PATH (or use `node src/cli.ts` everywhere below)

bpr test corpus/reference --allow-unsupported      # replay all 79 recorded Make runs
bpr test examples/broken-mapping                   # a broken mapping, caught
bpr test examples/filter-cutoff                    # a filter changed from > to >=, caught at the cutoff
bpr inspect corpus/blueprints/B.blueprint.json     # what a blueprint uses, and whether it can run
```

No Make account is needed for any of this. The recorded runs are in the repository.

## Run it in CI (GitHub Actions)

Keep your exported blueprints and a few cases (snapshots or recorded Make runs) in a repository, and every change to a scenario gets checked before anyone imports it into Make:

```yaml
# .github/workflows/make-scenarios.yml
name: make-scenarios
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npx --yes github:intikhab49/blueprint-runtime test cases/
```

The exit code is the verdict: `0` every case matches, `1` a mapping changed what Make would produce, `3` the blueprint uses something without recorded Make behavior, `5` a fixture is missing or wrong. `bpr inspect` works the same way as a blueprint linter: exit `0` eligible, `2` invalid file, `3` unsupported.

## How it works

```mermaid
flowchart LR
    BP["blueprint.json<br/>exported from Make"] --> INS["inspect<br/>strict importer + plan"]
    INS --> RUN["scheduler<br/>routers · filters · iterators<br/>typed expression engine"]
    IN["input.json<br/>webhook payload"] --> RUN
    FX["fixtures.json<br/>HTTP + app modules"] --> RUN
    RUN --> TR["local trace"]
    REF["reference.json<br/>Make's recorded run"] --> CMP["compare<br/>first divergence"]
    TR --> CMP
    CMP --> OUT["PASS / FAIL<br/>module · bundle · JSON path"]

    style RUN fill:#2a78d6,color:#ffffff,stroke:#2a78d6
    style OUT fill:#1baf7a,color:#ffffff,stroke:#1baf7a
    style BP fill:#f0efec,stroke:#c3c2b7
    style INS fill:#f0efec,stroke:#c3c2b7
    style IN fill:#f0efec,stroke:#c3c2b7
    style FX fill:#f0efec,stroke:#c3c2b7
    style TR fill:#f0efec,stroke:#c3c2b7
    style REF fill:#f0efec,stroke:#c3c2b7
    style CMP fill:#f0efec,stroke:#c3c2b7
```

- **Importer.** It is strict on purpose: duplicate JSON keys (which `JSON.parse` silently drops), oversized or too-deep files, duplicate module ids, broken routes and bad fallback indexes are reported with line and column. It also computes a semantic hash: moving modules on the canvas keeps it, while changing a mapping, filter, route or setting changes it.
- **Expression engine.** It has its own tokenizer, parser and typed evaluator for Make's formula language, and never uses `eval` (a test scans the source to prove it). `missing` and `null` stay apart, dates are real instants in the scenario's timezone, and `+ - *` use exact decimal arithmetic the way Make does. It covers 58 functions, each replayed against Make's own output.
- **Scheduler.** Routes run in order and every passing route runs, with the fallback only when none did. Filters short-circuit like Make. Iterators process bundles depth-first and the Text aggregator collects them, with operations counted the way Make counts them.
- **Comparison.** It goes module by module: input bundles, output bundles, filter decisions with their per-condition report, the outcome (success or Make's exact error) and the webhook response. Key order is ignored; `missing` vs `null` and numbers vs text are not.

## `bpr test`

```
bpr test <case.json | folder>... [--json] [--allow-unsupported]
```

A case names a blueprint, an input, optional fixtures and the run Make actually produced. The input is the webhook payload, or, for a third-party app trigger such as Google Sheets "Watch rows", the list of bundles the trigger emitted (the connector itself is not verified; how a run processes several bundles was recorded with Make's Basic trigger, corpus T):

```json
{ "schemaVersion": 1, "name": "A-002-plain", "blueprint": "../../blueprints/A.blueprint.json",
  "input": "./input.json", "environment": { "timezone": "Asia/Karachi" }, "expected": "./reference.json" }
```

If the blueprint uses `now`, give the case a clock: `"environment": { "now": "2026-10-10T12:00:00.000Z" }`. Every module then reads that instant. In Make, `now` is the time each module starts, so it moves on during a run; a recorded reference can use `"now": "recorded"` to replay Make's own start times.

**Snapshots.** You don't need a recorded Make run to start: `bpr run blueprint.json --input input.json > expected.json` saves what the scenario produces today, and a case with `"expected": "./expected.json"` turns that into a regression test. Differences are then reported against "the snapshot", not against Make, because a snapshot proves consistency, not Make compatibility.

**Test the edges, not just the usual input.** A filter that drops every bundle is not an error in Make, so the run still looks successful; a case catches it only if its input sits where the change matters. For every numeric filter, keep one case just below the cutoff, one exactly at it and one just above it. An edit from `>` to `>=` changes only the middle one, so a suite of typical inputs passes right through it. [examples/filter-cutoff](examples/filter-cutoff/) shows this with four recorded Make runs: only the one at exactly 100 fails.

Exit codes: `0` all matched · `1` a case differs · `2` invalid case · `3` something without recorded Make behavior (`--allow-unsupported` lets those pass) · `5` a fixture is missing, wrong or unused · `6` local limit.

`bpr run <blueprint.json> --input <payload.json> [--fixtures <fixtures.json>] [--timezone <IANA>]` prints the local trace.

## `bpr inspect`

```
bpr inspect <blueprint.json>... [--json]
```

It lists every module, where it sits (main flow, route, fallback, error handler), every `{{…}}` expression with its references and functions, the fixtures the blueprint needs, and everything without recorded Make behavior, each with its reason. A file it calls eligible also runs without a refusal: the survey checked all 18 against the scheduler. Exit codes: `0` eligible · `2` invalid file · `3` uses something unsupported.

## What runs today

| | Supported (recorded in Make) | Not yet (refused with the reason) |
|---|---|---|
| **Triggers** | Custom webhook; Basic trigger; any third-party app trigger (Google Sheets, RSS, Typeform, …) with its bundles as the case input; several bundles per run, each through the whole flow | mail hooks, scenarios that start with an action (HTTP, Set variable), an aggregator on a trigger that emitted nothing |
| **Flow** | routers (every passing route, fallback route), filters with 31 operators and Make's short-circuiting, iterators with or without a Text aggregator (`\n`, `\t` or custom separator) | error-handler routes, array aggregator, repeaters, routers or responses running once per iterator bundle, multi-cycle runs |
| **Modules** | Set variable, Webhook response, Sleep, HTTP "Make a request" v3 (from fixtures: 200, 201, 404 recorded), any third-party app module from a fixture | `json:ParseJSON`, `util:SetVariables`, Ignore, the newer `http:MakeRequest`, code modules, data stores |
| **Expressions** | 58 functions, operators with Make's precedence and decimal arithmetic, 1-based indexes, `[]` (which reads the **first** element in Make, not all of them), `now` (from a test clock, or Make's recorded start time per module), Make's text conversion of arrays and objects | `now` in filters and aggregators, other keywords (`timestamp`, `uuid`, …), `var.*` custom variables, regex literals, single-quoted text |
| **HTTP** | request built from the mapping and checked against the fixture, response shaped exactly as Make does | other statuses, custom request headers, auth, query-string fields, "Evaluate all states as errors" off |

Full detail and evidence for every row: [`corpus/NOTES.md`](corpus/NOTES.md).

## Fixtures (HTTP and third-party modules)

A case can add `"fixtures": "./fixtures.json"`. There are two modes:

| Mode | For | Checked | Proves |
|---|---|---|---|
| `http` | `http:ActionSendData` v3 | the request the module builds (method, URL, content type, body) must equal the fixture's | request construction and everything downstream; the response becomes the output bundle exactly as Make shapes it (`statusCode`, `headers`, `cookieHeaders`, `data`, `fileSize`) |
| `module` | third-party app modules (e.g. `google-sheets:addRow`) | the mapped input bundle must equal the fixture's | downstream logic only; the connector itself is not verified |

```json
{ "schemaVersion": 1, "fixtures": [
  { "module": 2, "occurrence": 1, "mode": "http",
    "request":  { "method": "POST", "url": "https://api.example.test/x", "contentType": "application/json", "body": "{\"q\":\"a\"}" },
    "response": { "status": 200, "headers": [["content-type", "application/json"]], "body": "{\"answer\":42}" } } ] }
```

`occurrence` is the module's invocation number, because an iterator makes a module run several times. Fixtures fail closed: no fixture, a different request or input, a fixture of the wrong mode, two fixtures for one invocation, or a fixture never used all stop the case with exit `5`. There is no network fallback. Modules that run inside Make (`json`, `regexp`, `util`, …) can never be replaced by a fixture. See [examples/http-fixture](examples/http-fixture/).

## FAQ

**How do I test a Make.com scenario without running it in Make?**
Export the scenario's blueprint (scenario menu → Export blueprint) and save a sample input. `bpr run blueprint.json --input input.json > expected.json` saves a snapshot of everything the scenario produces; a case pointing at it fails the moment an edit changes any module's output (see [`bpr test`](#bpr-test)). For proof against Make itself, the expected run can be one recorded in Make instead: that is how the 79 cases in `corpus/reference/` were made, with the tools in [`tools/`](tools/). Those need a Make account and API token, and a one-command recorder is not built yet.

**Does it work with Integromat blueprints?**
Integromat is Make's former name, and the blueprint format is the same. Exports wrapped as `{"blueprint": …}` or Make API responses are unwrapped automatically.

**Can it validate or lint a blueprint before I import it?**
Yes: `bpr inspect blueprint.json` checks the structure strictly (duplicate keys, broken routes, references to modules that do not run first), lists every expression, and names everything it cannot vouch for. Exit code `0` means it can run offline.

**Does it call Make, Google Sheets, OpenAI or any other API?**
No. HTTP and app modules run from fixtures you write, a missing fixture fails the test, and nothing ever goes over the network. No Make account or API token is needed.

**What does `[]` mean in a Make mapping like `{{1.choices[].message.content}}`?**
It reads the first element, not all of them; this was recorded in Make, and bpr does the same. Make's `map()` function reads every element.

**Is it an official Make tool?**
No. It is an independent open source project that works with Make blueprints; every behavior comes from runs recorded in a real Make account (see [`corpus/`](corpus/NOTES.md)).

## How the evidence was collected

Everything in [`corpus/`](corpus/NOTES.md) comes from a free Make account. Scenarios were imported over the API, run with chosen payloads, and every module's input and output bundles were pulled from Make's own run log. HTTP probes called another scenario of the same account, so nothing left Make. The capture tools are in [`tools/`](tools/); they need your own Make API token (`.make-token`) and webhook URLs (`.make-hooks.json`), and both files are gitignored. Each recorded run became a test case in [`corpus/reference/`](corpus/reference/).

## Limitations

- **It covers a narrow slice of Make.** That slice is reproduced exactly, but most real blueprints use something outside it (see the survey). Every refusal names its reason, and the blockers chart is the order things should be added in.
- **A fixture proves your scenario's handling of a response, not the service.** A third-party connector is never verified.
- **Recorded on one account, one region (eu1), one timezone (UTC+5)**, during October 2026. Make can change its behavior; rerunning the capture tools would show it.
- **There are inferred details**, each marked in the code and NOTES. For example, `cookieHeaders` is `[]` for a response without cookies, because every recorded response had one.

## Develop

```
npm ci
npm run typecheck
npm test                         # 472 tests, including every recorded Make run
npm run build
python docs/make_charts.py && python docs/make_header.py && python docs/make_demo.py   # README images
```

Works with Make blueprints. Not affiliated with or endorsed by Make or Celonis. MIT licensed; the example blueprints in `corpus/public/make-skills/` are Make's own, under their MIT license.
