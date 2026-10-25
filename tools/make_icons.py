"""Draws the app icons (isometric house outline on slate) into app/icons/."""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "app" / "icons"
SLATE, WHITE, BLUE = (32, 38, 45), (240, 243, 246), (79, 140, 255)


def draw(size, pad):
    s = 4 * size                                    # draw large, scale down for smooth lines
    im = Image.new("RGB", (s, s), SLATE)
    d = ImageDraw.Draw(im)
    k = (s - 2 * pad * 4) / 100                     # house drawn in a 100 x 100 box

    def p(x, y):
        return (pad * 4 + x * k, pad * 4 + y * k)

    w = max(4, int(3.2 * k))
    # isometric box + gable roof
    left, mid, right = [p(14, 44), p(14, 78)], [p(50, 58), p(50, 94)], [p(86, 44), p(86, 78)]
    d.polygon([*left, mid[1], mid[0]], fill=(52, 60, 70))
    d.polygon([mid[0], mid[1], right[1], right[0]], fill=(44, 51, 60))
    for a, b in [(left[0], left[1]), (mid[0], mid[1]), (right[0], right[1]),
                 (left[1], mid[1]), (mid[1], right[1]), (left[0], mid[0]), (mid[0], right[0])]:
        d.line([a, b], fill=WHITE, width=w)
    ridge_a, ridge_b = p(32, 22), p(68, 10)
    d.polygon([left[0], ridge_a, p(68, 36), mid[0]], fill=BLUE)
    d.line([left[0], ridge_a, ridge_b, right[0]], fill=WHITE, width=w, joint="curve")
    d.line([ridge_a, p(68, 36), mid[0]], fill=WHITE, width=w)
    d.line([p(68, 36), ridge_b], fill=WHITE, width=w)
    # door
    d.line([p(62, 90), p(62, 72), p(72, 67), p(72, 85)], fill=WHITE, width=w)
    return im.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
for size in (180, 192, 512):
    draw(size, size * 0.12).save(OUT / f"icon-{size}.png")
draw(512, 512 * 0.22).save(OUT / "icon-maskable-512.png")
print("icons written to", OUT)
