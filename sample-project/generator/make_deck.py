"""Builds the sample project's deck, "Rabbit Hole Roasters — Investor Deck.pptx" (14 slides).

Run by hand (`python3 make_deck.py`, after `node build.mjs` has rendered the pictures into ../images).
It replaces the deck: edits made to it since are lost.
Besides telling its story, the deck covers what real decks contain, so it doubles as a test deck:
a 16:9 master with layouts and placeholders, theme fonts and colors, native charts (column, line,
doughnut, scatter, bar), a table with merged cells, grouped / rotated / gradient-filled shapes,
connectors with arrowheads, PNG (transparent), JPEG and SVG pictures (SVG with a PNG fallback), a
cropped picture, a background picture, a hyperlink, slide-number fields, rich speaker notes,
click-by-click builds (p:timing) and slide transitions.
"""

import copy
import sys
from pathlib import Path

from lxml import etree
from PIL import Image
from pptx import Presentation
from pptx.chart.data import CategoryChartData, XyChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_LEGEND_POSITION, XL_MARKER_STYLE
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.opc.package import Part
from pptx.opc.packuri import PackURI
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

HERE = Path(__file__).resolve().parent
OUT = HERE.parent  # sample-project/
IMG = OUT / "images"
DECK = OUT / "Rabbit Hole Roasters — Investor Deck.pptx"

# Brand (see sample-project/Brand & Voice.md)
SPACE = RGBColor(0x14, 0x12, 0x3A)
NEBULA = RGBColor(0x3B, 0x2A, 0x6B)
ESPRESSO = RGBColor(0x6B, 0x42, 0x26)
CREMA = RGBColor(0xF6, 0xEB, 0xD9)
TEAL = RGBColor(0x2B, 0xB3, 0xA3)
HEART = RGBColor(0xD7, 0x26, 0x3D)
GOLD = RGBColor(0xF2, 0xB3, 0x3D)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
INK = RGBColor(0x2A, 0x25, 0x40)
HEAD, BODY = "Georgia", "Arial"

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
SW, SH = prs.slide_width, prs.slide_height
L_TITLE, L_TITLE_ONLY = prs.slide_layouts[0], prs.slide_layouts[5]


# ── theme: brand fonts and colors ─────────────────────────────────────────────
def brand_theme():
    theme = prs.slide_master.part.part_related_by(RT.THEME)
    root = etree.fromstring(theme.blob)
    ns = {"a": A}
    root.find(".//a:majorFont/a:latin", ns).set("typeface", HEAD)
    root.find(".//a:minorFont/a:latin", ns).set("typeface", BODY)
    colors = {"dk2": "14123A", "lt2": "F6EBD9", "accent1": "6B4226", "accent2": "3B2A6B", "accent3": "2BB3A3",
              "accent4": "D7263D", "accent5": "F2B33D", "accent6": "8A5530", "hlink": "2BB3A3", "folHlink": "3B2A6B"}
    scheme = root.find(".//a:clrScheme", ns)
    scheme.set("name", "Rabbit Hole Roasters")
    for name, hexval in colors.items():
        el = scheme.find(f"a:{name}", ns)
        for child in list(el):
            el.remove(child)
        etree.SubElement(el, f"{{{A}}}srgbClr", val=hexval)
    root.find(".//a:fontScheme", ns).set("name", "Rabbit Hole Roasters")
    theme._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


brand_theme()


# ── helpers ───────────────────────────────────────────────────────────────────
def px_size(name):
    with Image.open(IMG / name) as im:
        return im.size


def picture(slide, name, x, y, w=None, h=None):
    """A picture from images/, sized by width or height (keeping its proportions)."""
    pw, ph = px_size(name)
    if w is not None and h is None:
        h = w * ph / pw
    elif h is not None and w is None:
        w = h * pw / ph
    return slide.shapes.add_picture(str(IMG / name), Inches(x), Inches(y), Inches(w), Inches(h))


def text(slide, x, y, w, h, paragraphs, size=20, color=INK, font=BODY, bold=False, align=PP_ALIGN.LEFT,
         anchor=MSO_ANCHOR.TOP, italic=False, spacing=None, name=None):
    """A text box. `paragraphs`: a string, or a list of paragraphs; a paragraph is a string or a
    list of runs (text, {overrides})."""
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    if name:
        tb.name = name
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Inches(0.05)
    paras = [paragraphs] if isinstance(paragraphs, str) else paragraphs
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        if spacing:
            p.space_after = Pt(spacing)
        runs = [(para, {})] if isinstance(para, str) else para
        for run_text, o in runs:
            r = p.add_run()
            r.text = run_text
            f = r.font
            f.size = Pt(o.get("size", size))
            f.name = o.get("font", font)
            f.bold = o.get("bold", bold)
            f.italic = o.get("italic", italic)
            f.color.rgb = o.get("color", color)
    return tb


def title(slide, words, color=SPACE, size=None, y=0.45, h=1.0, x=0.6, w=12.1):
    """The slide's title placeholder, placed and styled (smaller type for a longer title, to stay on one line)."""
    if size is None:
        size = 36 if len(words) <= 40 else 32 if len(words) <= 46 else 28
    t = slide.shapes.title
    t.left, t.top, t.width, t.height = Inches(x), Inches(y), Inches(w), Inches(h)
    tf = t.text_frame
    tf.text = words
    tf.word_wrap = True
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.LEFT
    for r in p.runs:
        r.font.name, r.font.size, r.font.bold, r.font.color.rgb = HEAD, Pt(size), True, color
    return t


def box(slide, x, y, w, h, fill=WHITE, line=None, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.12, rotation=0):
    s = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    if shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        s.adjustments[0] = radius
    if fill is None:
        s.fill.background()
    else:
        s.fill.solid()
        s.fill.fore_color.rgb = fill
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = line
        s.line.width = Pt(2)
    s.shadow.inherit = False
    s.rotation = rotation
    return s


def gradient(shape, stops, angle=0):
    f = shape.fill
    f.gradient()
    f.gradient_angle = angle
    gs = f.gradient_stops
    for stop, (pos, color) in zip(gs, stops):
        stop.position = pos
        stop.color.rgb = color


def background(slide, color):
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = color


def background_picture(slide, name):
    """The slide's own background, filled with a picture (p:bg)."""
    _, rid = slide.part.get_or_add_image_part(str(IMG / name))
    c_sld = slide._element.find(qn("p:cSld"))
    bg = etree.SubElement(c_sld, qn("p:bg"))
    c_sld.remove(bg)
    c_sld.insert(0, bg)
    bg_pr = etree.SubElement(bg, qn("p:bgPr"))
    blip_fill = etree.SubElement(bg_pr, qn("a:blipFill"), dpi="0", rotWithShape="1")
    etree.SubElement(blip_fill, qn("a:blip")).set(qn("r:embed"), rid)
    etree.SubElement(blip_fill, qn("a:srcRect"))
    etree.SubElement(etree.SubElement(blip_fill, qn("a:stretch")), qn("a:fillRect"))
    etree.SubElement(bg_pr, qn("a:effectLst"))


def footer(slide, dark=False):
    """"Rabbit Hole Roasters · Series Tea 2027 · <slide number>" — the number is a field."""
    color = RGBColor(0xB8, 0xB0, 0xD8) if dark else RGBColor(0x8A, 0x80, 0x9E)
    tb = text(slide, 8.6, 7.0, 4.4, 0.35, [[("Rabbit Hole Roasters  ·  Series Tea 2027  ·  ", {})]], size=11,
              color=color, align=PP_ALIGN.RIGHT, name="Footer")
    p = tb.text_frame.paragraphs[0]._p
    fld = etree.SubElement(p, qn("a:fld"), id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}", type="slidenum")
    rpr = etree.SubElement(fld, qn("a:rPr"), lang="en-US", sz="1100", dirty="0")
    fill = etree.SubElement(rpr, qn("a:solidFill"))
    etree.SubElement(fill, qn("a:srgbClr"), val=str(color))
    etree.SubElement(rpr, qn("a:latin"), typeface=BODY)
    etree.SubElement(fld, qn("a:t")).text = str(len(prs.slides))
    end = p.find(qn("a:endParaRPr"))
    if end is not None:
        p.remove(end)
        p.append(end)


def notes(slide, paragraphs):
    """Speaker notes; a paragraph is a string or a list of (text, bold) runs."""
    tf = slide.notes_slide.notes_text_frame
    for i, para in enumerate(paragraphs):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        runs = [(para, False)] if isinstance(para, str) else para
        for t, b in runs:
            r = p.add_run()
            r.text = t
            r.font.bold = b


def transition(slide, kind="fade"):
    """A slide transition (p:transition goes after p:clrMapOvr, before p:timing)."""
    sld = slide._element
    tr = etree.Element(qn("p:transition"), spd="med")
    etree.SubElement(tr, qn(f"p:{kind}"))
    anchor = sld.find(qn("p:clrMapOvr"))
    anchor.addnext(tr)


def builds(slide, clicks):
    """Click-by-click entrance (fade) animations. `clicks`: one list of shapes per click — the first
    appears on the click, the rest with it."""
    ids = iter(range(3, 10_000))
    par_clicks = []
    text_shapes = []
    for group in clicks:
        click_id, inner_id = next(ids), next(ids)
        effects = []
        for k, shape in enumerate(group):
            eid, set_id, anim_id = next(ids), next(ids), next(ids)
            spid = shape.shape_id
            node = "clickEffect" if k == 0 else "withEffect"
            if shape._element.tag == qn("p:sp"):
                text_shapes.append(spid)
            effects.append(f"""
            <p:par><p:cTn id="{eid}" presetID="10" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="{node}">
              <p:stCondLst><p:cond delay="0"/></p:stCondLst>
              <p:childTnLst>
                <p:set><p:cBhvr><p:cTn id="{set_id}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>
                  <p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>
                  <p:to><p:strVal val="visible"/></p:to></p:set>
                <p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="{anim_id}" dur="600"/>
                  <p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:animEffect>
              </p:childTnLst></p:cTn></p:par>""")
        par_clicks.append(f"""
        <p:par><p:cTn id="{click_id}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst>
          <p:childTnLst><p:par><p:cTn id="{inner_id}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst>
            <p:childTnLst>{''.join(effects)}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>""")
    bld = "".join(f'<p:bldP spid="{s}" grpId="0" animBg="1"/>' for s in dict.fromkeys(text_shapes))
    xml = f"""<p:timing xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}">
  <p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>
    <p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>{''.join(par_clicks)}
    </p:childTnLst></p:cTn>
      <p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>
      <p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>
    </p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>
  {f'<p:bldLst>{bld}</p:bldLst>' if bld else ''}
</p:timing>"""
    timing = etree.fromstring(xml)
    sld = slide._element
    after = sld.find(qn("p:transition"))
    if after is None:
        after = sld.find(qn("p:clrMapOvr"))
    after.addnext(timing)


def svg_picture(slide, name_png, name_svg, x, y, h):
    """A picture that is an SVG, with its PNG as the fallback (how PowerPoint stores SVG)."""
    pic = picture(slide, name_png, x, y, h=h)
    svg_part = Part(PackURI(f"/ppt/media/{Path(name_svg).stem}-vector.svg"), "image/svg+xml", slide.part.package,
                    (IMG / name_svg).read_bytes())
    rid = slide.part.relate_to(svg_part, RT.IMAGE)
    blip = pic._element.find(".//" + qn("a:blip"))
    ext_lst = etree.SubElement(blip, qn("a:extLst"))
    ext = etree.SubElement(ext_lst, qn("a:ext"), uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}")
    svg = etree.SubElement(ext, "{http://schemas.microsoft.com/office/drawing/2016/SVG/main}svgBlip",
                           nsmap={"asvg": "http://schemas.microsoft.com/office/drawing/2016/SVG/main"})
    svg.set(qn("r:embed"), rid)
    return pic


def arrow_connector(slide, a, b):
    """A straight connector from the right edge of `a` to the left edge of `b`, with an arrowhead."""
    c = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, a.left + a.width, a.top + a.height // 2, b.left, b.top + b.height // 2)
    c.begin_connect(a, 3)
    c.end_connect(b, 1)
    c.line.color.rgb = GOLD
    c.line.width = Pt(3)
    ln = c.line._get_or_add_ln()
    etree.SubElement(ln, qn("a:tailEnd"), type="triangle", w="med", len="med")
    return c


def style_chart(chart, size=14):
    chart.font.size = Pt(size)
    chart.font.name = BODY
    chart.font.color.rgb = INK


def new_slide(layout=None, bg=CREMA):
    s = prs.slides.add_slide(layout or L_TITLE_ONLY)
    if bg is not None:
        background(s, bg)
    return s


# ── 1. Title ──────────────────────────────────────────────────────────────────
s = prs.slides.add_slide(L_TITLE)
background_picture(s, "starfield.jpg")
t = s.shapes.title
t.left, t.top, t.width, t.height = Inches(0.7), Inches(2.0), Inches(7.0), Inches(1.6)
t.text_frame.text = "Rabbit Hole Roasters"
t.text_frame.word_wrap = True
for r in t.text_frame.paragraphs[0].runs:
    r.font.name, r.font.size, r.font.bold, r.font.color.rgb = HEAD, Pt(56), True, WHITE
t.text_frame.paragraphs[0].alignment = PP_ALIGN.LEFT
sub = s.placeholders[1]
sub.left, sub.top, sub.width, sub.height = Inches(0.75), Inches(3.65), Inches(7.0), Inches(1.6)
sub.text_frame.text = "Coffee that's always on time — in orbit."
p = sub.text_frame.paragraphs[0]
p.alignment = PP_ALIGN.LEFT
for r in p.runs:
    r.font.name, r.font.size, r.font.color.rgb, r.font.italic = HEAD, Pt(26), CREMA, True
p2 = sub.text_frame.add_paragraph()
p2.alignment = PP_ALIGN.LEFT
r = p2.add_run()
r.text = "Series Tea  ·  Investor Presentation 2027"
r.font.name, r.font.size, r.font.color.rgb, r.font.bold = BODY, Pt(18), GOLD, True
picture(s, "coffee-planet.png", 7.15, 0.5, h=6.5)
transition(s, "fade")
notes(s, [
    [("Welcome. ", True), ("We're Rabbit Hole Roasters, and we make coffee that stays in the cup — in orbit.", False)],
    "Pause on the picture: yes, the steam is shaped like rabbit ears. That's the brand.",
    "Ask: $12M Series Tea (slide 13).",
])

# ── 2. The problem ────────────────────────────────────────────────────────────
s = new_slide()
title(s, "The problem: coffee won't stay in the cup")
picture(s, "floating-latte.png", 0.4, 1.6, w=6.6)
text(s, 7.2, 2.0, 5.6, 3.2, [
    [("In orbit, a latte achieves ", {}), ("escape velocity", {"bold": True, "color": HEART}), (".", {})],
    "Astronauts drink coffee from foil pouches, through straws.",
    "Loose droplets get into eyes, electronics — and once, the Queen.",
], size=24, spacing=18)
callout = box(s, 7.4, 5.35, 5.0, 1.0, fill=GOLD, radius=0.3, rotation=-3)
callout.text_frame.text = "Nobody deserves pouch coffee."
cp = callout.text_frame.paragraphs[0]
cp.alignment = PP_ALIGN.CENTER
for r in cp.runs:
    r.font.name, r.font.size, r.font.bold, r.font.color.rgb = HEAD, Pt(24), True, SPACE
footer(s)
notes(s, [
    "Everyone has seen the video of an astronaut chasing a floating blob of coffee. It's funny once.",
    [("The real problem: ", True), ("without gravity nothing holds a liquid in an open cup, so space coffee comes in pouches.", False)],
])

# ── 3. Market ─────────────────────────────────────────────────────────────────
s = new_slide()
title(s, "The market is growing curiouser and curiouser")
data = CategoryChartData()
data.categories = ["2024", "2026", "2028", "2030", "2032"]
data.add_series("Humans in orbit", (12, 30, 80, 220, 600))
gf = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.6), Inches(1.55), Inches(8.0), Inches(5.2), data)
gf.name = "Market chart"
ch = gf.chart
style_chart(ch)
ch.has_legend = False
ch.has_title = True
ch.chart_title.text_frame.text = "Humans in orbit (projected)"
for r in ch.chart_title.text_frame.paragraphs[0].runs:
    r.font.size, r.font.bold, r.font.name, r.font.color.rgb = Pt(16), True, BODY, NEBULA
plot = ch.plots[0]
plot.gap_width = 60
plot.has_data_labels = True
plot.data_labels.font.size = Pt(16)
plot.data_labels.font.bold = True
plot.data_labels.position = XL_LABEL_POSITION.OUTSIDE_END
ser = plot.series[0]
ser.format.fill.solid()
ser.format.fill.fore_color.rgb = ESPRESSO
ch.value_axis.has_major_gridlines = True
ch.value_axis.major_gridlines.format.line.color.rgb = RGBColor(0xE2, 0xD6, 0xC2)
ch.value_axis.tick_labels.font.size = Pt(12)
ch.value_axis.format.line.fill.background()
picture(s, "planet-earth.png", 9.35, 1.7, w=1.5)
text(s, 9.0, 3.2, 3.9, 1.2, "50×", size=80, font=HEAD, bold=True, color=TEAL)
text(s, 9.05, 4.55, 3.8, 1.6, "more people in orbit by 2032 — every one of them wants a decent flat white.", size=20)
text(s, 0.6, 6.85, 7.5, 0.4, "Projection, illustrative. Source: the Caterpillar's crystal ball.", size=11, italic=True,
     color=RGBColor(0x8A, 0x80, 0x9E))
footer(s)
notes(s, [
    "Twelve people in orbit in 2024. Six hundred by 2032 if the station and tourism plans hold.",
    [("Every one of them is a customer: ", True), ("crews on subscription, tourists in the café.", False)],
])

# ── 4. Solution ───────────────────────────────────────────────────────────────
s = new_slide()
title(s, "Our solution: the Drink Me Pod")
svg_picture(s, "drink-me-pod.png", "drink-me-pod.svg", 0.9, 1.35, h=5.8)
features = [
    ("1", "Brews in zero g", "Spins the grounds so they get their own gravity — then percolates like on Earth."),
    ("2", "Holds coffee without a lid", "A sharp corner in the cup uses surface tension to keep the coffee in."),
    ("3", "Sip like on Earth", "No straws, no pouches, no escaping latte."),
]
for i, (num, head, body) in enumerate(features):
    y = 1.65 + i * 1.75
    card = box(s, 6.0, y, 6.7, 1.5, fill=WHITE, radius=0.15)
    accent = box(s, 6.0, y, 0.18, 1.5, fill=TEAL, shape=MSO_SHAPE.RECTANGLE)
    if i == 1:
        gradient(accent, [(0, TEAL), (1.0, NEBULA)], angle=90)
    dot = box(s, 6.45, y + 0.38, 0.75, 0.75, fill=ESPRESSO, shape=MSO_SHAPE.OVAL)
    dot.text_frame.text = num
    dp = dot.text_frame.paragraphs[0]
    dp.alignment = PP_ALIGN.CENTER
    for r in dp.runs:
        r.font.name, r.font.size, r.font.bold, r.font.color.rgb = HEAD, Pt(24), True, WHITE
    t1 = text(s, 7.45, y + 0.18, 5.1, 0.5, head, size=22, font=HEAD, bold=True, color=SPACE)
    t2 = text(s, 7.45, y + 0.68, 5.1, 0.75, body, size=16, color=INK)
    group = s.shapes.add_group_shape([card, accent, dot, t1, t2])
    group.name = f"Feature {num}"
footer(s)
notes(s, [
    "Two parts: a brewer and a cup. The picture is an SVG — it stays sharp at any size.",
    "Physics details are in the technical design PDF in this folder.",
])

# ── 5. How it works ───────────────────────────────────────────────────────────
s = new_slide(bg=WHITE)
title(s, "How it works: spin to brew, wick to sip")
steps = ["Water in", "Spin: 134 rpm = 1 g", "Coffee out to the Pod", "Corner flow to your lips"]
chips = []
for i, label in enumerate(steps):
    chip = box(s, 0.6 + i * 3.15, 1.55, 2.6, 0.75, fill=NEBULA if i % 2 else ESPRESSO, radius=0.5)
    chip.name = f"Step {i + 1}"
    chip.text_frame.text = f"{i + 1}  {label}"
    cp = chip.text_frame.paragraphs[0]
    cp.alignment = PP_ALIGN.CENTER
    for r in cp.runs:
        r.font.name, r.font.size, r.font.bold, r.font.color.rgb = BODY, Pt(15), True, WHITE
    chips.append(chip)
links = [arrow_connector(s, chips[i], chips[i + 1]) for i in range(3)]
brew = picture(s, "diagram-brew-chamber.png", 0.4, 2.65, w=6.1)
cup = picture(s, "diagram-capillary-cup.png", 6.55, 2.55, w=6.5)
footer(s)
builds(s, [[chips[0]], [links[0], chips[1], brew], [links[1], chips[2]], [links[2], chips[3], cup]])
notes(s, [
    [("Click through: ", True), ("the four steps appear one at a time.", False)],
    "Step 2: the brew chamber spins at 134 rpm. At 5 cm from the axis that's one g — the water percolates through the grounds as it would on Earth.",
    "Step 4: the cup has a 15° interior corner. Coffee wets the coating at about 30°, and since 15 + 30 is under 90, surface tension pulls it along the corner to the rim (the Concus–Finn condition).",
])

# ── 6. The menu ───────────────────────────────────────────────────────────────
s = new_slide()
title(s, "The menu: a blend for every gravity")
rows = [
    ("Mad Hatter Dark", "Dark", "210 mg", "Any", "$9"),
    ("Unbirthday Blend", "Medium", "160 mg", "0–1 g", "$8"),
    ("Cheshire Decaf", "Light", "3 mg (mostly not there)", "0–1 g", "$7"),
    ("Queen's Red Velvet", "Medium-dark", "180 mg", "0–0.4 g", "$12 (mandatory)"),
]
gf = s.shapes.add_table(2 + len(rows), 5, Inches(0.6), Inches(1.6), Inches(9.3), Inches(4.6))
gf.name = "Menu table"
tbl = gf.table
for i, w in enumerate((2.6, 1.55, 2.35, 1.3, 1.5)):
    tbl.columns[i].width = Inches(w)


def cell(r, c, words, bold=False, color=INK, fill=None, size=16, align=PP_ALIGN.LEFT):
    ce = tbl.cell(r, c)
    ce.text = words
    ce.vertical_anchor = MSO_ANCHOR.MIDDLE
    ce.margin_left = Inches(0.12)
    if fill is not None:
        ce.fill.solid()
        ce.fill.fore_color.rgb = fill
    para = ce.text_frame.paragraphs[0]
    para.alignment = align
    for r_ in para.runs:
        r_.font.size, r_.font.bold, r_.font.color.rgb, r_.font.name = Pt(size), bold, color, BODY


# Two header rows: "Blend" spans both; "The coffee" and "For you" span two columns each.
tbl.cell(0, 0).merge(tbl.cell(1, 0))
tbl.cell(0, 1).merge(tbl.cell(0, 2))
tbl.cell(0, 3).merge(tbl.cell(0, 4))
cell(0, 0, "Blend", bold=True, color=WHITE, fill=NEBULA, size=18)
cell(0, 1, "The coffee", bold=True, color=WHITE, fill=NEBULA, size=18, align=PP_ALIGN.CENTER)
cell(0, 3, "For you", bold=True, color=WHITE, fill=NEBULA, size=18, align=PP_ALIGN.CENTER)
for c, h in enumerate(("Roast", "Caffeine", "Gravity", "Price"), start=1):
    cell(1, c, h, bold=True, color=SPACE, fill=RGBColor(0xD9, 0xCF, 0xEC), size=15)
for i, row in enumerate(rows):
    fill = WHITE if i % 2 == 0 else RGBColor(0xFB, 0xF5, 0xEA)
    for c, v in enumerate(row):
        queen = row[0].startswith("Queen")
        cell(2 + i, c, v, bold=(c == 0), color=HEART if queen and c in (0, 4) else INK, fill=fill)
queen = picture(s, "queen-card.png", 10.3, 2.0, h=3.6)
queen.rotation = 8
text(s, 10.0, 5.75, 3.0, 0.9, "Royal decree: Red Velvet with every order.", size=14, italic=True, color=HEART,
     align=PP_ALIGN.CENTER)
footer(s)
notes(s, [
    "Each blend is roasted for the gravity it's drunk in — on the Moon (0.17 g) crema behaves differently.",
    [("The Queen's Red Velvet is mandatory. ", True), ("We did not choose this.", False)],
])

# ── 7. The team ───────────────────────────────────────────────────────────────
s = new_slide(bg=SPACE)
title(s, "The team: we're all mad here", color=WHITE)
team = [
    ("portrait-alice.png", "Alice", "CEO & Chief Curiosity Officer", "Asks “why?” until the physics works."),
    ("portrait-mad-hatter.png", "The Mad Hatter", "Head of Blends", "Tasted every bean on two planets."),
    ("portrait-white-rabbit.png", "The White Rabbit", "COO", "Late to every meeting. Never to a launch."),
    ("portrait-cheshire-cat.png", "The Cheshire Cat", "Head of Remote Work", "Mostly not there. Leaves a grin."),
]
cat_shapes = []
for i, (img, name, role, line) in enumerate(team):
    x = 0.65 + i * 3.1
    pic = picture(s, img, x + 0.25, 1.65, w=2.45)
    n = text(s, x, 4.25, 2.95, 0.5, name, size=22, font=HEAD, bold=True, color=WHITE, align=PP_ALIGN.CENTER)
    r_ = text(s, x, 4.75, 2.95, 0.45, role, size=15, bold=True, color=GOLD, align=PP_ALIGN.CENTER)
    l_ = text(s, x, 5.2, 2.95, 0.9, line, size=15, color=CREMA, align=PP_ALIGN.CENTER, italic=True)
    if i == 3:
        cat_shapes = [pic, n, r_, l_]
footer(s, dark=True)
builds(s, [cat_shapes])
notes(s, [
    "Alice founded the company the day she fell down a rabbit hole into low Earth orbit.",
    [("Click once: ", True), ("the Cheshire Cat fades in. He's always the last to join the call.", False)],
])

# ── 8. Traction ───────────────────────────────────────────────────────────────
s = new_slide()
title(s, "Traction: 980 cups a month, up 8× since January")
data = CategoryChartData()
data.categories = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"]
data.add_series("Cups per month", (120, 180, 260, 410, 640, 980))
gf = s.shapes.add_chart(XL_CHART_TYPE.LINE_MARKERS, Inches(0.6), Inches(1.6), Inches(7.6), Inches(5.1), data)
gf.name = "Traction chart"
ch = gf.chart
style_chart(ch)
ch.has_legend = False
plot = ch.plots[0]
ser = plot.series[0]
ser.smooth = False
ser.format.line.color.rgb = TEAL
ser.format.line.width = Pt(4)
ser.marker.style = XL_MARKER_STYLE.CIRCLE
ser.marker.size = 11
ser.marker.format.fill.solid()
ser.marker.format.fill.fore_color.rgb = ESPRESSO
ser.marker.format.line.color.rgb = WHITE
plot.has_data_labels = True
plot.data_labels.position = XL_LABEL_POSITION.ABOVE
plot.data_labels.font.size = Pt(14)
plot.data_labels.font.bold = True
ch.value_axis.major_gridlines.format.line.color.rgb = RGBColor(0xE2, 0xD6, 0xC2)
ch.value_axis.format.line.fill.background()
quote = box(s, 8.7, 1.8, 4.1, 3.3, fill=WHITE, radius=0.08)
quote.name = "Quote"
qtf = quote.text_frame
qtf.word_wrap = True
qtf.margin_left = qtf.margin_right = Inches(0.3)
qtf.text = "“Finally, a cup that doesn't attack you.”"
qp = qtf.paragraphs[0]
for r in qp.runs:
    r.font.name, r.font.size, r.font.italic, r.font.color.rgb = HEAD, Pt(24), True, SPACE
qp2 = qtf.add_paragraph()
qr = qp2.add_run()
qr.text = "— Commander R. Dodo, Expedition 74"
qr.font.name, qr.font.size, qr.font.color.rgb = BODY, Pt(14), NEBULA
text(s, 8.7, 5.35, 4.1, 0.9, [[("NPS ", {"size": 24, "color": INK}), ("87", {"size": 44, "bold": True, "color": TEAL,
                                                                            "font": HEAD})]], align=PP_ALIGN.CENTER)
footer(s)
notes(s, [
    "Cups per month on the Tea Party Module, January to June 2027: 120 to 980.",
    "Three spills since launch, all during the March solar flare.",
])

# ── 9. Business model ─────────────────────────────────────────────────────────
s = new_slide()
title(s, "Business model: four ways in, and one of them is hats")
data = CategoryChartData()
streams = [("Crew subscriptions", 0.45, ESPRESSO), ("Tourist café", 0.30, NEBULA), ("Unbirthday parties", 0.20, TEAL),
           ("Hats", 0.05, GOLD)]
data.categories = [n for n, _, _ in streams]
data.add_series("Share of revenue", [v for _, v, _ in streams])
gf = s.shapes.add_chart(XL_CHART_TYPE.DOUGHNUT, Inches(0.7), Inches(1.5), Inches(5.6), Inches(5.3), data)
gf.name = "Revenue chart"
ch = gf.chart
style_chart(ch, 16)
ch.has_legend = False
plot = ch.plots[0]
for i, (_, _, color) in enumerate(streams):
    pt = plot.series[0].points[i]
    pt.format.fill.solid()
    pt.format.fill.fore_color.rgb = color
    pt.format.line.color.rgb = CREMA
# The shares are in the list beside it (data labels would repeat them).
ch.has_title = False
hole = ch._chartSpace.find(".//" + qn("c:holeSize"))
if hole is not None:
    hole.set("val", "52")
lines = [
    ("Crew subscriptions — 45%", "Monthly plans for station crews."),
    ("Tourist café — 30%", "A view of Earth and a flat white, at space prices."),
    ("Unbirthday parties — 20%", "364 per guest per year, by definition."),
    ("Hats — 5%", "The Hatter insists."),
]
for i, ((head, body), (_, _, color)) in enumerate(zip(lines, streams)):
    y = 1.85 + i * 1.2
    box(s, 6.8, y + 0.12, 0.32, 0.32, fill=color, shape=MSO_SHAPE.OVAL)
    text(s, 7.3, y, 5.5, 0.5, head, size=20, font=HEAD, bold=True, color=SPACE)
    text(s, 7.3, y + 0.48, 5.5, 0.5, body, size=16)
footer(s)
notes(s, ["Subscriptions are the base; the café carries the margin; unbirthday parties are pure upside."])

# ── 10. Competition ───────────────────────────────────────────────────────────
s = new_slide()
title(s, "Competition: everyone else loses on taste or drinkability")
xy = XyChartData()
# Colors follow the theme's accent order (espresso, nebula, teal, red), so a renderer that colors
# series by theme accent shows the same thing as one that reads the explicit marker fills.
rivals = [("Tang", 2.0, 7.5, ESPRESSO), ("Freeze-dried pouches", 3.5, 6.0, NEBULA), ("Rabbit Hole Roasters", 9.2, 9.3, TEAL),
          ("Earth café delivery (2 days)", 8.0, 1.2, HEART)]
for name, x_, y_, _ in rivals:
    xy.add_series(name).add_data_point(x_, y_)
gf = s.shapes.add_chart(XL_CHART_TYPE.XY_SCATTER, Inches(0.8), Inches(1.5), Inches(8.6), Inches(5.3), xy)
gf.name = "Competition chart"
ch = gf.chart
style_chart(ch)
for ser, (_, _, _, color) in zip(ch.plots[0].series, rivals):
    ser.marker.style = XL_MARKER_STYLE.CIRCLE
    ser.marker.size = 22 if color == TEAL else 16
    ser.marker.format.fill.solid()
    ser.marker.format.fill.fore_color.rgb = color
    ser.marker.format.line.color.rgb = WHITE
    ser.format.line.fill.background()
ch.has_legend = True
ch.legend.position = XL_LEGEND_POSITION.TOP
ch.legend.include_in_layout = False
ch.legend.font.size = Pt(14)
for axis, label in ((ch.category_axis, "Taste →"), (ch.value_axis, "Zero-g drinkability →")):
    axis.minimum_scale, axis.maximum_scale, axis.major_unit = 0, 10, 2
    axis.has_title = True
    axis.axis_title.text_frame.text = label
    for r in axis.axis_title.text_frame.paragraphs[0].runs:
        r.font.size, r.font.bold, r.font.color.rgb = Pt(14), True, NEBULA
    axis.has_major_gridlines = True
    axis.major_gridlines.format.line.color.rgb = RGBColor(0xE2, 0xD6, 0xC2)
    axis.tick_labels.font.size = Pt(11)
text(s, 9.8, 2.0, 3.2, 4.2, [
    [("Tang", {"bold": True}), (" is drinkable, but it's not coffee.", {})],
    [("Pouches", {"bold": True}), (" keep the coffee in, and the joy out.", {})],
    [("Earth delivery", {"bold": True}), (" tastes great and arrives as a sphere.", {})],
    [("Us", {"bold": True, "color": TEAL}), (": top right.", {})],
], size=17, spacing=14)
footer(s)
notes(s, ["Scores are from our own blind tasting panel (n = 4, one of whom is a cat)."])

# ── 11. Roadmap ───────────────────────────────────────────────────────────────
s = new_slide(bg=None)
sky = picture(s, "starfield.jpg", 0, 0, w=13.333)
sky.name = "Starfield"
title(s, "Roadmap: orbit, Moon, Mars", color=WHITE)
bar = box(s, 0.9, 4.05, 11.6, 0.14, shape=MSO_SHAPE.RECTANGLE)
gradient(bar, [(0, TEAL), (1.0, HEART)])
milestones = [
    ("2026", "Tea Party Module café", "Low Earth orbit. Open, serving 980 cups a month.", "planet-earth.png"),
    ("2027", "Drink Me Pod v2", "Shrink-to-fit cups for small astronauts.", "drink-me-pod.png"),
    ("2028", "Mock Turtle Station", "A kiosk on the Moon (0.17 g; crema behaves oddly).", "planet-moon.png"),
    ("2029", "Mars drive-thru", "Delivery in 7 months — still faster than the White Rabbit.", "planet-mars.png"),
]
for i, (year, head, body, img) in enumerate(milestones):
    cx = 1.9 + i * 3.2
    icon = picture(s, img, cx - 0.8, 1.7, h=1.9) if img != "drink-me-pod.png" else picture(s, img, cx - 0.55, 1.55, h=2.2)
    dot = box(s, cx - 0.17, 3.95, 0.34, 0.34, fill=GOLD, shape=MSO_SHAPE.OVAL)
    text(s, cx - 1.45, 4.45, 2.9, 0.6, year, size=30, font=HEAD, bold=True, color=GOLD, align=PP_ALIGN.CENTER)
    text(s, cx - 1.45, 5.05, 2.9, 0.5, head, size=18, bold=True, color=WHITE, align=PP_ALIGN.CENTER)
    text(s, cx - 1.45, 5.5, 2.9, 1.0, body, size=14, color=CREMA, align=PP_ALIGN.CENTER)
footer(s, dark=True)
notes(s, ["Each step reuses the Pod: the same physics works at 0, 0.17 and 0.38 g."])

# ── 12. Risks ─────────────────────────────────────────────────────────────────
s = new_slide()
title(s, "Risks, and why we sleep at night")
risks = [
    ("Regulation", "The Queen chairs the Orbital Beverage Authority. We file early — and make her the Red Velvet.", "queen-card.png"),
    ("Spills", "A loose latte is a hazard. The cup pins the liquid; the brewer stays sealed until the cup docks.", "floating-latte.png"),
    ("Debris", "Jabberwocky-class debris is rare but bad. The café ring is shielded.", "planet-moon.png"),
    ("Time", "The White Rabbit's watch is two days slow (“the best butter”). We use the station clock.", "pocket-watch.png"),
]
for i, (head, body, img) in enumerate(risks):
    x = 0.6 + (i % 2) * 6.2
    y = 1.6 + (i // 2) * 2.65
    card = box(s, x, y, 5.95, 2.4, fill=WHITE, radius=0.08)
    top = box(s, x, y, 5.95, 0.12, fill=HEART, shape=MSO_SHAPE.RECTANGLE)
    pic = picture(s, img, x + 0.25, y + 0.4, h=1.7)
    if pic.width > Inches(1.9):
        pic.width = Inches(1.9)
        pic.height = int(Inches(1.9) * px_size(img)[1] / px_size(img)[0])
    text(s, x + 2.35, y + 0.3, 3.45, 0.5, head, size=22, font=HEAD, bold=True, color=HEART)
    text(s, x + 2.35, y + 0.82, 3.45, 1.5, body, size=15)
footer(s)
notes(s, [
    [("Regulation is the real one. ", True), ("Everything else has an engineering answer.", False)],
])

# ── 13. The ask ───────────────────────────────────────────────────────────────
s = new_slide()
title(s, "The ask: $12M Series Tea")
text(s, 0.6, 1.7, 4.8, 1.6, "$12M", size=110, font=HEAD, bold=True, color=ESPRESSO)
text(s, 0.7, 3.35, 4.6, 1.2, "to take the Drink Me Pod from orbit to the Moon.", size=22)
peek = picture(s, "coffee-planet.png", 0.9, 4.6, w=3.6)
peek.crop_bottom = 0.45
peek.height = int(peek.height * 0.55)
peek.top = SH - peek.height - Inches(0.45)
peek.name = "Peeking cup (cropped)"
data = CategoryChartData()
uses = [("Drink Me Pod R&D", 40), ("Orbital café build-out", 30), ("Moon kiosk", 20), ("Hats", 10)]
data.categories = [u for u, _ in uses]
data.add_series("Use of funds (%)", [v for _, v in uses])
gf = s.shapes.add_chart(XL_CHART_TYPE.BAR_CLUSTERED, Inches(5.6), Inches(1.6), Inches(7.2), Inches(5.0), data)
gf.name = "Use of funds chart"
ch = gf.chart
style_chart(ch, 16)
ch.has_legend = False
ch.has_title = True
ch.chart_title.text_frame.text = "Use of funds (%)"
for r in ch.chart_title.text_frame.paragraphs[0].runs:
    r.font.size, r.font.bold, r.font.color.rgb = Pt(18), True, NEBULA
plot = ch.plots[0]
plot.gap_width = 55
plot.has_data_labels = True
plot.data_labels.number_format = '0"%"'
plot.data_labels.number_format_is_linked = False
plot.data_labels.font.bold = True
for i, color in enumerate((ESPRESSO, NEBULA, TEAL, GOLD)):
    pt = plot.series[0].points[i]
    pt.format.fill.solid()
    pt.format.fill.fore_color.rgb = color
ch.category_axis.reverse_order = True
ch.value_axis.visible = False
ch.value_axis.has_major_gridlines = False
footer(s)
notes(s, ["$12M: 18 months of runway, the Pod v2, and the Moon kiosk. The hats are non-negotiable."])

# ── 14. Closing ───────────────────────────────────────────────────────────────
s = prs.slides.add_slide(L_TITLE_ONLY)
background_picture(s, "starfield.jpg")
title(s, "We're late, we're late — for a very important launch", color=WHITE, size=40, y=0.7, h=1.8, w=7.6)
text(s, 0.65, 2.8, 7.2, 1.2, "Join us before the launch window closes.", size=26, font=HEAD, italic=True, color=CREMA)
mail = text(s, 0.65, 3.9, 7.2, 0.6, [[("alice@rabbitholeroasters.example", {"color": GOLD, "bold": True})]], size=22)
mail.text_frame.paragraphs[0].runs[0].hyperlink.address = "mailto:alice@rabbitholeroasters.example"
text(s, 0.65, 4.6, 7.2, 0.6, "Thank you  ·  ありがとう  ·  Спасибо  ·  شكرا", size=20, color=RGBColor(0xB8, 0xB0, 0xD8))
picture(s, "pocket-watch.png", 8.4, 0.6, h=6.3)
picture(s, "portrait-white-rabbit.png", 0.7, 5.35, w=1.6)
text(s, 2.45, 5.75, 5.0, 0.8, "The White Rabbit, already running.", size=16, italic=True, color=CREMA)
transition(s, "fade")
notes(s, [
    "Thank you. Questions — quickly, the White Rabbit has a launch to catch.",
    [("Contact: ", True), ("alice@rabbitholeroasters.example", False)],
])

prs.save(str(DECK))
print("deck", DECK.name, f"({len(prs.slides)} slides, {DECK.stat().st_size // 1024} KB)")
