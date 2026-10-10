"""README charts and the numbers behind them. Nothing here is typed in by hand.

  python docs/make_charts.py

Runs `bpr test` over every recorded Make run (corpus/reference) and reads the public
survey (corpus/survey/results.json), then writes:
  docs/results.json          the numbers (the header SVG reads these too)
  docs/charts/1_conformance.png
  docs/charts/2_survey.png
Palette and styling follow Open Jev's plots.py.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
from collections import Counter

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "docs"

SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_2 = "#52514e"
MUTED = "#898781"
BASELINE = "#c3c2b7"
S1 = "#2a78d6"
GOOD = "#0ca30c"
CRITICAL = "#d03b3b"

FAMILIES = [
    ("A", "A  straight line"),
    ("B", "B  router + filters"),
    ("C", "C  iterator + aggregator"),
    ("C2", "C2 iterator probes"),
    ("E", "E  HTTP from fixtures"),
    ("T", "T  multi-bundle trigger"),
    ("N", "N  now, [] in fields"),
    ("D", "D  formula probes"),
]


def style():
    matplotlib.rcParams.update({
        "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
        "text.color": INK, "axes.labelcolor": INK_2, "xtick.color": MUTED, "ytick.color": INK_2,
        "axes.edgecolor": BASELINE, "axes.linewidth": 1.0,
        "axes.spines.top": False, "axes.spines.right": False,
        "axes.grid": True, "grid.color": BASELINE, "grid.alpha": 0.45, "grid.linewidth": 0.8,
        "font.size": 11, "axes.titlesize": 13, "axes.titleweight": "bold",
        "axes.titlelocation": "left", "axes.titlepad": 12, "figure.dpi": 120,
    })


def caption(fig, text):
    fig.text(0.012, 0.975, text, ha="left", va="top", fontsize=9, color=MUTED)


def conformance():
    run = subprocess.run(["node", "src/cli.ts", "test", "corpus/reference", "--allow-unsupported", "--json"],
                         cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=False)
    results = json.loads(run.stdout)["results"]
    fam = {}
    for r in results:
        key = r["name"].split("-")[0]
        f = fam.setdefault(key, Counter())
        f[r["verdict"]] += 1
    return {k: {"recorded": sum(c.values()), "matched": c["pass"], "differ": c["fail"],
                "refused": c["unsupported"]} for k, c in fam.items()}


def chart_conformance(fam):
    fig, ax = plt.subplots(figsize=(9.2, 4.2))
    labels = [label for key, label in FAMILIES if key in fam][::-1]
    keys = [key for key, _ in FAMILIES if key in fam][::-1]
    matched = [fam[k]["matched"] for k in keys]
    refused = [fam[k]["refused"] for k in keys]
    differ = [fam[k]["differ"] for k in keys]
    y = range(len(keys))
    ax.barh(y, matched, color=S1, height=0.62, label="matches Make")
    ax.barh(y, refused, left=matched, color=BASELINE, height=0.62, label="refused (behavior not recorded)")
    ax.barh(y, differ, left=[m + r for m, r in zip(matched, refused)], color=CRITICAL, height=0.62, label="differs from Make")
    for i, k in enumerate(keys):
        total = fam[k]["recorded"]
        ax.text(total + 0.3, i, f'{fam[k]["matched"]}/{total}', va="center", fontsize=10, color=INK_2)
    ax.set_yticks(list(y), labels)
    ax.set_xlabel("recorded Make runs")
    ax.xaxis.get_major_locator().set_params(integer=True)
    ax.grid(axis="y", visible=False)
    ax.set_xlim(0, max(f["recorded"] for f in fam.values()) + 3)
    total_m = sum(f["matched"] for f in fam.values())
    total = sum(f["recorded"] for f in fam.values())
    total_d = sum(f["differ"] for f in fam.values())
    ax.set_title(f"{total_m} of {total} real Make runs reproduced exactly, {total_d} differ")
    ax.legend(loc="lower right", frameon=False, fontsize=9)
    caption(fig, "every module input and output bundle, filter decision, error and webhook response compared")
    fig.tight_layout(rect=(0, 0, 1, 0.95))
    fig.savefig(OUT / "charts" / "1_conformance.png")
    plt.close(fig)


def survey():
    data = json.loads((ROOT / "corpus" / "survey" / "results.json").read_text(encoding="utf-8"))
    rows = data["results"]
    verdicts = Counter(r["verdict"] for r in rows)
    blockers = Counter(b for r in rows if r["verdict"] == "unsupported" for b in r["blockers"])
    return {"files": len(rows), "eligible": verdicts["eligible"], "unsupported": verdicts["unsupported"],
            "invalid": verdicts["invalid"], "eligibleRefusedAtRuntime": sum(1 for r in rows if r["verdict"] == "eligible" and not (r["smoke"] or "").startswith("ran")),
            "topBlockers": blockers.most_common(8), "surveyedAt": data["surveyedAt"]}


SHORT = {
    "a polling or app trigger instead of a Custom webhook": "other first module (mail hook, HTTP, …)",
    "EXPRESSION_UNSUPPORTED: mapping over an array with [] has not been observed in Make": "[] array mapping",
    "keyword now": "now keyword",
    "module json:ParseJSON": "json:ParseJSON",
    "ERROR_HANDLER_UNSUPPORTED": "error-handler routes",
    "module util:SetVariables": "util:SetVariables",
    'MODULE_CONFIG_UNSUPPORTED: "…" switched off has not been observed in Make': "HTTP \"states as errors\" off",
    "ITERATOR_SCOPE_UNSUPPORTED": "other modules per iterator bundle",
    "module builtin:BasicAggregator": "array aggregator",
}


def chart_survey(s):
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(10.5, 4.2), gridspec_kw={"width_ratios": [1, 1.6]})
    parts = [("eligible", s["eligible"], S1), ("not yet\nsupported", s["unsupported"], BASELINE), ("invalid\nexport", s["invalid"], CRITICAL)]
    a1.bar([p[0] for p in parts], [p[1] for p in parts], color=[p[2] for p in parts], width=0.6)
    for i, p in enumerate(parts):
        a1.text(i, p[1] + 3, str(p[1]), ha="center", fontsize=11, color=INK, fontweight="bold" if i == 0 else "normal")
    a1.set_title(f'{s["eligible"]} of {s["files"]} public blueprints run today')
    a1.set_ylabel("files (one per GitHub repo)")
    a1.grid(axis="x", visible=False)
    a1.tick_params(axis="x", labelsize=9)
    names = [SHORT.get(b, b)[:34] for b, _ in s["topBlockers"]][::-1]
    counts = [c for _, c in s["topBlockers"]][::-1]
    a2.barh(names, counts, color=S1, height=0.6, alpha=0.85)
    for i, c in enumerate(counts):
        a2.text(c + 1, i, str(c), va="center", fontsize=9, color=INK_2)
    a2.set_title("what holds the rest back (files)")
    a2.grid(axis="y", visible=False)
    a2.tick_params(axis="y", labelsize=9)
    n = s["eligibleRefusedAtRuntime"]
    caption(fig, f'GitHub code search {s["surveyedAt"]}; every eligible file was also run through the scheduler: '
                 + (f'{n} refused on stub test data (reasons in corpus/survey)' if n else '0 refusals'))
    fig.tight_layout(rect=(0, 0, 1, 0.95))
    fig.savefig(OUT / "charts" / "2_survey.png")
    plt.close(fig)


if __name__ == "__main__":
    style()
    (OUT / "charts").mkdir(parents=True, exist_ok=True)
    fam = conformance()
    s = survey()
    chart_conformance(fam)
    chart_survey(s)
    (OUT / "results.json").write_text(json.dumps({"conformance": fam, "survey": s}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: (v["matched"], v["recorded"]) for k, v in fam.items()}), s["eligible"], "/", s["files"])
