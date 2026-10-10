"""Generate the README header SVG. Self-hosted on purpose.

capsule-render and friends time out through GitHub's camo proxy often enough to
leave a broken image on the front page, so the header is generated here and
committed. Run docs/make_charts.py first (it writes docs/results.json), then:

  python docs/make_header.py

Validates as XML before writing: a bare '&' in SVG text is invalid XML and GitHub
renders it as "Invalid image source" with no other warning.
"""
import json
import pathlib
import xml.dom.minidom

HERE = pathlib.Path(__file__).parent
R = json.loads((HERE / "results.json").read_text(encoding="utf-8"))
FAM = R["conformance"]

W, H = 1200, 340
BG = "#0A0A14"
AMBER, CORAL, PINK = "#FFB020", "#FF6B4A", "#FF4E88"
LIME, BLUE, DIM = "#A3E635", "#5B9BFF", "#8B8BA7"
MONO = "ui-monospace,SFMono-Regular,Menlo,monospace"

ROWS = [("A", "straight line"), ("B", "router"), ("C", "iterator"), ("C2", "probes"), ("E", "HTTP"), ("T", "triggers"), ("N", "now / []"), ("D", "formulas")]
MATCHED = sum(f["matched"] for f in FAM.values())
RECORDED = sum(f["recorded"] for f in FAM.values())
DIFFER = sum(f["differ"] for f in FAM.values())


def bars_svg(x0, y0, w, h, gap=9):
    """Recorded Make runs per scenario family: matched (gradient) and refused (dim), to scale."""
    out, bh = [], (h - gap * (len(ROWS) - 1)) / len(ROWS)
    most = max(FAM[k]["recorded"] for k, _ in ROWS)
    for i, (key, name) in enumerate(ROWS):
        f = FAM[key]
        y = y0 + i * (bh + gap)
        mw = w * f["matched"] / most
        rw = w * (f["recorded"] - f["matched"]) / most
        if mw:
            out.append(f'<rect x="{x0}" y="{y:.1f}" width="{mw:.1f}" height="{bh:.1f}" rx="3" fill="url(#grad)"/>')
        if rw:
            out.append(f'<rect x="{x0 + mw:.1f}" y="{y:.1f}" width="{rw:.1f}" height="{bh:.1f}" rx="3" fill="{DIM}" opacity="0.35"/>')
        full = f["matched"] == f["recorded"]
        out.append(f'<text x="{x0 + mw + rw + 10:.1f}" y="{y + bh / 2 + 4:.1f}" font-family="{MONO}" font-size="12" '
                   f'fill="{"#FFFFFF" if full else DIM}" font-weight="{"700" if full else "400"}">'
                   f'{f["matched"]}/{f["recorded"]}  {key} {name}</text>')
    return "\n    ".join(out)


SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}"
     viewBox="0 0 {W} {H}" role="img"
     aria-label="blueprint-runtime: run and test Make scenario blueprints offline.
     {MATCHED} of {RECORDED} real Make runs reproduced exactly, {DIFFER} differ.">
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="{AMBER}"/>
      <stop offset="55%" stop-color="{CORAL}"/>
      <stop offset="100%" stop-color="{PINK}"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{CORAL}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="{BG}" stop-opacity="0"/>
    </linearGradient>
    <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
      <path d="M28 0 L0 0 0 28" fill="none" stroke="#FFFFFF" stroke-opacity="0.04"
            stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="{W}" height="{H}" fill="{BG}"/>
  <rect width="{W}" height="{H}" fill="url(#grid)"/>
  <circle cx="{W - 160}" cy="70" r="240" fill="url(#fade)"/>

  <text x="64" y="86" font-family="{MONO}"
        font-size="13" letter-spacing="3.5" fill="{LIME}">MAKE BLUEPRINTS
        &#183; OFFLINE TEST RUNNER</text>

  <text x="60" y="164" font-family="Georgia,'Times New Roman',serif"
        font-size="64" font-weight="700" fill="url(#grad)">blueprint-runtime</text>

  <text x="64" y="204" font-family="-apple-system,Segoe UI,Helvetica,sans-serif"
        font-size="19" fill="#E8E8F0">Run and test Make scenarios on your machine.</text>
  <text x="64" y="232" font-family="-apple-system,Segoe UI,Helvetica,sans-serif"
        font-size="19" fill="{DIM}">Every behavior checked against a real Make run.
        No guesses.</text>

  <g font-family="{MONO}" font-size="12">
    <rect x="64" y="262" width="160" height="28" rx="14" fill="none"
          stroke="{AMBER}" stroke-opacity="0.55"/>
    <text x="144" y="281" fill="{AMBER}" text-anchor="middle">{MATCHED}/{RECORDED} RUNS MATCH</text>

    <rect x="236" y="262" width="96" height="28" rx="14" fill="none"
          stroke="{LIME}" stroke-opacity="0.55"/>
    <text x="284" y="281" fill="{LIME}" text-anchor="middle">{DIFFER} DIFFER</text>

    <rect x="344" y="262" width="120" height="28" rx="14" fill="none"
          stroke="{BLUE}" stroke-opacity="0.55"/>
    <text x="404" y="281" fill="{BLUE}" text-anchor="middle">NO NETWORK</text>

    <rect x="476" y="262" width="128" height="28" rx="14" fill="none"
          stroke="{PINK}" stroke-opacity="0.55"/>
    <text x="540" y="281" fill="{PINK}" text-anchor="middle">0 RUNTIME DEPS</text>
  </g>

  <text x="800" y="74" font-family="{MONO}"
        font-size="11" letter-spacing="2" fill="{DIM}">REAL MAKE RUNS REPRODUCED</text>
  <g>
    {bars_svg(800, 92, 200, 196)}
  </g>
</svg>
"""

if __name__ == "__main__":
    out = HERE / "header.svg"
    xml.dom.minidom.parseString(SVG)          # fails loudly on a bare '&'
    out.write_text(SVG, encoding="utf-8")
    print(f"wrote {out} ({len(SVG)} bytes, valid XML)")
