# Public blueprint survey (2026-10-10)

**18 of 221 public Make blueprints (8%) can run in bpr today, all of them with fixtures.** 182 use something without recorded Make behavior, and 21 are not valid exports.

| Verdict | Files | Meaning |
|---|---:|---|
| Eligible | 18 | every module, expression, filter and setting has recorded Make behavior; all 18 need at least one fixture (an HTTP or third-party app call) |
| Not yet supported | 182 | valid Make, but uses something bpr refuses instead of guessing |
| Invalid | 21 | structure Make itself could not have exported (module `version: null`, `flow:Router`, a filter given as text): hand-written or AI-generated files |

Every file counted as eligible was also run through the scheduler with a stub that answers any fixture: **0 of the 18 were refused at run time**, so `inspect` and the runtime agree. This shows that nothing is refused, not that the output is right; that takes a real Make run (see `corpus/reference/`).

The eligible files are small: 2 to 6 modules each, and 8 of them are just "webhook → one app module". The larger scenarios are what the blockers below hold back.

## What blocks the rest

Files affected (one file can have several blockers):

| Files | Blocker |
|---:|---|
| 83 | a polling or app trigger (Google Sheets, RSS, Gmail, …) instead of a Custom webhook |
| 61 | mapping over an array with `[]` (`{{2.choices[].message.content}}`) |
| 52 | the `now` keyword |
| 32 | `json:ParseJSON` |
| 31 | error-handler routes |
| 30 | expressions bpr cannot read (single quotes, doubled `""` quotes, `\"` escapes) |
| 25 | `util:SetVariables` (several variables at once) |
| 24 | HTTP with "Evaluate all states as errors" switched off |
| 22 | modules other than Set variable running once per iterator bundle |
| 20 | `builtin:BasicAggregator` (array aggregator) |
| 18 | Webhook response with custom headers |
| 15 | `http:MakeRequest` (the newer HTTP module) |
| 15 | `util:FunctionSleep` |
| 12 | HTTP with custom request headers |
| 12 | `builtin:Ignore` |

Full per-file results: `results.json`. Rerun: `node tools/public-survey.ts`.

## How the files were picked

1. GitHub code search (REST API, 2026-10-10), three queries, JSON files only: `"gateway:CustomWebHook" "flow"`, `"builtin:BasicRouter" "flow"`, `"designer" "module" "flow" "mapper"`. Up to 300 hits each, 773 unique files.
2. Dropped before download: `nix-community/*` (IDE plugin manifests that match the words), anything with `n8n` in the repository name, and `integromat/make-skills` (Make's official examples, written in Make's flat `modules` format rather than as exported blueprints; bpr reports that format as `FORMAT_MODULES_SCHEMA`).
3. At most 3 files per repository downloaded (437). Kept files whose top-level `flow` (or `blueprint.flow`, or `response.blueprint.flow`) is a list of `app:module` entries: 312, after dropping 76 non-JSON files, 30 other JSON files, 17 exact duplicates and 2 in the `modules` format.
4. **One file per repository** (the first by path), so no single repository dominates: 221 files.

`sources.tsv` pins each file by git blob sha. The files are not included here: most of these repositories have no license. `tools/public-survey.ts` downloads them into `cache/` (gitignored).

## Changes made because of this survey

- Expressions bpr cannot parse, and references to modules that are missing or not upstream, were reported as **invalid**. Make accepts a scenario with such an expression and only fails when it runs, so they are now **not yet supported**, with the reason.
- `{{var.organization.X}}` and other `word.path` forms get a specific message instead of a syntax error.
- Exports wrapped as `{"blueprint": …}` or `{"response": {"blueprint": …}}` are unwrapped.
- `inspect` now applies the same setting-based refusals as the runtime (trigger type, HTTP options, response headers, empty filter groups, fallback and empty routes, `[]` mapping, non-object mappers). Before this, 14 files called eligible would have been refused when run, plus 14 more that start with a polling trigger.
