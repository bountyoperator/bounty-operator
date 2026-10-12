# Spec: a bug with standards

Spec is Bounty Operator's mascot: a sceptical coral clay bug, with bent antennae,
ivory eyes, a blue work jacket and a brass magnifying glass. He questions a
claim; the review supplies the evidence. He is a character, not another model
or a guarantee that a finding will earn a bounty.

## Shared identity

- Coral `#f16343`: Spec's shell and primary actions.
- Cream `#f6e7cc`: paper, portrait ground and display text.
- Charcoal `#18232d`: the page and the film's ink.
- Jacket blue `#284b73`: supporting colour and the icon's jacket.
- Archivo: headings, buttons and film titles. System text for longer reading;
  monospace for source, references and typed evidence.

Use the original portrait for the homepage and social preview. The small SVG
mark simplifies his antennae, eyes, shell and jacket for navigation and browser
icons. Its geometry lives in `web/site/components.mjs`; `scripts/build-icons.mjs`
produces the SVG, favicon and home-screen icons from it.

Keep the product language direct: review the report, question its claims, cite
the code and proof. The public example is an invented protocol. Existing
severity colours retain their meaning; they are not mascot decoration.

Spec carries the personality. Keep headlines plain, evidence aligned, and
motion tied to an interaction. Do not add hand-drawn circles, decorative
tickers, floating paper stacks or animated glows around him. Give the mascot
room; keep supporting figures quieter than the product promise. The footer
uses the shared mark and useful navigation, without a second giant wordmark.
Supporting page headings use the same plain charcoal background; decorative
code and random red marks do not sit behind their text.

Carry that restraint through the whole product: 32–44px page headings,
sentence-case labels, readable verdict text, neutral pricing panels and one
consistent set of rounded corners. Badges use transparent fills to retain
contrast. Keep the active navigation understated, empty results explicit,
and section links available on phones. Check populated tools and source
dialogs at 320px as well as the page introduction.

## Assets and provenance

The original portrait was created for Bounty Operator on 12 October 2026,
Higgsfield generation `16476ac4-a930-4141-87ab-f9faf10fe6a8`. The approved
20-second film is `963271e7-23f3-4112-82f8-9c901a4fe449`, with the same character,
Archivo, Cillian narration and an original instrumental score. The film's
SHA-256 is `103099e453c5c4cc74e9e223c8aa76c6f79b1d8adceedb12ce739663e2afa5d6`.

`web/public/brand/spec-640.webp` and `spec-960.webp` are proportional WebP
encodings of that portrait, with no crop or character edits. To rebuild them,
run `node scripts/prepare-spec-media.mjs /path/to/spec-mascot.png` using the
original portrait delivered with the film. `web/public/videos/spec-intro.mp4`
is the approved film unchanged; its poster is an extracted frame. Captions and
a visible transcript accompany it. Native controls require a visitor to play
it; there is no autoplay, remote embed or extra player library.

`web/site/social/card.mjs` and `social.css` are the editable 1200 by 630 preview
layout. Its export is `web/public/social-spec-v2.png`; the versioned path lets
new link previews pick up the new identity without changing previous shares.
