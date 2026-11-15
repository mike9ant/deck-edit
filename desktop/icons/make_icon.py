"""Draw the app icon (1024×1024 PNG): a presentation board with a chart and a
sparkle, on the app's accent blue. Then generate every size Tauri needs:

    .venv/bin/python desktop/icons/make_icon.py desktop/icons/icon-source.png
    (cd desktop && npx --yes @tauri-apps/cli@2 icon icons/icon-source.png -o icons)
"""

import sys

from PIL import Image, ImageDraw

S = 1024
TOP, BOTTOM = (91, 127, 240), (49, 84, 201)  # accent #3d63dd, lighter on top


def main(out: str) -> None:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # macOS icon grid: an 824px rounded square centred on the canvas, vertical gradient.
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / (S - 1)
        gd.line([(0, y), (S, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)) + (255,))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((100, 100, 924, 924), radius=185, fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)
    blue = (61, 99, 221, 255)
    # The board, its stand and base.
    d.rounded_rectangle((222, 270, 802, 650), radius=40, fill=white)
    d.rounded_rectangle((497, 640, 527, 770), radius=10, fill=white)
    d.rounded_rectangle((402, 752, 622, 786), radius=17, fill=white)
    # A bar chart on the board.
    base = 590
    for x, h in ((320, 120), (420, 210), (520, 160), (620, 250)):
        d.rounded_rectangle((x, base - h, x + 64, base), radius=12, fill=blue)
    # A four-point sparkle at the board's corner (the AI helping).
    cx, cy, r, w = 790, 268, 92, 26
    d.polygon([(cx, cy - r), (cx + w, cy - w), (cx + r, cy), (cx + w, cy + w), (cx, cy + r), (cx - w, cy + w), (cx - r, cy), (cx - w, cy - w)], fill=(255, 214, 102, 255))
    img.save(out)


if __name__ == "__main__":
    main(sys.argv[1])
