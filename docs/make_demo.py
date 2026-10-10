"""Render docs/demo.gif from REAL command output. Nothing in the frames is typed by hand.

  python docs/make_demo.py

Each scene runs a bpr command in this checkout (`node src/cli.ts`, shown as `bpr`),
captures its stdout and exit code, and draws terminal frames with Pillow: the command
typed out, then the output line by line. Fonts: Consolas, with per-character fallback
to MS Gothic (CJK) and Segoe UI Emoji (Windows fonts).
"""
from __future__ import annotations

import pathlib
import subprocess

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "demo.gif"

SCENES = [
    ("A blueprint edit changed upper() to capitalize(). Replay real Make runs:", ["test", "examples/broken-mapping"]),
    ("An HTTP step runs from a fixture. Wrong, unused or missing fixtures fail closed:", ["test", "examples/http-fixture/cases"]),
]

W, COLS = 1180, 118
PAD, LINE = 22, 22
BG, FG, DIM = "#0A0A14", "#E8E8F0", "#8B8BA7"
LIME, AMBER, CORAL, GREEN = "#A3E635", "#FFB020", "#FF6B4A", "#4ADE80"
FONTS = "C:/Windows/Fonts/"
MONO = ImageFont.truetype(FONTS + "consola.ttf", 15)
MONO_B = ImageFont.truetype(FONTS + "consolab.ttf", 15)
CJK = ImageFont.truetype(FONTS + "msgothic.ttc", 15)
EMOJI = ImageFont.truetype(FONTS + "seguiemj.ttf", 14)
CW = MONO.getlength("M")


def run(args: list[str]) -> tuple[list[str], int]:
    p = subprocess.run(["node", "src/cli.ts", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=False)
    return p.stdout.rstrip("\n").split("\n"), p.returncode


def wrap(line: str) -> list[str]:
    if len(line) <= COLS:
        return [line]
    out, indent = [], " " * 24
    while len(line) > COLS:
        cut = line.rfind(" ", 0, COLS)
        cut = cut if cut > 30 else COLS
        out.append(line[:cut])
        line = indent + line[cut:].lstrip()
    return out + [line]


def colour(line: str) -> str:
    if line.startswith("PASS"):
        return GREEN
    if line.startswith("FAIL"):
        return CORAL
    if line.startswith("FIXT"):
        return AMBER
    if line.startswith("$"):
        return FG
    return DIM if line.startswith(("#", "[", " ")) or "cases:" in line else FG


def draw_text(d: ImageDraw.ImageDraw, x: float, y: float, text: str, fill: str, bold=False):
    """Monospace grid; characters Consolas lacks come from the fallback fonts."""
    for ch in text:
        code = ord(ch)
        if code > 0x2FFF and code < 0x1F000:
            d.text((x, y + 1), ch, font=CJK, fill=fill)
            x += CW * 2
        elif code >= 0x1F000:
            d.text((x, y + 2), ch, font=EMOJI, embedded_color=True)
            x += CW * 2
        else:
            d.text((x, y), ch, font=MONO_B if bold else MONO, fill=fill)
            x += CW


def frame(lines: list[tuple[str, str]], height: int, cursor: bool) -> Image.Image:
    img = Image.new("RGB", (W, height), BG)
    d = ImageDraw.Draw(img)
    for i, c in enumerate(["#FF5F57", "#FEBC2E", "#28C840"]):
        d.ellipse((PAD + i * 20, 12, PAD + i * 20 + 11, 23), fill=c)
    d.text((W / 2, 18), "bpr: offline Make blueprint tests", font=MONO, fill=DIM, anchor="mm")
    y = 44
    for text, fill in lines:
        if text.startswith("$ "):
            draw_text(d, PAD, y, "$", LIME, bold=True)
            draw_text(d, PAD + CW * 2, y, text[2:], FG)
        else:
            draw_text(d, PAD, y, text, fill, bold=text.startswith(("PASS", "FAIL", "FIXT")))
        y += LINE
    if cursor and lines:
        last = lines[-1][0]
        d.rectangle((PAD + CW * len(last) + 2, y - LINE + 3, PAD + CW * len(last) + 10, y - 5), fill=LIME)
    return img


def main():
    shots = []
    for comment, args in SCENES:
        out, code = run(args)
        body = [(l, colour(raw)) for raw in out for l in wrap(raw)] + [(f"[exit {code}]", DIM)]
        shots.append((comment, "$ bpr " + " ".join(args), body))
    rows = max(2 + len(b) for _, _, b in shots)
    height = 44 + rows * LINE + 18

    frames, durations = [], []
    for comment, cmd, body in shots:
        head = [("# " + comment, DIM)]
        for n in range(2, len(cmd) + 1, 2):
            frames.append(frame(head + [(cmd[:n], FG)], height, cursor=True))
            durations.append(45)
        frames.append(frame(head + [(cmd, FG)], height, cursor=True))
        durations.append(500)
        shown = head + [(cmd, FG)]
        for line in body:
            shown = shown + [line]
            frames.append(frame(shown, height, cursor=False))
            durations.append(110)
        durations[-1] = 4200
    frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True)
    print(f"wrote {OUT} ({len(frames)} frames, {sum(durations) / 1000:.1f}s, {OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
