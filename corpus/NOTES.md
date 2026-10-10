# Reference corpus: captured from a real Make account (2026-10-10)

Account: eu1.make.com, Free plan (1,000 credits/month, resets 2026-11-01, max 2 active scenarios).
Org timezone is UTC+5. Every date result below depends on it.

## Scenarios

| Id | Make id | What it covers | Inputs | Captured |
|---|---|---|---|---|
| A | 7871965 | webhook → Set variable `upper(1.name)` → webhook response | 1 run | per-module bundles (typed JSON) in `reference/A-001/`, plus everything under `engine-logs/` (all scenarios) |
| B | 7872008 | webhook → router (type = a / amount > 100 / fallback) → Set variable per route | `cases/B.jsonl` (16) | engine trace + typed bundles for every run; routes in `run-summary.json` |
| C | 7872022 | webhook → iterator(1.items) → filter qty>0 → Set variable `name:qty*2` → text aggregator "\|" → response | `cases/C.jsonl` (16) + C-12b | response bodies in `responses/C.txt` |
| D | 7872039 | webhook → response whose body evaluates 107 expressions (`blueprints/D.probes.json`) | `cases/D/*.json` (7) | response bodies in `responses/D/` |

`blueprints/*.blueprint.json` are Make's own exports. `*.import.json` are the hand-written files that were imported.

## Blueprint format facts (from the exports)
- Router fallback is `"parameters": {"else": <0-based route index>}` on `builtin:BasicRouter`. The fallback route's first module carries `filter: {name, conditions: []}`.
- Filters live on the first module after the branch point: `filter.conditions` is OR-of-ANDs `[[{a, o, b}]]`. Operators seen: `text:equal`, `number:greater`.
- Module ids: `gateway:CustomWebHook`, `gateway:WebhookRespond`, `util:SetVariable2`, `builtin:BasicRouter`, `builtin:BasicFeeder` (iterator, `mapper.array`), `util:TextAggregator` (`parameters.feeder` = iterator id, `rowSeparator: "other"`, `otherRowSeparator`, output field `text`).
- Import accepts minimal modules (no `metadata.expect/interface`). Make fills those in on save.

## Expression semantics (IML), observed
- **String literals must be quoted.** A bare `-` or `YYYY-MM-DD` inside a call fails to parse: "Operator on end of an expression". Bare words parse but are NOT strings: `indexOf(s; o)` = -1 and `replace(s; o; 0)` is a no-op. `replace(s; /o/g; "0")` was also a no-op.
- `+` concatenates when either side is a string: `"42"+1 = "421"`, `"007"+1 = "0071"`. `*` coerces: `"42"*1 = 42`.
- `=` / `>` compare loosely: `"42" = 42` → true, `"42" > 9` → true, `"007" = 42` → false.
- JS number semantics: `42/0 = Infinity`, `0.1+0.2` printed as `0.3` (rounded on output?), `9007199254740993*2 = 18014398509481984`, `1e21*2` prints `2e+21`.
- `round(-2.5) = -2`, `round(2.5) = 3` (JS Math.round). `ceil(-2.5) = -2`, `floor(-2.5) = -3`. `-7 % 3 = -1`.
- On empty arrays: `sum([]) = 0`, `average([]) = NaN`, `max([]) = -Infinity`. `parseNumber("abc"; ",") = 0`.
- **Arrays are 1-based**: `arr[2]` is the 2nd element. An array in a text context renders as `"c, a, b"`, where the separator is a comma plus a **NO-BREAK SPACE (U+00A0)**, not a normal space, an object as compact JSON `{"k1":"v1","k2":2}`, null or missing as empty.
- `deduplicate(["x","y","x",1,"1"])` → `x,y,1` (1 and "1" count as the same value).
- `length()` counts UTF-16 code units (an emoji = 2). `upper("ß") = "SS"`.
- `if("")` → false, `if(0)` → false. `ifempty` falls back on "", null, and missing.
- Dates: `parseDate("2026-01-31"; "YYYY-MM-DD")` → `2026-01-30T19:00:00.000Z` (parsed in org tz). `formatDate` with no tz uses org tz. `addMonths(Jan 31, 1)` clamps to the end of the month.
- **Errors fail the whole module**, and the webhook caller gets HTTP 500 "Scenario failed to complete." Seen: `contains(123; "ell")` → "Function 'contains' finished with error! array.indexOf is not a function" (DataError). `first("notarray")` → "'notarray' is not a valid array." (DataError). `join`/`length` on that same string did not throw.

## Iterator / aggregator, observed (scenario C)
- items = object → treated as a 1-element array (C-14 `obj:18`).
- items = string → the iterator emits ONE bundle, the bare string `"hello"`. The filter then drops it, and the aggregator still emits `{"text":""}`. Empty or missing array → iterator emits 0 bundles, aggregator still emits `{"text":""}`.
- Iterator output bundles for objects get extra keys `__IMTINDEX__` (1-based) and `__IMTLENGTH__`.
- Missing `name` maps to empty (`:6`). Missing or null `qty` fails `qty > 0`.
- `"4"*2 = 8` inside the iterator. A filter with qty `"0"` (string) → filtered out.
- Webhook JSON parsing is IEEE double: `9007199254740993` arrives as `9007199254740992`, and `1e21` stays `1e+21`.
- Operation counting: the iterator = 1 op no matter how many bundles; each bundle through Set variable = 1 op; aggregator = 1; response = 1. Router = 0 ops. Filtered-out modules = 0 ops.

## Router, observed (scenario B; `run-summary.json` has every case)
- Routes are evaluated in order, and **every matching route runs** (B-03 ran r1 and r2). The fallback (`else`) runs only when no other route matched.
- `text:equal` is case-sensitive and does not trim: "A" ≠ "a", " a" ≠ "a". Number 1 vs "a" → false.
- `number:greater` coerces numeric strings: "150" > 100 true, "1e3" > 100 true, 100.5 > 100 true. "abc", null, missing, 100, and -500 → false.
- Engine trace: filter pass = event type 18, filter fail = type 14, with `report: [[bool per condition]]` (OR-of-AND shape). The fallback shows as type 18 with `report: []`.

## Engine trace format (`engine-logs/make-engine-logs-41.json`)
From `GET /streamer/scenario/{id}/log/v3/{runId}` (session-auth only, the API token is rejected). Event types seen: 24 start, 26 blueprint + environment + license snapshot, 12 module init, 1 / 2 / 25 execution phases + final totals, 5 module input (bundles, `eventCorrelationId`), 6 module output (or `error`), 7 / 8 commit, 9 / 10 rollback, 11 route entry, 13 finalize, 14 / 18 filter fail / pass, 21 debug message.
- On error (D-05): type 6 carries `error {name: "DataError", message, stack}` → rollback (9/10) runs in reverse module order → module 1 sends an "automatic failure response" to the webhook (type 21), and the caller sees HTTP 500.
- License snapshot (free plan): `retention: 7` days, `scenarios: 2`, `interval: 15`, `executionTime: 5` (min), `iolimit: 50`, `fslimit: 5242880`. Env timezone `Asia/Karachi`.

## Per-module bundle data (`engine-logs/make-module-bundles-41.json`)
From `POST /streamer/scenario/{id}/log/{runId}/module/{moduleId}` with body `{"cycle":1}` (session-auth). Each entry: `{input: bool, module, cycle, operation, data: [JSON string per bundle], error, ownerEvent: {type, eventCorrelationId}}`. All 41 runs × all modules (182 calls) pulled 2026-10-10.
`run-index.json` = run ids from the public API (`GET /api/v2/scenarios/{id}/logs`, token auth, max `pg[limit]=50`). `run-summary.json` = case → routes / bundle counts / filters / errors.

## Retention
Free-plan logs are kept **7 days** (license `retention: 7`), so these runs disappear from Make around 2026-10-17. Everything above is saved locally.

## Probe set D2 (2026-10-10, `tools/make-probe.ts`, answers in `responses/D2-semantics.json`)
67 expressions sent through scenario D over the API in 13 runs, using bisection so one failing expression never hides the rest.
- **Operators `+ - *` use exact decimal arithmetic**: `0.1+0.7=0.8`, `0.3-0.1=0.2`, `100.1-100=0.1`, `1.005*1000=1005`, `0.1*3=0.3`. Functions do not: `sum([0.1,0.2]) = 0.30000000000000004`. `/` fits both decimal and JS so far (`1/3 = 0.3333333333333333`).
- **Precedence**: standard, left-associative. `1+2*3=7`, `10-4-3=3`, `8/4/2=1`, `2*3%4=2`, `true|false&false=true`, `1+2=3` → true.
- **`if()` truthiness is JavaScript's**: `"false"`, `"0"`, `"abc"`, `-1`, `[]`, `{}` → true; null and missing → false. **`if()` is lazy**: `if(true; "picked"; first("notarray"))` = `picked`.
- **`=` is JavaScript `==`**: `null = missing` true, `0 = false` true, `42 = "42.0"` true, `true = "true"` false, `"a" = "A"` false, `missing = ""` false.
- **`+` with anything but two numbers concatenates as text**: `true+1 = "true1"`, `missing+1 = "1"`, `null+1 = "1"`, `[c,a,b]+1 = "c, a, b1"`. **`*` coerces like JS with missing → 0**: `"abc"*2 = NaN`, `missing*2 = 0`.
- `flatten` and `join` flatten every level: `length(flatten([[1,2],[3,[4]]])) = 4`, `join(…; "|") = "1|2|3|4"`.
- `sort` on numbers is numeric (`1,2,3,10`), and `"desc"` reverses it.
- Regex given as quoted text works: `"/o/g"` replaces all, `"/o/"` and `"/l+/"` replace the first match. `"/O/gi"` changed nothing.
- Missing and null in text functions act as empty: `upper(missing) = ""`, `length(missing) = 0`, `length(null) = 0`, `join(missing; ",") = ""`.
- `ifempty` only treats `""`, null and missing as empty. `[]`, `{}`, `0` and `false` come back unchanged.
- Arrays of collections as text: objects become JSON joined by `", "` (normal space). Nested arrays print each inner array flattened and joined with comma + NBSP, with the inner arrays separated by `", "`.
- **Backslash is not an escape**: `"a\"b"` made Make reject the whole scenario ("Scenario validation failed").
- Safety: Make accepts a scenario start even with an invalid expression, then fails the first run and switches the scenario off. Webhooks sent after that are queued (free-plan queue limit 50). The probe tool restarts before every run and aborts on the first queued webhook.

Engine conformance after D2: scenario D 530/535 and D2 66/67 match exactly, with 0 mismatches. The 6 refusals are the unquoted `/o/g` and `"/O/gi"`, which Make ignored for an unknown reason.

## Scenario A edge cases (2026-10-10, `tools/make-run.ts`, responses in `responses/A-cases.json`)
- **A mapped field that evaluates to empty text is stored as `null`** in the module's input bundle: `upper("")`, `upper(missing)` and `upper(null)` all gave `{"name": "upper_name", "value": null}` and output `{"upper_name": null}` (A-004, A-005, A-006).
- **A Webhook response with a null or empty body reaches the caller as `200 Accepted`**, the same text Make sends for a queued webhook. Check the hook queue before reading "Accepted" as "queued".
- `upper(123)` = `"123"` and `upper(["a","b"])` = `"A,B"`: the array becomes text with a plain comma (JavaScript `String(array)`), unlike arrays written into a template, which use comma + NO-BREAK SPACE.
- Webhook response: the mapped status `"200"` is stored as the number `200`; the module records one `null` output bundle.
- A module whose mapping fails is recorded with no input bundles, one `null` output bundle, and the run error `Failed to map '<field>': …` (D-05). A webhook caller then gets `500 Scenario failed to complete.`
- Routers produce no bundles of their own; only the modules on the routes do (B).

## Reference cases (`corpus/reference/<case>/`)
`tools/extract-reference.ts` turns the raw run data in `engine-logs/` (gitignored: it contains the account email and ids) into one folder per recorded run: `case.json` (spec section 10 contract), `input.json`, and `reference.json` (per-module input/output bundles in execution order, outcome, webhook response). 49 cases: A ×9, B ×16, C ×17, D ×7.

## Routers and filters (Day 6)
- Runs are recorded as ordered **steps**, from Make's run log: a filter decision (event 18 = passed, 14 = stopped, with `report` = one boolean per condition, OR-of-AND shaped) comes right before the module it guards; each module start (event 5) is one operation. An iterator's downstream module gets operations 1, 2, … (C-02). Reference files are `schemaVersion: 2` with `steps`.
- Router: routes run **in index order, each route fully before the next**, and **every route whose first module's filter passes runs** (B-03 ran routes 1 and 2). Make's own docs say the same (integromat/make-skills, flow-control.md: "Several arms can run for the same item").
- The fallback route (`parameters.else`) runs only when no other route passed. It is logged as a passed filter with an **empty report** `[]` (B-04). When another route passed, the fallback is not logged at all (B-01).
- The router module itself produces no bundles and no operation.
- A filter that stops a bundle ends that path silently: no module record, no error.

## Filter probe F1 (2026-10-10, `tools/make-filter-probe.ts`)
60 conditions, each on its own route of a router, so one run evaluates all of them. Run on the real scenario B with 2 payloads; every decision and report came from Make's run log. Files: `blueprints/F1.filter-probes.json`, `responses/F1-filters.runs.json`, `responses/F1-filters.events.json`. Make accepted all 60 operator ids, including the `:ci` variants.
- **Text operators compare text**: number 42 `text:equal` "42" is true; missing and null equal `""`. Case-sensitive unless `:ci` (`text:equal:ci`, `notequal:ci`, `contain:ci`, `notcontain:ci`, `startwith:ci`, `endwith:ci`, `pattern:ci`). `contain`, `startwith`, `endwith`, `pattern` (regex) and their `not` forms behave as expected. Missing `text:contain` "" is true.
- **Number operators**: `"150"` → 150, `"1e3"` → 1000, `"42.0"` = 42, `true` → 1, `false` → 0. **`""`, `null`, missing, `"abc"` and `"150abc"` are not numbers**, so every comparison with them is false. That is neither JS `Number()` (which reads `""` and null as 0) nor `parseFloat()` (which reads "150abc" as 150). `equal`, `notequal`, `greater`, `less`, `greaterorequal`, `lessorequal` observed.
- **`exist`** is false only for missing, null and `""`. `0`, `false`-like values and **an empty array `[]` exist**. `notexist` is the opposite.
- `boolean:equal` / `notequal`: the text `"true"`/`"false"` counts as the boolean.
- `array:contain` / `notcontain`: exact, case-sensitive match against text elements.
- `date:greater` / `date:less`: ISO timestamps compare as instants; an equal instant is not greater.
- **AND groups short-circuit**: the report stops at the first false condition (`[[false]]` for "false AND true"). OR groups are evaluated in order (`[[false], [true]]`). Stopping after a passing OR group is assumed, not yet observed.
- Engine: all 120 decisions (60 × 2 payloads) reproduced exactly, reports included (`test/conformance-filters.test.ts`).

## Iterator and Text aggregator (Day 7)
All 17 C runs reproduced exactly (`test/run.test.ts`). What the scheduler implements, and what it refuses because no run showed it:
- Each iterator bundle runs the modules between the iterator and its aggregator before the next bundle starts. With one module in between (C), this and "module by module" give the same log; depth-first is Make's documented order, not an observed one.
- The aggregator runs once after the last bundle, 1 operation, with one `{value}` input per bundle that reached it, output `{text}` = values joined with `otherRowSeparator`. No bundles → input `[]`, output `{"text": ""}` (C-03, C-04, C-05, C-13).
- (Corrected by C2 below: a field of a bare text bundle reads as the text itself, which is why `"hello"` failed `2.qty > 0` in C-13.)
- **Refused at Day 7, mostly resolved by the C2 probes below**: iterators with no aggregator, newline/tab separators, plain-value arrays, empty or non-text aggregated values and reads after the aggregator are now observed and supported. `bpr inspect` reports what is still refused (`ITERATOR_SCOPE_UNSUPPORTED`, `AGGREGATOR_SEPARATOR_UNSUPPORTED`).

## Iterator probes C2 (2026-10-10, `tools/make-variant-run.ts`, `cases/C2.variants.json`)
14 runs of four variants of scenario C (`blueprints/C2-*.import.json`), patched into Make 7872022 and restored afterwards. Bundles pulled from the run logs; 13 of 14 reproduced exactly (`corpus/reference/C2-*`). **This supersedes the "Refused" line of the Day 7 section above**: of that list, only "a filter on the aggregator", "anything other than Set variable per bundle" and the cases below are still refused.
- **Order is depth-first, observed**: iterator → Set variable 3 → Set variable 4 with no aggregator logged 3,4,3,4,3,4 (C2-noagg-01). With no aggregator the rest of the flow runs per bundle; with no Webhook response the caller gets `200 Accepted`.
- **Plain-value arrays**: each element is a **bare bundle** (`"x"`, `1`, `0`, `[1,2]`), no `__IMTINDEX__`. A single number, boolean or empty text as the source gives one bare bundle (`7`, `true`, `""`). The iterator records `""` as `""` in its input, not null.
- **Reading any field of a bare text/number/boolean bundle gives the value itself**: `2.value` = `"x"`, `2.__IMTINDEX__` = `"a"`. This also explains C-13 (`2.qty` on `"hello"` → `"hello" > 0` → false). A field of a bare array → missing (C2-nl-05); of empty text → missing (seen only as the sole bundle).
- **Quirk**: for `[1, 2.5, 0, -3]`, `2.value` on the bundle `0` gave **2.5, the previous bundle's value** (C2-nl-02). Refused for 0 and false, not modeled.
- **A `null` element fails the iterator**: `TypeError: Cannot convert undefined or null to object`. The iterator is logged with its input and one null output; the caller gets 500 (C2-nl-03). Arrays mixing collections and plain values without a null are still unobserved and refused.
- **Text aggregator**: `rowSeparator` `"\n"` and `"\t"` are the separator itself. Values are written as text: `1` → `"1"`, `true` → `"true"`, `{"k":1}` → JSON, `[1,"b"]` → `"1, b"` (comma + NO-BREAK SPACE). Empty, null and missing values are stored as `null` and become **empty rows** (`p\n\n\n\nq`).
- **After the aggregator, the iterator and the modules between read as missing**: `({{2.name}})({{3.line}})` → `()()` (C2-after-01, -02).
- Trap: an import file's `metadata.designer.messages` with severity `error` (here "Webhook: Value must not be empty") makes Make refuse to start the scenario (IM319, "Scenario contains errors") even though the PATCH succeeded. Strip them before PATCHing.

## HTTP probes E (2026-10-10, `tools/make-variant-run.ts`, `cases/E.variants.json`)
5 runs of three variants on scenario C's slot (`blueprints/E-*.import.json`): webhook → `http:ActionSendData` v3 → webhook response. The HTTP step called scenario A's own webhook, temporarily turned into a JSON echo (replies `{"echo":<name>,"n":2,"list":[1,"b"]}` with the status the payload asks for), so nothing left Make. Both scenarios were restored afterwards. All 5 reproduce exactly from fixtures (`corpus/reference/E-*`, each with `fixtures.json`).
- **Input bundle** = the mapped settings, with the usual rule: `""` stored as `null` (`ca`, `timeout`, `authUser`, `authPass`, and `bodyType` on the GET). Unmapped fields are absent (`contentType`/`data` on the GET).
- **Output bundle** = `{statusCode, headers, cookieHeaders, data, fileSize}`. `headers` is `[{name, value}]` with lowercase names in response order; `cookieHeaders` lists every `set-cookie` value; `fileSize` is the body length (33 for the 33-character body).
- `parseResponse: true` + `application/json` response → `data` is the parsed JSON (E-json-01, E-get-01). `parseResponse: false` → `data` is the body text (E-text-01).
- **201 succeeds** like 200. **404 with `handleErrors: true` fails the module**: `DataError` "Error: 404 Not Found", the module logged with its input and one null output, rollback, caller gets 500 (E-json-03). Other statuses are refused until recorded.
- Inferred, not observed: `cookieHeaders` is `[]` when there is no `set-cookie` header (every recorded response had one, from Cloudflare).
- Scrubbed in the tracked files, identically in references and fixtures: the echo webhook URL (→ `https://echo.example.test/hook`), the Cloudflare `__cf_bm` cookie value and the `x-make-scenario-execution-id` header. The 404 fixture's body is the echo's reply for that payload; Make kept no output for the failed module.
- Fixture rules (spec 7.1) are implementation properties, proven by `test/fixtures.test.ts`, not Make observations: match by module + invocation number + exact request/input; missing, mismatched, wrong-mode, duplicate or unused fixtures fail with exit 5; no network fallback.
