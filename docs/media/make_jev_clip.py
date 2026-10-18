"""A run's video, sped up, that stops at every Jev call on a card showing exactly what Jev was
given and what it answered (make_jev_card.mjs), then carries on. Writes an animated WebP.

The recording must come from a `do` run with BROWSERCTRL_JEV_LOG set, so the log holds each
call's input and answer.

usage: python3 docs/media/make_jev_clip.py <rec-dir> <jev-log.jsonl> <out.webp> [--speed 4] [--hold 3] [--label "…"]
"""
import json, subprocess, sys, tempfile
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
rec, log, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
opt = lambda k, d: sys.argv[sys.argv.index(f"--{k}") + 1] if f"--{k}" in sys.argv else d
speed, hold, label = float(opt("speed", 4)), float(opt("hold", 3)), opt("label", None)
tmp = Path(tempfile.mkdtemp(prefix="jev-clip-"))
run = lambda *a: subprocess.run(a, check=True, capture_output=True)

base = tmp / "base.mp4"
run("node", str(ROOT / "bin/browserctrl.mjs"), "replay", str(rec), "--video", str(base), "--width", "1280", "--no-open", *(["--label", label] if label else []))
W, H = (int(x) for x in subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(base)], capture_output=True, text=True).stdout.strip().strip(",").split(",")[:2])
dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(base)], capture_output=True, text=True).stdout)
started = json.loads((rec / "meta.json").read_text())["startedAt"] / 1000

# The calls that chose a target (the others ask whether a popup is in the way), on the video's clock.
calls = []
for i, line in enumerate(log.read_text().splitlines(), 1):
    c = json.loads(line)
    if "target" in c["questions"]:
        t = datetime.fromisoformat(c["at"].replace("Z", "+00:00")).timestamp() - started
        if 0 <= t <= dur:
            calls.append((t, i))

parts, prev = [], 0.0
for n, (t, line) in enumerate(calls):
    seg = tmp / f"seg{n}.mp4"
    run("ffmpeg", "-y", "-ss", f"{prev}", "-to", f"{t}", "-i", str(base), "-vf", f"setpts=(PTS-STARTPTS)/{speed},fps=10", "-an", str(seg))
    card = tmp / f"card{n}.png"
    run("node", str(HERE / "make_jev_card.mjs"), str(log), str(card), "--line", str(line))
    still = tmp / f"card{n}.mp4"
    run("ffmpeg", "-y", "-loop", "1", "-t", f"{hold}", "-i", str(card), "-vf", f"scale={W}:-2,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0x0f1115,fps=10,format=yuv420p", str(still))
    parts += [seg, still]
    prev = t
tail = tmp / "tail.mp4"
run("ffmpeg", "-y", "-ss", f"{prev}", "-i", str(base), "-vf", f"setpts=(PTS-STARTPTS)/{speed},fps=10", "-an", str(tail))
parts.append(tail)
lst = tmp / "parts.txt"
lst.write_text("".join(f"file '{p}'\n" for p in parts))
joined = tmp / "joined.mp4"
run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-vf", "format=yuv420p", "-c:v", "libx264", "-crf", "24", str(joined))
run("ffmpeg", "-y", "-i", str(joined), "-vf", "scale=1100:-2:flags=lanczos", "-c:v", "libwebp_anim", "-q:v", "55", "-compression_level", "6", "-loop", "0", "-an", str(out))
print(f"{out} ({out.stat().st_size // 1024} KB, {len(calls)} Jev calls shown)")
