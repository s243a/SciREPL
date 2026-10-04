#!/usr/bin/env python3
"""Generate the bug-badged launcher icons for Android debug builds.

Reads the release launcher PNGs from android/app/src/main/res/mipmap-*/ and
writes badged copies to android/app/src/debug/res/mipmap-*/. The debug source
set overrides only these mipmaps, so release builds keep the original icons.

Requires Pillow. Re-run after changing the release icons:

    python3 scripts/make-debug-launcher-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
MAIN_RES = ROOT / "android/app/src/main/res"
DEBUG_RES = ROOT / "android/app/src/debug/res"
DENSITIES = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]

BADGE_FILL = (229, 57, 53, 255)  # red
BADGE_RING = (255, 255, 255, 255)
GLYPH = (255, 255, 255, 255)
SUPERSAMPLE = 8

# Badge centre and radius as fractions of the image side.
# Adaptive foreground (108dp canvas): launcher masks keep only the central
# 66dp safe zone, so the badge must sit within 33dp of the centre:
# sqrt(2) * (69 - 54) + 10.5 = 31.7dp.
FOREGROUND_BADGE = (69 / 108, 10.5 / 108)
# Legacy square / round icons: bottom-right corner, inside the rounded tile.
LEGACY_BADGE = (0.73, 0.19)


def draw_bug(draw, cx, cy, r):
    """A simple white bug glyph centred at (cx, cy), fitting in radius r."""
    w = max(1, round(r * 0.09))
    # Legs: three per side.
    for dy in (-0.22, 0.08, 0.36):
        y = cy + dy * r
        for side in (-1, 1):
            x0 = cx + side * 0.18 * r
            x1 = cx + side * 0.60 * r
            y1 = y + (dy * 0.6 - 0.02) * r
            draw.line([(x0, y), (x1, y1)], fill=GLYPH, width=w)
    # Antennae.
    for side in (-1, 1):
        draw.line([(cx + side * 0.10 * r, cy - 0.45 * r),
                   (cx + side * 0.32 * r, cy - 0.68 * r)], fill=GLYPH, width=w)
    # Head.
    hr = 0.18 * r
    draw.ellipse([cx - hr, cy - 0.52 * r - hr, cx + hr, cy - 0.52 * r + hr], fill=GLYPH)
    # Body.
    draw.ellipse([cx - 0.30 * r, cy - 0.38 * r, cx + 0.30 * r, cy + 0.55 * r], fill=GLYPH)
    # Centre seam, in the badge colour, so the body reads as a beetle.
    draw.line([(cx, cy - 0.30 * r), (cx, cy + 0.50 * r)], fill=BADGE_FILL, width=w)


def badge(src: Path, dst: Path, centre_frac: float, radius_frac: float):
    base = Image.open(src).convert("RGBA")
    size = base.width
    big = size * SUPERSAMPLE
    overlay = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    c = centre_frac * big
    r = radius_frac * big
    ring = r * 0.12
    d.ellipse([c - r - ring, c - r - ring, c + r + ring, c + r + ring], fill=BADGE_RING)
    d.ellipse([c - r, c - r, c + r, c + r], fill=BADGE_FILL)
    draw_bug(d, c, c + 0.04 * r, r * 0.95)
    overlay = overlay.resize((size, size), Image.LANCZOS)
    out = Image.alpha_composite(base, overlay)
    dst.parent.mkdir(parents=True, exist_ok=True)
    out.save(dst, optimize=True)


def main():
    for density in DENSITIES:
        src_dir = MAIN_RES / f"mipmap-{density}"
        dst_dir = DEBUG_RES / f"mipmap-{density}"
        badge(src_dir / "ic_launcher_foreground.png",
              dst_dir / "ic_launcher_foreground.png", *FOREGROUND_BADGE)
        for name in ("ic_launcher.png", "ic_launcher_round.png"):
            badge(src_dir / name, dst_dir / name, *LEGACY_BADGE)
        print(f"wrote {dst_dir.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
