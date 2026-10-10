"""Generate the repository's social preview card (1280x640, GitHub's recommended size).

  python docs/make_charts.py && python docs/make_social.py

Writes docs/social.svg and, with Chrome installed, renders docs/social.png, the image to
upload in GitHub: Settings → General → Social preview. It reuses the header's style and
the numbers in docs/results.json, so nothing on the card is typed by hand.
"""
import pathlib
import shutil
import subprocess
import xml.dom.minidom

import make_header as h

W, H = 1280, 640
HERE = pathlib.Path(__file__).parent

SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img"
     aria-label="blueprint-runtime: test Make.com scenarios offline. {h.MATCHED} of {h.RECORDED} real Make runs reproduced exactly, {h.DIFFER} differ.">
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="{h.AMBER}"/>
      <stop offset="55%" stop-color="{h.CORAL}"/>
      <stop offset="100%" stop-color="{h.PINK}"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{h.CORAL}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="{h.BG}" stop-opacity="0"/>
    </linearGradient>
    <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
      <path d="M28 0 L0 0 0 28" fill="none" stroke="#FFFFFF" stroke-opacity="0.04" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="{W}" height="{H}" fill="{h.BG}"/>
  <rect width="{W}" height="{H}" fill="url(#grid)"/>
  <circle cx="{W - 180}" cy="110" r="330" fill="url(#fade)"/>

  <text x="72" y="118" font-family="{h.MONO}" font-size="18" letter-spacing="4" fill="{h.LIME}">OPEN SOURCE &#183; MAKE.COM &#183; INTEGROMAT</text>
  <text x="68" y="214" font-family="Georgia,'Times New Roman',serif" font-size="78" font-weight="700" fill="url(#grad)">blueprint-runtime</text>
  <text x="72" y="282" font-family="-apple-system,Segoe UI,Helvetica,sans-serif" font-size="38" font-weight="600" fill="#E8E8F0">Test Make.com scenarios offline.</text>
  <text x="72" y="336" font-family="-apple-system,Segoe UI,Helvetica,sans-serif" font-size="25" fill="{h.DIM}">Replay real Make runs. Catch a broken mapping</text>
  <text x="72" y="370" font-family="-apple-system,Segoe UI,Helvetica,sans-serif" font-size="25" fill="{h.DIM}">before you deploy. No account, no credits.</text>

  <g font-family="{h.MONO}" font-size="17">
    <rect x="72" y="430" width="230" height="44" rx="22" fill="none" stroke="{h.AMBER}" stroke-opacity="0.6"/>
    <text x="187" y="458" fill="{h.AMBER}" text-anchor="middle">{h.MATCHED}/{h.RECORDED} RUNS MATCH</text>
    <rect x="316" y="430" width="136" height="44" rx="22" fill="none" stroke="{h.LIME}" stroke-opacity="0.6"/>
    <text x="384" y="458" fill="{h.LIME}" text-anchor="middle">{h.DIFFER} DIFFER</text>
    <rect x="466" y="430" width="170" height="44" rx="22" fill="none" stroke="{h.BLUE}" stroke-opacity="0.6"/>
    <text x="551" y="458" fill="{h.BLUE}" text-anchor="middle">NO NETWORK</text>
    <rect x="650" y="430" width="140" height="44" rx="22" fill="none" stroke="{h.PINK}" stroke-opacity="0.6"/>
    <text x="720" y="458" fill="{h.PINK}" text-anchor="middle">CI READY</text>
  </g>

  <text x="72" y="566" font-family="{h.MONO}" font-size="18" fill="{h.DIM}">github.com/intikhab49/blueprint-runtime</text>

  <text x="880" y="430" font-family="{h.MONO}" font-size="13" letter-spacing="2" fill="{h.DIM}">REAL MAKE RUNS REPRODUCED</text>
  <g transform="translate(880 446) scale(1.0)">
    {h.bars_svg(0, 0, 150, 150, gap=6)}
  </g>
</svg>
"""

if __name__ == "__main__":
    xml.dom.minidom.parseString(SVG)
    (HERE / "social.svg").write_text(SVG, encoding="utf-8")
    chrome = shutil.which("chrome") or r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    if pathlib.Path(chrome).exists():
        subprocess.run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--window-size={W},{H}",
                        f"--screenshot={HERE / 'social.png'}", (HERE / "social.svg").resolve().as_uri()],
                       check=False, capture_output=True)
    print("wrote docs/social.svg" + (" and docs/social.png" if (HERE / "social.png").exists() else ""))
