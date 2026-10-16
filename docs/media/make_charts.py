"""Draw the README charts as static SVGs, one per colour scheme.

Data comes from bench/om2w (see docs/results/om2w-2026-10.md for run ids and verdicts).
usage: python3 docs/media/make_charts.py
"""
from pathlib import Path

OUT = Path(__file__).parent

# Hard Online-Mind2Web tasks passed per round of fixes (round 3 dropped gov.uk, which
# needs an answer the task never gives).
ROUNDS = [("Round 1", "before fixes", 5, 13), ("Round 2", "", 8, 13), ("Round 3", "", 8, 12), ("Round 4", "after fixes", 10, 12)]

THEMES = {
    "light": dict(surface="#fcfcfb", ink="#0b0b0b", ink2="#52514e", muted="#898781", grid="#e1e0d9", base="#c3c2b7", series="#2a78d6"),
    "dark": dict(surface="#1a1a19", ink="#f0efec", ink2="#c3c2b7", muted="#898781", grid="#2c2c2a", base="#383835", series="#3987e5"),
}


def rounds_chart(t):
    w, h = 720, 360
    left, right, top, bottom = 56, 24, 76, 64
    pw, ph = w - left - right, h - top - bottom
    band = pw / len(ROUNDS)
    bw = 72
    y = lambda pct: top + ph * (1 - pct)
    font = "font-family='-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif'"
    s = [f"<svg xmlns='http://www.w3.org/2000/svg' width='{w}' height='{h}' viewBox='0 0 {w} {h}' {font}>",
         f"<rect width='{w}' height='{h}' rx='12' fill='{t['surface']}'/>",
         f"<text x='{left}' y='34' font-size='18' font-weight='600' fill='{t['ink']}'>Hard website tasks done right, by round of fixes</text>",
         f"<text x='{left}' y='56' font-size='13' fill='{t['ink2']}'>Codex (gpt-6.1-sol, low reasoning) using browserctrl on live sites, graded from screenshots</text>"]
    for pct in (0, 0.25, 0.5, 0.75, 1):
        yy = y(pct)
        s.append(f"<line x1='{left}' x2='{w - right}' y1='{yy:.1f}' y2='{yy:.1f}' stroke='{t['base'] if pct == 0 else t['grid']}' stroke-width='1'/>")
        s.append(f"<text x='{left - 8}' y='{yy + 4:.1f}' font-size='11' text-anchor='end' fill='{t['muted']}'>{int(pct * 100)}%</text>")
    for i, (name, sub, ok, n) in enumerate(ROUNDS):
        cx = left + band * i + band / 2
        pct = ok / n
        x0, y0, y1 = cx - bw / 2, y(pct), y(0)
        r = 4  # rounded data end, square at the baseline
        s.append(f"<path d='M{x0:.1f},{y1:.1f} V{y0 + r:.1f} Q{x0:.1f},{y0:.1f} {x0 + r:.1f},{y0:.1f} H{x0 + bw - r:.1f} Q{x0 + bw:.1f},{y0:.1f} {x0 + bw:.1f},{y0 + r:.1f} V{y1:.1f} Z' fill='{t['series']}'><title>{name}: {ok} of {n} tasks ({pct:.0%})</title></path>")
        s.append(f"<text x='{cx:.1f}' y='{y0 - 8:.1f}' font-size='14' font-weight='600' text-anchor='middle' fill='{t['ink']}'>{ok} of {n}</text>")
        s.append(f"<text x='{cx:.1f}' y='{y1 + 20:.1f}' font-size='12' text-anchor='middle' fill='{t['ink2']}'>{name}</text>")
        if sub:
            s.append(f"<text x='{cx:.1f}' y='{y1 + 36:.1f}' font-size='11' text-anchor='middle' fill='{t['muted']}'>{sub}</text>")
    s.append("</svg>")
    return "\n".join(s)


for mode, t in THEMES.items():
    (OUT / f"rounds-{mode}.svg").write_text(rounds_chart(t))
    print(OUT / f"rounds-{mode}.svg")
