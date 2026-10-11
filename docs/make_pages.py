"""Generate the site's text pages: make-behaviors/index.html, llms-full.txt and sitemap.xml.

  python docs/make_pages.py

The behaviors page answers common Make.com questions with what real Make runs showed. Every line
comes from corpus/NOTES.md, which links each one to its recording, so edit BEHAVIORS together with
NOTES.md. The FAQ structured data is built from the same list as the visible page, so they can't
disagree. llms-full.txt = llms.txt + these behaviors + the README, for AI assistants.
"""
import datetime as dt
import json
import pathlib
import re
from html import escape

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent
SITE = "https://intikhab49.github.io/blueprint-runtime/"
REPO = "https://github.com/intikhab49/blueprint-runtime"
NOTES = f"{REPO}/blob/main/corpus/NOTES.md"
AUTHOR = {"@type": "Person", "@id": "https://github.com/intikhab49", "name": "Intikhab Azam",
          "url": "https://github.com/intikhab49"}
TODAY = dt.date.today().isoformat()
PUBLISHED = "2026-10-12"

# (question, [answer sentences]). `code` spans become <code> on the page and plain text in the data.
BEHAVIORS = [
    ("What does `[]` do in a Make.com mapping?", [
        "`[]` reads the first element only. It does not map over the array: `{{1.people[].name}}` gave `Ann`, "
        "the first person's name, in a text field, as a function argument and in an iterator's array field.",
        "To read every element, use `map()`. It keeps items without the key as empty entries: "
        "`join(map(people; \"name\"); \"|\")` gave `Ann|Bob||`.",
        "`[]` on an empty array, a missing value or an object reads as missing. On text it returns the text itself.",
        "Array indexes start at 1: `arr[2]` is the second element.",
    ]),
    ("How does `if()` decide what is true in Make?", [
        "It uses JavaScript truthiness. The texts `\"false\"`, `\"0\"` and `\"abc\"`, the number `-1`, `[]` and "
        "`{}` are all true. Empty text, `0`, null and missing are false.",
        "`if()` is lazy: the branch it doesn't pick is never evaluated, so an error there doesn't fail the module.",
        "`ifempty()` falls back only on empty text, null and missing. `[]`, `{}`, `0` and `false` come back unchanged.",
    ]),
    ("How does `=` compare values in a Make expression?", [
        "Like JavaScript's loose `==`: `\"42\" = 42`, `42 = \"42.0\"`, `0 = false` and `null = missing` are all true.",
        "It is case-sensitive (`\"a\" = \"A\"` is false), `true = \"true\"` is false and `missing = \"\"` is false.",
        "Dates are compared as objects, so `now = now` is false.",
    ]),
    ("Why does `\"42\" + 1` give `\"421\"` in Make?", [
        "`+` adds only when both sides are numbers. Anything else is joined as text: `\"42\"+1` is `\"421\"`, "
        "`true+1` is `\"true1\"` and `missing+1` is `\"1\"`.",
        "`*` converts like JavaScript, with missing as 0: `\"42\"*1` is `42`, `\"abc\"*2` is `NaN` and "
        "`missing*2` is `0`.",
        "The operators `+`, `-` and `*` use exact decimal arithmetic (`0.1+0.7` is `0.8`, `1.005*1000` is `1005`), "
        "but functions don't: `sum()` of 0.1 and 0.2 gives `0.30000000000000004`.",
        "`round(2.5)` is `3` but `round(-2.5)` is `-2`, like JavaScript's `Math.round`. `42/0` is `Infinity`, "
        "not an error.",
    ]),
    ("How do arrays and empty values turn into text in Make?", [
        "An array mapped into a text field is joined with a comma and a NO-BREAK SPACE (U+00A0), not a normal "
        "space: `c, a, b`.",
        "Functions convert arrays differently: `upper()` of the array a, b gives `A,B`, with a plain comma.",
        "A mapped field that evaluates to empty text is stored as `null` in the module's bundle.",
        "`length()` counts UTF-16 code units, so an emoji counts as 2. `upper(\"ß\")` is `\"SS\"`.",
        "Text must be quoted. A bare word parses but isn't text: `indexOf(s; o)` returns `-1`. Backslash is not an "
        "escape character, and a `\\\"` inside a string made Make reject the whole scenario.",
    ]),
    ("How do Make filters compare text, numbers and empty values?", [
        "Text operators are case-sensitive unless you pick the case-insensitive variant, and they don't trim: "
        "`\" a\"` doesn't equal `\"a\"`.",
        "Number operators read `\"150\"` as 150 and `\"1e3\"` as 1000, but empty text, null, missing, `\"abc\"` and "
        "`\"150abc\"` are not numbers, so every comparison with them is false. That matches neither JavaScript's "
        "`Number()` nor `parseFloat()`.",
        "`Exists` is false only for missing, null and empty text. `0` and an empty array `[]` exist.",
        "Conditions joined by AND stop at the first false one.",
    ]),
    ("Does Make run every router route that matches?", [
        "Yes. Routes are checked in order, and every route whose filter passes runs, each one to the end before the "
        "next starts.",
        "The fallback route runs only when no other route passed.",
        "The router itself uses no operation.",
    ]),
    ("How do iterators and aggregators run in Make, and what do they cost?", [
        "Each bundle goes through the rest of the flow before the next bundle starts (depth-first).",
        "An empty or missing array gives 0 bundles, but a Text aggregator still outputs one bundle with empty text.",
        "A `null` element in the array fails the iterator: `TypeError: Cannot convert undefined or null to object`.",
        "After the aggregator, fields of the iterator and of the modules between them read as missing.",
        "Operations: the iterator counts 1 however many bundles it emits, each bundle through a later module counts "
        "1, the aggregator 1, a router 0 and a module a filter stopped 0.",
    ]),
    ("What does `now` return in Make?", [
        "The time each module starts, to the millisecond, not the time the scenario started. After a 3-second "
        "Sleep, the next module's `now` was 3 seconds later.",
        "`parseDate()` and `formatDate()` without a timezone use the organization's timezone.",
        "`addMonths()` clamps to the end of the month: January 31 plus one month is the last day of February.",
    ]),
    ("What happens when an expression fails in Make?", [
        "The module fails and the run stops. A webhook caller gets HTTP 500 with `Scenario failed to complete.`",
        "Make lets you start a scenario with an expression it can't evaluate. The first run fails, Make switches the "
        "scenario off, and webhooks sent after that wait in the queue (50 on the free plan).",
        "A Webhook response with an empty body reaches the caller as `200 Accepted`, the same text Make sends for a "
        "queued webhook.",
        "A trigger run that emits no bundles doesn't appear in the scenario's log at all.",
    ]),
]


def html_text(s: str) -> str:
    return re.sub(r"`([^`]+)`", r"<code>\1</code>", escape(s, quote=False))


def plain(s: str) -> str:
    return s.replace("`", "")


def anchor(q: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", plain(q).lower())).strip("-")


def behaviors_page() -> str:
    path = SITE + "make-behaviors/"
    title = "How Make.com evaluates mappings, filters and routers (recorded)"
    desc = ("Make.com behaviors recorded from real runs: [] reads the first element, if() truthiness, + joins text, "
            "filters, routers, iterators, now. With evidence.")
    toc = "".join(f'<li><a href="#{anchor(q)}">{html_text(q)}</a></li>' for q, _ in BEHAVIORS)
    sections = "".join(
        f'<h2 id="{anchor(q)}">{html_text(q)}</h2><ul>{"".join(f"<li>{html_text(a)}</li>" for a in answers)}</ul>'
        for q, answers in BEHAVIORS)
    graph = [
        {"@type": "TechArticle", "@id": path + "#article", "headline": "How Make.com actually evaluates mappings, "
         "filters and routers", "description": desc, "url": path, "mainEntityOfPage": path, "inLanguage": "en",
         "datePublished": PUBLISHED, "dateModified": TODAY, "author": AUTHOR, "publisher": AUTHOR,
         "image": SITE + "social.png",
         "about": {"@type": "Thing", "name": "Make", "alternateName": ["Make.com", "Integromat"],
                   "sameAs": "https://www.make.com/"},
         "isBasedOn": NOTES, "isPartOf": {"@id": SITE + "#website"}},
        {"@type": "FAQPage", "@id": path + "#faq", "mainEntity": [
            {"@type": "Question", "name": plain(q),
             "acceptedAnswer": {"@type": "Answer", "text": " ".join(plain(a) for a in answers)}}
            for q, answers in BEHAVIORS]},
        {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "blueprint-runtime", "item": SITE},
            {"@type": "ListItem", "position": 2, "name": "Make.com behaviors", "item": path}]},
    ]
    ld = json.dumps({"@context": "https://schema.org", "@graph": graph}, indent=1, ensure_ascii=False)
    ld = ld.replace("<", "\\u003c")
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(title)}</title>
<meta name="description" content="{escape(desc)}">
<link rel="canonical" href="{path}">
<link rel="icon" href="{SITE}favicon.svg" type="image/svg+xml">
<meta name="author" content="Intikhab Azam">
<meta property="og:type" content="article">
<meta property="og:site_name" content="blueprint-runtime">
<meta property="og:title" content="{escape(title)}">
<meta property="og:description" content="{escape(desc)}">
<meta property="og:url" content="{path}">
<meta property="og:image" content="{SITE}social.png">
<meta property="og:image:width" content="1280">
<meta property="og:image:height" content="640">
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" type="text/plain" href="{SITE}llms.txt" title="llms.txt">
<script type="application/ld+json">
{ld}
</script>
<style>
  :root {{ --ink:#16202c; --muted:#5a6675; --blue:#2a78d6; --green:#1baf7a; --bg:#fbfcfd; --line:#e3e8ee; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--ink); background:var(--bg); }}
  main {{ max-width:760px; margin:0 auto; padding:40px 22px 64px; }}
  h1 {{ font-size:2rem; line-height:1.2; margin:18px 0 12px; }}
  h2 {{ font-size:1.25rem; margin:40px 0 8px; }}
  p.lead {{ font-size:1.1rem; color:var(--muted); }}
  a {{ color:var(--blue); }}
  .crumbs {{ font-size:.88rem; color:var(--muted); }} .crumbs a {{ color:var(--muted); }}
  code {{ font-family:ui-monospace,"Cascadia Code",Consolas,monospace; background:#eef2f6; padding:1px 5px; border-radius:4px; font-size:.88em; }}
  li {{ margin:6px 0; }}
  .box {{ border:1px solid var(--line); background:#fff; border-radius:8px; padding:14px 18px; margin:22px 0; }}
  footer {{ margin-top:56px; padding-top:18px; border-top:1px solid var(--line); color:var(--muted); font-size:.9rem; }}
</style>
</head>
<body>
<main>
<p class="crumbs"><a href="{SITE}">blueprint-runtime</a> / Make.com behaviors</p>
<h1>How Make.com actually evaluates mappings, filters and routers</h1>
<p class="lead">Make doesn't publish a specification for its expression language. Everything below was recorded from
real runs in a Make account (eu1, Free plan) in October 2026 while building blueprint-runtime, an open source offline
test runner that reproduces 71 of 79 of those runs exactly. Each answer is backed by a recording listed in the
project's <a href="{NOTES}">evidence notes</a>.</p>
<div class="box">Check your own scenario against these rules without running it in Make:
<code>npx blueprint-runtime inspect your-scenario.blueprint.json</code> · <a href="{SITE}">What blueprint-runtime does</a></div>
<ul>{toc}</ul>
{sections}
<p>Make can change its behavior. These are dated observations from one account, not Make's documentation. Where no run
showed how Make behaves, blueprint-runtime refuses the case instead of guessing.</p>
<footer>
  blueprint-runtime · MIT · by <a href="https://github.com/intikhab49">Intikhab Azam</a> · <a href="{REPO}">Source</a> ·
  <a href="{NOTES}">Evidence notes</a> · <a href="{SITE}llms.txt">llms.txt</a><br>
  Make and Integromat are trademarks of their owners. This project is not affiliated with Make.
</footer>
</main>
</body>
</html>
"""


def llms_full() -> str:
    head = (HERE / "llms.txt").read_text(encoding="utf-8").rstrip("\n")
    out = [head, "", "# Make.com behaviors recorded from real runs (October 2026, eu1, Free plan)", ""]
    for q, answers in BEHAVIORS:
        out += [f"## {plain(q)}", ""] + [f"- {plain(a)}" for a in answers] + [""]
    out += [f"Evidence for every line: {NOTES}", "", "# README", "",
            (ROOT / "README.md").read_text(encoding="utf-8").rstrip("\n"), ""]
    return "\n".join(out)


def sitemap() -> str:
    urls = "".join(f"  <url><loc>{SITE}{p}</loc><lastmod>{TODAY}</lastmod></url>\n" for p in ("", "make-behaviors/"))
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            f"{urls}</urlset>\n")


if __name__ == "__main__":
    (HERE / "make-behaviors").mkdir(exist_ok=True)
    (HERE / "make-behaviors" / "index.html").write_text(behaviors_page(), encoding="utf-8", newline="\n")
    (HERE / "llms-full.txt").write_text(llms_full(), encoding="utf-8", newline="\n")
    (HERE / "sitemap.xml").write_text(sitemap(), encoding="utf-8", newline="\n")
    print("wrote docs/make-behaviors/index.html, docs/llms-full.txt, docs/sitemap.xml")
