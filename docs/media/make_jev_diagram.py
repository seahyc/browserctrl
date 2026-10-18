"""Where Jev sits in a do plan: a diagram in light and dark (how-jev-fits-{light,dark}.svg).

usage: python3 docs/media/make_jev_diagram.py
"""
from pathlib import Path

HERE = Path(__file__).parent
THEMES = {
    "light": dict(bg="#ffffff", ink="#1f2328", muted="#59636e", box="#f6f8fa", line="#d1d9e0", accent="#cf222e", jev="#1a7f37", jevbg="#dafbe1", warn="#9a6700", warnbg="#fff8c5"),
    "dark": dict(bg="#0d1117", ink="#e6edf3", muted="#9198a1", box="#161b22", line="#3d444d", accent="#ff7b72", jev="#3fb950", jevbg="#12261e", warn="#d29922", warnbg="#272115"),
}


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def svg(t):
    W, H = 980, 520
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">',
           f'<rect width="{W}" height="{H}" fill="{t["bg"]}"/>',
           f'<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{t["muted"]}"/></marker></defs>']

    def box(x, y, w, h, fill, stroke, title, lines, title_color=None, size=15):
        out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        out.append(f'<text x="{x + 16}" y="{y + 28}" font-size="{size}" font-weight="700" fill="{title_color or t["ink"]}">{esc(title)}</text>')
        for i, ln in enumerate(lines):
            mono = ln.startswith("`")
            ln = ln.strip("`")
            out.append(f'<text x="{x + 16}" y="{y + 52 + i * 20}" font-size="{12.5 if mono else 13.5}" fill="{t["muted"] if not mono else t["ink"]}"{" font-family=\"ui-monospace,SFMono-Regular,Menlo,monospace\"" if mono else ""}>{esc(ln)}</text>')

    def arrow(x1, y1, x2, y2, label=None, lx=None, ly=None):
        out.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{t["muted"]}" stroke-width="1.6" marker-end="url(#a)"/>')
        if label:
            out.append(f'<text x="{lx}" y="{ly}" font-size="12.5" fill="{t["muted"]}">{esc(label)}</text>')

    # The agent and its plan.
    box(24, 24, 290, 150, t["box"], t["line"], "1. The agent writes a plan", ["One call, in words, the way a person", "would say it:", "`do 'fill \"Search\" = \"blazer\"'`", "`   'click \"Filter\"' 'click \"Black\"'`"])
    arrow(314, 99, 372, 99)
    # browserctrl, per step.
    out.append(f'<rect x="372" y="24" width="584" height="368" rx="14" fill="none" stroke="{t["line"]}" stroke-width="1.5" stroke-dasharray="5 5"/>')
    out.append(f'<text x="390" y="50" font-size="15" font-weight="700" fill="{t["ink"]}">2. browserctrl, for each step</text>')
    box(390, 66, 250, 96, t["box"], t["line"], "Read the page", ["Every control: role, name, state,", "covered or not, in shadow roots too"])
    arrow(640, 114, 690, 114)
    box(690, 66, 250, 96, t["box"], t["line"], "Named exactly?", ["\"Filter\" = button \"Filter\": act now.", "About 3 steps in 4. No model at all."])
    arrow(815, 162, 815, 200, "no", 824, 186)
    box(690, 200, 250, 112, t["jevbg"], t["jev"], "Ask Jev", ["Text in: the page and the controls.", "One question: which control?", "Probabilities out, in about 0.3 s."], title_color=t["jev"])
    arrow(690, 256, 640, 256)
    box(390, 200, 250, 112, t["warnbg"], t["warn"], "Act, or stop and say why", ["Sure: act. Unsure: act, flag it ⚠.", "Nothing fits: stop, list candidates.", "Buy, pay, send: only with click!"], title_color=t["warn"])
    arrow(515, 312, 515, 330)
    box(390, 330, 550, 50, t["box"], t["line"], "Check it worked: box ticked? section open? error shown?", [], size=13.5)
    # The report back.
    arrow(390, 355, 314, 355)
    box(24, 290, 290, 202, t["box"], t["line"], "3. One report back", ["✓ each step and what it hit", "`changed on the page:`", "`  \"Results: 51\" → \"3 items\"`", "`  checkbox \"BLACK\": checked`", "The agent answers from this,", "without reading the page again."])
    # The lesson.
    out.append(f'<text x="390" y="430" font-size="14" font-weight="700" fill="{t["ink"]}">Jev chooses; it never plans and never reads for the answer.</text>')
    out.append(f'<text x="390" y="454" font-size="13.5" fill="{t["muted"]}">Planning, reading results and deciding when the task is done stay with the agent.</text>')
    out.append(f'<text x="390" y="476" font-size="13.5" fill="{t["muted"]}">Handed whole tasks, Jev finished 0 of 21 runs (see "Why not let Jev drive?").</text>')
    out.append("</svg>")
    return "\n".join(out)


for name, theme in THEMES.items():
    (HERE / f"how-jev-fits-{name}.svg").write_text(svg(theme))
print("wrote how-jev-fits-{light,dark}.svg")
