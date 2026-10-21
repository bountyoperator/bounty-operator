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

Lead with "Make your strongest case before you submit." Supporting copy:
"Check your proof, make the impact explicit, and catch missing evidence before the triager has to ask."
Keep the product language direct: check claims and counterarguments against the
code and proof, confirm supported findings, and identify missing evidence.
Adversarial review is not a promise to lower severity or invent objections.
It does not guarantee acceptance or a payout, or change the review instructions.
Existing severity colours retain their meaning; they are not mascot decoration.

After the hero, lead with the saved Halyard example: an explicitly invented
protocol with a confirmed Critical finding. Its named link is
`/?start=example&example=confirmed-critical#workspace`. The real workbench
follows. Keep both saved reviews unchanged.
Group the unchanged Spec film and 54-second Tessera walkthrough in one
collapsed supporting disclosure after the workbench. They must remain paired
with the Tessera example they demonstrate, including `/?start=example#workspace`
from the published introduction on X.

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

`web/site/social/card.mjs` generates `card.html`; these and `social.css` define
the editable 1200 by 630 preview layout. Run `node web/site/social/render.mjs`
to render `web/public/social-spec-v3.png`. This card pairs the approved headline
and supporting copy with Spec's original portrait. The versioned path gives
new link previews the current positioning. Preserve `social-spec-v2.png` for
existing shares, including the published X introduction.

### Strongest-case replacement film

The 18-second replacement master created on 21 October 2026 leads with making
a stronger submission, then shows the unchanged saved Halyard review and its
source evidence. Halyard is explicitly an invented protocol; the attack needs
one valid owner signature. The film does not imply a real bounty, acceptance
or payout.

It reuses Higgsfield's Spec animation
`abf19021-fbd9-4bde-9383-5eba8dbb3d88` with new Cillian narration from
ElevenLabs v3 through Higgsfield, generation
`ed3770b5-cb5e-42da-9ed7-725040b8fedd`. The final composition is rendered locally,
not a new Higgsfield video generation.

The input bundle and master are in `.local/spec-strongest-case-20261021/`.
Rebuild with
`node scripts/render-spec-film.mjs .local/spec-strongest-case-20261021`.
The renderer needs `spec-source.mp4`, `narration.mp3` and `review-capture.png`,
plus the same global Playwright/Chromium setup as the social-card renderer and
FFmpeg. It writes the MP4, a poster, and timed VTT/SRT captions. Rendering does
not upload, publish, buy credits or replace existing website assets or posts.
The bundle's `provenance.json` records the source URLs and checksums.

The verified master is 1080 by 1080 at 30 fps, with H.264 video and AAC audio.
Its SHA-256 is
`64dd5764cf1528e24ddbf8d8774459f79669a31f31c07053d93182723e82d773`.

Published on 21 October 2026 as a new `@BountyOperator` post,
<https://x.com/BountyOperator/status/2112745508603330779>. Its link opens
`/?start=example&example=confirmed-critical#workspace`. X's optional
Made with AI label is off.
The pinned introduction, the earlier Spec post and the website's films are
unchanged.

