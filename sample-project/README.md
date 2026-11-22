# Sample project: Rabbit Hole Roasters

A small, made-up project for trying Deck Edit: Alice (yes, that Alice) is raising money for a coffee
company in orbit. Open this folder as a project in Deck Edit to see how decks, documents, notes and
the agent work together.

## What's here

| File | What it is |
|------|------------|
| `Rabbit Hole Roasters — Investor Deck.pptx` | The 14-slide deck: illustrations, charts, a table, speaker notes, click-by-click builds |
| `Outline.md` | The outline the deck was built from, and the numbers it uses |
| `Company Background.md` | The company, team, products and risks — background for the agent and for you |
| `Brand & Voice.md` | Colors, fonts and tone, so new slides match |
| `Zero-G Brewing — Technical Design.pdf` | How the Drink Me Pod brews and holds coffee without gravity |
| `Zero-G Brewing — Supplementary Figures.pdf` | Four charts backing the technical design |
| `images/` | The illustrations used in the deck, to drop onto new slides |
| `generator/` | The scripts that first built the deck, PDFs and images (see below) |

## Things to try

1. **Open the deck.** Click through the slides; the speaker notes are under each slide.
2. **Edit a slide.** Change a title, move a picture, resize the chart. (The first edit asks whether
   Deck Edit may auto-save files here — choose OK, or Disable Edit to keep the project read-only.)
3. **Leave a note for the AI.** Use *AI Note* to pin a remark on a slide ("make this chart
   horizontal"), then ask the agent to address your notes.
4. **Ask the agent things**, for example:
   - "Which slides mention the Queen of Hearts?" — the answer links to each slide.
   - "Check the deck against Outline.md and list anything that doesn't match."
   - "Add a slide after slide 8 with a customer quote, in the deck's style."
   - "Summarize the technical design PDF in three bullets for slide 5's notes."
5. **Read the PDF** and pin a note on a figure.

Everything is fictional. The characters are from Lewis Carroll's *Alice's Adventures in Wonderland*
(public domain); the physics is real.

---

### For developers

This folder doubles as a consistent test and evaluation project (the frontend's round-trip test runs
on its deck). The deck, the PDFs and `images/` were first built by the scripts in `generator/`
(`art/` holds the illustrations as SVG, `build.mjs` renders them and the PDFs with headless Chrome,
`make_deck.py` builds the deck with python-pptx). From there on the files themselves are what counts:
edit the deck directly, in Deck Edit or elsewhere.

To rebuild everything from scratch instead — this **replaces** the deck, the PDFs and the images, so
any edits made to them are lost:

```
cd sample-project/generator
npm install                     # once: puppeteer-core (uses your installed Chrome)
node build.mjs                  # images/ and the two PDFs
python3 make_deck.py            # the deck (needs python-pptx and Pillow)
```

The deck deliberately covers what real decks contain: a 16:9 master with layouts and
placeholders, theme fonts and colors, native bar/line/pie/scatter charts, a table with merged cells,
grouped, rotated and gradient-filled shapes, connectors, PNG (with transparency), JPEG and SVG
pictures (SVG with a PNG fallback), a cropped picture, a background picture, hyperlinks, slide-number
fields, rich speaker notes, click-by-click builds (animations) and slide transitions.
