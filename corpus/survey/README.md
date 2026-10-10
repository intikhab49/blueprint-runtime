# Public blueprint survey (2026-10-10)

**37 of 221 public Make blueprints (17%) can run in bpr today, all of them with fixtures.** 38 pass `inspect`, 175 use something without recorded Make behavior, and 8 are not valid exports.

*Updated 2026-10-10 for v0.3 (`[]` and `now`). History: 18 at v0.1.0; 25 at v0.2 (polling and app triggers, which blocked 83 files); 36 at v0.3 (`[]` blocked 61 files, `now` 52).*

| Verdict | Files | Meaning |
|---|---:|---|
| Eligible | 38 | every module, expression, filter and setting has recorded Make behavior; all 38 need at least one fixture or trigger input (an HTTP or third-party app call) |
| Not yet supported | 175 | valid Make, but uses something bpr refuses instead of guessing |
| Invalid | 8 | structure Make itself could not have exported (modules without ids, invented module names like `flow:Router`, routes nested as plain arrays, a filter given as text): hand-written or AI-generated files |

Every file counted as eligible was also run through the scheduler with a stub that answers any fixture, one empty bundle for an app trigger, and a fixed clock: **35 of the 38 ran without a refusal**. Of the other 3, two read a field the empty stub bundle does not have (`substring()` in `2ChatCo/Tutorials`, `formatDate()` in `eleyrot/signals-newsletter`); real trigger data carries it. The third (`rawdela/og-studios-donation-automation`) is a real refusal: it takes `md5()` of a date, which has not been recorded, and `inspect` cannot see argument types. So **37** run. This shows that nothing is refused by a rule, not that the output is right; that takes a real Make run (see `corpus/reference/`).

The 18 files eligible at v0.1.0 were small: 2 to 6 modules each, and 8 of them were just "webhook → one app module". The larger scenarios are what the blockers below hold back.

## What blocks the rest

Files affected (one file can have several blockers):

| Files | Blocker |
|---:|---|
| 34 | error-handler routes |
| 33 | `json:ParseJSON` |
| 33 | expressions bpr cannot read (single quotes, doubled `""` quotes, `\"` escapes) |
| 26 | `util:SetVariables` (several variables at once) |
| 26 | modules other than Set variable running once per iterator or trigger bundle |
| 25 | HTTP with "Evaluate all states as errors" switched off |
| 23 | a first module that is neither a webhook nor an app trigger (mail hook, HTTP, Set variable, note) |
| 21 | `builtin:BasicAggregator` (array aggregator) |
| 21 | other keywords (`timestamp`, `uuid`, …) or `now` in a filter |
| 19 | Webhook response with custom headers |
| 18 | `http:MakeRequest` (the newer HTTP module) |
| 13 | `builtin:Ignore` |
| 12 | HTTP with custom request headers |
| 8 | an empty module slot left in the scenario (`placeholder:Placeholder`) |

Full per-file results: `results.json`. Rerun: `node tools/public-survey.ts`.

## How the files were picked

1. GitHub code search (REST API, 2026-10-10), three queries, JSON files only: `"gateway:CustomWebHook" "flow"`, `"builtin:BasicRouter" "flow"`, `"designer" "module" "flow" "mapper"`. Up to 300 hits each, 773 unique files.
2. Dropped before download: `nix-community/*` (IDE plugin manifests that match the words), anything with `n8n` in the repository name, and `integromat/make-skills` (Make's official examples, written in Make's flat `modules` format rather than as exported blueprints; bpr reports that format as `FORMAT_MODULES_SCHEMA`).
3. At most 3 files per repository downloaded (437). Kept files whose top-level `flow` (or `blueprint.flow`, or `response.blueprint.flow`) is a list of `app:module` entries: 312, after dropping 76 non-JSON files, 30 other JSON files, 17 exact duplicates and 2 in the `modules` format.
4. **One file per repository** (the first by path), so no single repository dominates: 221 files.

`sources.tsv` pins each file by git blob sha. The files are not included here: most of these repositories have no license. `tools/public-survey.ts` downloads them into `cache/` (gitignored).

## Correction (v0.3.1)

Up to v0.3.0 this page said 21 files were invalid, "structure Make itself could not have exported". 13 of them were real Make exports, and bpr's importer was wrong about four patterns Make does produce: the editor's empty module slot (`placeholder:Placeholder`, exported with `"id": null` and no version), Make's AI Agent module (`version: 0`), and a router with no routes attached (no `routes` key). The importer accepts them now; a placeholder or an empty router is reported as not yet supported, with the reason.

## Changes made because of this survey

- Expressions bpr cannot parse, and references to modules that are missing or not upstream, were reported as **invalid**. Make accepts a scenario with such an expression and only fails when it runs, so they are now **not yet supported**, with the reason.
- `{{var.organization.X}}` and other `word.path` forms get a specific message instead of a syntax error.
- Exports wrapped as `{"blueprint": …}` or `{"response": {"blueprint": …}}` are unwrapped.
- `inspect` now applies the same setting-based refusals as the runtime (trigger type, HTTP options, response headers, empty filter groups, fallback and empty routes, `[]` mapping, non-object mappers). Before this, 14 files called eligible would have been refused when run, plus 14 more that start with a polling trigger.
