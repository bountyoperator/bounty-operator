---
name: Bounty Operator
description: "Spec, a bug with standards. Charcoal, cream, coral and a blue work jacket connect the film, website and shared mark. Evidence stays readable on paper."
colors:
  # The page: the one palette of the site (:root and .theme-dark)
  bg: "#18232d"
  surface: "#202d38"
  surface-2: "#273642"
  surface-3: "#30424e"
  line: "#344550"
  line-strong: "#52616c"
  line-control: "#98a3ad"
  rule: "#52616c"
  text: "#f6e7cc"
  muted: "#bcc3c4"
  placeholder: "#aab4bb"
  field: "#18232d"
  on-field: "#f6e7cc"
  on-field-muted: "#bcc3c4"
  field-rule: "#344550"
  stock: "#f16343"
  on-stock: "#09090a"
  on-stock-muted: "#3d0f04"
  copy: "#2a2a2f"
  accent: "#ff987f"
  accent-hover: "#ffb5a2"
  accent-solid: "#f16343"
  accent-solid-hover: "#ff8063"
  on-accent: "#09090a"
  focus: "#f4f1ea"
  heat: "linear-gradient(100deg, #ff2d2d 0%, #ff5a1f 46%, #ffb224 100%)"
  observed: "#6fd39b"
  gap: "#f2c552"
  gap-bg: "#f2c5521f"
  sev-crit: "#ff899b"
  sev-high: "#ff9d5c"
  sev-med: "#f2c552"
  sev-low: "#6fd39b"
  sev-info: "#8fb2ff"
  sev-none: "#b3b1bc"
  ok: "#6fd39b"
  danger: "#ff899b"
  code-bg: "#111b24"
  code-text: "#ebe8e1"
  code-muted: "#aab4bb"
  code-line: "#30424e"
  code-hl: "#ff6a4d"
  code-flag: "#f2c552"
  code-ok: "#6fd39b"
  brand-tile: "#f6e7cc"
  brand-glyph: "#18232d"
  brand-slash: "#f6e7cc"
  # Paper: a sheet lying on the page (.theme-light). Only the tokens whose value differs.
  bg-paper: "#f4f1ea"
  surface-paper: "#fbfaf6"
  surface-2-paper: "#ebe8df"
  surface-3-paper: "#ffffff"
  line-paper: "#d6d3c9"
  line-strong-paper: "#a5a299"
  line-control-paper: "#76746c"
  rule-paper: "#121214"
  text-paper: "#121214"
  muted-paper: "#57554f"
  accent-paper: "#c2280f"
  accent-hover-paper: "#981c08"
  accent-solid-paper: "#121214"
  accent-solid-hover-paper: "#c2280f"
  on-accent-paper: "#ffffff"
  focus-paper: "#c2280f"
  observed-paper: "#1b6b3a"
  gap-paper: "#855a00"
  sev-crit-paper: "#b0172f"
  sev-high-paper: "#ad4508"
  sev-med-paper: "#855a00"
typography:
  display:
    fontFamily: "Archivo, 'Archivo fallback', system-ui, sans-serif"
    fontSize: "clamp(2.375rem, 1.15rem + 4.9vw, 4.5rem)"
    fontWeight: 820
    lineHeight: 1.02
    letterSpacing: "-0.022em"
    fontVariation: "'wdth' 110"
  headline-page:
    fontFamily: "Archivo, 'Archivo fallback', system-ui, sans-serif"
    fontSize: "clamp(2rem, 1.4rem + 2vw, 2.75rem)"
    fontWeight: 760
    lineHeight: 1.12
    letterSpacing: "-0.024em"
    fontVariation: "'wdth' 100"
  headline-section:
    fontFamily: "Archivo, 'Archivo fallback', system-ui, sans-serif"
    fontSize: "clamp(1.5rem, 1.1rem + 1.3vw, 2rem)"
    fontWeight: 740
    lineHeight: 1.2
    letterSpacing: "-0.021em"
    fontVariation: "'wdth' 100"
  title:
    fontFamily: "Archivo, 'Archivo fallback', system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 760
    lineHeight: 1.18
    letterSpacing: "-0.012em"
    fontVariation: "'wdth' 100"
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  lede:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Archivo, 'Archivo fallback', system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "0"
    fontVariation: "'wdth' 100"
  button:
    fontFamily: "Archivo, 'Archivo fallback', system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 700
    fontVariation: "'wdth' 90"
  verdict:
    fontFamily: "Archivo, 'Archivo fallback', system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    letterSpacing: "0"
    fontVariation: "'wdth' 100"
  code:
    fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Mono', 'Cascadia Code', Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
    lineHeight: 1.7
rounded:
  chip: "4px"
  control: "6px"
  card: "10px"
  hero: "12px"
spacing:
  base: "4px"
  steps: "4, 8, 12, 16, 24, 32, 48, 72, 112"
  wrap: "75rem"
  tap: "2.75rem"
motion:
  ease: "cubic-bezier(0.2, 0.8, 0.2, 1)"
  ease-out: "cubic-bezier(0.16, 1, 0.3, 1)"
  fast: "120ms"
  panel: "180ms"
  dialog: "160ms"
---

# Design System: Bounty Operator

## Overview

Spec is a bug with standards. The original clay character introduces Bounty Operator's habit of questioning a claim and following the code and proof before submission. The homepage and social preview use his approved portrait; the shared header, footer and browser icons use a small vector interpretation of the same character.

The film's charcoal ink, cream paper, coral shell and blue jacket define the palette. Archivo is shared with the film. The character carries the personality while the report, citations, verdicts and review controls stay factual and readable. Headlines stay plain: no circled words, scrolling decorative verdicts, animated glows or floating paper stacks. See [Spec's brand guide](docs/spec-brand.md) for the artwork, provenance and rebuild paths.

The home hero gives the product promise, "Make your strongest case before you submit.", and review actions room beside Spec. Supporting copy: "Check your proof, make the impact explicit, and catch missing evidence before the triager has to ask." The leading saved example is Halyard: an explicitly invented protocol with a confirmed Critical finding, opened by `/?start=example&example=confirmed-critical#workspace`. The real workbench follows. After it, one collapsed supporting disclosure groups the unchanged 20-second Spec film and 54-second Tessera walkthrough, clearly paired with the Tessera example, native controls, captions and transcripts. Supporting pages use a plain charcoal heading area; the workbench keeps its existing interaction and evidence flow.

There is one look. Nothing follows the system's colour scheme, and there is no theme to choose.

## Colors

Every colour is a token in `web/public/css/base.css` section 1. `:root` and `.theme-dark` hold the page palette. `.theme-light` holds the matching paper tokens used by the saved example and landing pages. The four `--spec-*` tokens define the shared mascot colours independently of semantic severity colours.

### The page
- **Charcoal** (`#18232d`): the page, the field and the footer.
- **Surfaces** (`#202d38`, `#273642`, `#30424e`): cards, inputs and supporting panels.
- **Cream** (`#f6e7cc`): running print and headings. **Muted** (`#bcc3c4`) is secondary print.
- **Rules** (`#52616c` frames, `#344550` hairlines, `#98a3ad` control borders). Controls remain at least 3:1 against the surfaces.

### The hot ink
- **Coral** (`#f16343`): primary actions and the current review step. The paid plan uses a coral border on a neutral panel. The Spec mark sits on cream.
- **Coral for small text** (`#ff987f`, hover `#ffb5a2`): links with sufficient contrast against the charcoal surfaces.
- **Heat** (`linear-gradient(100deg, #ff2d2d, #ff5a1f 46%, #ffb224)`): the bars of the benchmark strip. It is never the colour of a sentence.

### Standing
- **Observed Green** (`#6fd39b`): what the code shows. Confirmed, pass, proven, resolved.
- **Ochre** (`#f2c552`): unproven. Overstated, not supplied, an open objection.
- **Rose Red** (`#ff899b`): critical, contradicted, failed. It stays distinct from the coral action colour.
- **Severity:** critical `#ff899b`, high `#ff9d5c`, medium `#f2c552`, low `#6fd39b`, info `#8fb2ff`, unrated `#b3b1bc`.

### Paper
Paper is `#fbfaf6` on `#f4f1ea`, printed in `#121214`, with the pen in `#c2280f`. On paper the solid action is black with white letters, and observed, unproven and critical print in `#1b6b3a`, `#855a00` and `#b0172f`.

### Named Rules
**The One Action Colour Rule.** Coral marks actions and relevant review annotations. Green, ochre and rose red carry review meaning, not mascot decoration.

**The Heat Is For Bars Rule.** The gradient is confined to benchmark bars. Figures and text remain cream or muted cream.

## Typography

One webfont, self-hosted: Archivo as a variable file, width 62 to 125 and weight 100 to 900. Running text is the system sans, so it renders before the font arrives. Mono is for code, paths, references, hashes, model ids and typed entries, never for labels.

### Hierarchy
- **Display** (820, `clamp(2.375rem, 1.15rem + 4.9vw, 4.5rem)`, width 110%, -0.022em, line 1.02): the home headline.
- **Page head** (760, 32–44px, width 100%, line 1.12): supporting-page h1s.
- **Section head** (740, 24–32px, width 100%, line 1.2): h2s.
- **Title** (760, 22px, width 100%): h3, card and finding titles.
- **Figure:** supporting results remain subordinate to the headline; plan prices are 40px at weight 650, tool scores 40px at weight 700, and compact statistics 28px at weight 700.
- **Body** (system sans, 16px, line 1.6) and **Lede** (18px, line 1.55, muted bone).
- **Label** (650, 13px, width 100%, sentence case): margin captions, column heads and breadcrumbs.
- **Button** (700, 15px, width 90%).
- **Verdict** (700, 18px, width 100%, sentence case): a readable decision label with a single outline. Supporting severity badges use 14px live text.
- **Code** (mono, 13px, line 1.7, ligatures off).

### Named Rules
**The Reading Hierarchy Rule.** The homepage promise has the strongest display treatment. Supporting headings and labels use normal-width type, so navigation, form controls and evidence remain easy to scan.

**The Font Does Not Move The Page Rule.** Until Archivo arrives, a headline prints in a local face sized to the same advance: Arial Narrow Bold for the condensed bands, Arial Bold for the regular width, Arial Black for the wide cuts. Measures that depend on a cut are written in em.

## Motion

Everything that moves is cheap by construction, and all of it runs only while the page's motion is on. `<html>` carries `data-motion="on"` or `"off"`, set by `theme.js` before the first paint: on unless the visitor's system asks for less motion, and the visitor's own choice wins over the system. The foot of every page has the button, Pause motion or Play motion. A choice that differs from the system is remembered in the browser.

- **Feedback.** Step panels, dialogs and newly rendered findings retain brief entrance transitions. Progress indicators show work in progress. The example's strike through the overclaimed severity may draw in, but badges stay still.
- **Reading.** Sections are visible immediately. There are no scroll-driven entrances, landing stamps or animated heading backgrounds.
- **Controls.** Colour and border change in 120ms and a pressed button sinks 1px. Primary buttons do not glow.

### Named Rules
**The Nothing Per Frame Rule.** A background is drawn once and moved by a transform or an opacity, which the browser animates off the main thread. Scrolling and typing never wait on decoration.

**The Still State Rule.** Every decorative animation rule is keyed on `:root[data-motion="on"]`; no stylesheet asks the system directly. With motion off, `:root:not([data-motion="on"])` removes animations and transitions. Content remains complete and readable. Working indicators also have a still state.

## Layout

The page is a stack of forms in one centred column. The wrap holds 75rem of content inside a fluid gutter; long-form pages narrow it to 46rem and wide views open it to 86rem. Spacing steps on a 4px base (4, 8, 12, 16, 24, 32, 48, 72, 112).

Supporting pages open on a plain charcoal heading area directly under the header. The content keeps to the shared wrap.

Every page but the home page uses the same head: the trail on a page two levels down, the h1, the lede, then the page's own line or actions. Its rhythm is set once: 48px above (32 on a phone), 24px below, 16px between parts, and 24px above the lede and actions. Headings use an 18em maximum measure. Closing calls to action use a flat panel, a section heading and the shared buttons.

The home page pairs the product promise and review actions with Spec's portrait. The flat saved Halyard report follows it, showing what evidence supports the finding, then the real workbench. The unchanged Spec film and Tessera walkthrough sit together in one collapsed supporting disclosure after the workbench, not as the lead proof. On a phone, the introduction and actions precede the portrait. Decorative headline rings, floating paper stacks and the verdict ticker are retired.

Forms are ledgers. The finding card and the workbench sheet print a 9.75rem caption margin, one 1px rule and the content to its right, and under 704px the caption moves above its content. Grids of cells are ruled by 1px gaps over the hairline ground inside a 1px frame, like the rack of verdict stamps.

The header keeps the brand at left and the nav and account control at right. Under 928px the nav becomes a second row with every link on screen: one row from 384px, two even rows of three below that, and a wrapped row for enlarged text. Under 640px, where scripts run, the header is one row instead: the brand, the account control and Menu, a 44px button with the menu icon (an X while open). Menu opens the links under the row as a ruled list, one link a row, and moves focus to the first; Menu again, Escape or a chosen link closes it. Without scripts a phone keeps the second row. Nothing scrolls sideways. The footer uses the shared Spec mark, the product promise and useful navigation, without a second oversized wordmark.

Print is black on white whatever the screen shows: deeper inks, flat cards and panels, no header, footer, field or buttons, code wrapped.

### Named Rules
**The Part Rule.** Shared rules are 1px. Spacing and type establish the hierarchy. The home hero alone carries a short kicker naming the tool's purpose.

**The Field Opens The Page Rule.** Every page head stands on the field, full width, directly under the header rule.

**The One Head Rule.** The page head and the closing band are each built and styled in one place. A page places what follows its head and what stands above its band; it never restates either, and never prints the band on vermilion.

## Elevation & Depth

Depth comes from light on black. The page is flat, cards cast nothing at rest (`--shadow-card` is none), and what lies above the page is lit: a dialog over a backdrop of black at 78%. The saved report stays flat and aligned.

### Shadow Vocabulary
- **Cards, tool panels and report sheets:** no decorative shadow.
- **Pop** (`0 2px 6px #00000080, 0 28px 64px -20px #000000e6`): dialogs.

### Named Rules
**The Overlay Rule.** Reserve depth for dialogs over a backdrop. A panel does not need a shadow to establish its boundary.

## Shapes

Use 4px badge corners, 6px control corners, 10px card corners and 12px hero or dialog corners. Keep panels aligned. Circles are functional marks such as status dots, radio buttons and spinners; controls do not become pills.

**The Dashed Means Blank Rule.** A dashed line is a field left blank or a sheet that is not real: an unrated severity, Hold: duplicate, unsupplied code, an evidence gap, the frame around invented output. It is never decoration.

## Components

Markup, helper signatures and every variant are in `web/site/COMPONENTS.md`, and a dev build renders them all at `/_kit`. This section records how each one looks and behaves.

### Buttons
- **Shape:** 6px corners, a 1.5px border, 44px minimum height; small is 36px and grows to 44px on touch, large is 52px.
- **Primary:** coral with dark text, brightening on hover. On paper and coral stock it is black. No halo or shadow.
- **Secondary:** a transparent box with a 1.5px rule. Under the pointer it fills with bone and its letters turn black.
- **Quiet / Danger:** quiet has no box and takes an 8% tint on hover; danger is a rose-red outline that fills on hover.
- **States:** disabled sits at 50% opacity; a running button shows a spinner and keeps its label. Focus is a 2px bone ring 2px outside.
- **Links:** vermilion with a half-strength 1px underline that turns full strength on hover.

### Chips
Badges use a 1.5px semantic outline, live sentence-case text, a transparent background, 4px corners and a 24px minimum height. The transparent fill preserves contrast on all shared surfaces. Tones are observed, unproven, ok, danger and neutral. File references and hashes use mono in a ruled box.

### Verdicts
Large verdicts use readable 18px live text and a single 1px outline. They wrap when needed, without tilt, image masks or entrance stamping. The old stamp assets and builder remain for compatibility; new UI does not use them.

### Cards / Containers
A panel uses 10px corners, a 1px frame and hairlines between head, body and foot, without a shadow. Avoid unnecessary nested cards. The dossier at the head of a result holds the verdict, headline and counts under its 4px top rule. Under 480px the counts use two rows: the three severities, then Hardening and Checked safe.

### Inputs / Fields
A surface box with a 1px control border, 6px corners and 44px minimum height. Text becomes 16px under 768px so phones do not zoom. Keep help visible under the control. The report checker distinguishes an empty form from a checked report with zero passing checks.

### Navigation
- **Header:** the brand at left, nav and account control at right, a rule under it. On a phone: the brand, the account control and Menu.
- **Account control:** Sign up in a new browser, Sign in in one that has signed in before, and the plan chip with Account once signed in.
- **Links:** 44px targets. The current page uses coral text and an underline.
- **Brand mark:** Spec's bent antennae, sceptical eyes, coral shell and blue jacket on a cream tile. `scripts/build-icons.mjs` draws the icons from the same paths as the header.
- **Footer:** the shared mark, promise, primary action and useful navigation in sentence case.
- **Tabs, stepper, segmented control:** the open tab joins the sheet under it. The current step of the stepper and the chosen segment are vermilion with black print; done steps carry a solid marker.

### Code Blocks
Deep charcoal (`#111b24`) inside a ruled frame with 6px corners. Mono at 13px and 1.7 with ligatures off; line numbers come from data, stay in a sticky gutter and never copy. A marked line takes a coral tint and a gutter mark; an unproven line uses ochre.

### Tables
A 1px frame, sentence-case column heads, hairlines between rows and tabular figures aligned right. Stack tables become labelled blocks on narrow screens. Wide tables scroll inside their frame. The comparison table keeps its row label and one complete option visible even at 320px; size columns from the container, not the viewport.

### Dialog
A sheet over the page: a 1px frame, 12px corners and the pop shadow over a backdrop. Its head stays visible while the body scrolls. Widths are 440, 640 and 900px, constrained by the viewport. A new browser sees account creation first, whatever opened the dialog (the header’s Sign up, a first review, an upgrade, the /mcp token); billing and a browser that has signed in before open on Sign in.

### Finding Card
The result as an inspection form: a file bar, finding id, severity, status, title and source references, then rows with sentence-case captions in a 9.75rem margin. Observed is green; Counterargument is ochre while open and green when resolved; Evidence gap is ochre with a dashed margin rule. Numbered path steps preserve the draft's numbering. See `web/site/COMPONENTS.md` for the markup.

### Report Slip
The saved examples are built by `reportSlip()` in `web/site/social/example.mjs`. Each is a flat, aligned document on paper (`.theme-light`), with no tilted copy or decorative shadow. Lead with Halyard's confirmed Critical finding: show the draft's typed title in mono, the claimed and supported severity, the review's headline, the cited source and the verdict beside its date and model. Strike through a claimed severity only when that saved review actually changes it, as in Tessera's separate film example. Do not rewrite saved review text to fit the positioning. On a phone the slip leads with the claim, stamps and verdict. The homepage hero and share image use Spec's original portrait.

### Figures and bars
- **The three results** (`.home-stats`): a cream figure over a muted caption, subordinate to the main heading, the whole item a link to the leaderboard it comes from.
- **Score bars** (`.bench-teaser__bar`): an inline SVG 4px tall on the heat, with the rest of the track covering it from the score to 100. It is an SVG because the page's own policy refuses a style attribute.

## Do's and Don'ts

### Do:
- **Do** take every colour, size, radius and duration from the tokens in `web/public/css/base.css` section 1. A new colour goes into both palettes, the page and paper, and a test keeps their token names the same.
- **Do** use the shared page head, section spacing and 1px rules.
- **Do** keep vermilion for the pen and the action, and carry standing in green, ochre and rose red.
- **Do** reserve the strongest display treatment for the homepage promise; use normal-width sentence-case labels elsewhere.
- **Do** render verdicts and severities as readable live text with semantic outlines.
- **Do** put invented output in a dashed frame labelled Example.
- **Do** keep every touch target at 44px, except a file reference inside a sentence, which keeps the height of its line (25px); keep every text at 12px or more, and form controls at 16px under 768px.
- **Do** give every motion a still state, key it on `:root[data-motion="on"]`, and move it by a transform or an opacity.

### Don't:
- **Don't** add a second hot colour, a second gradient, or a gradient on text that has to be read.
- **Don't** redraw a canvas on a frame loop, animate a mask or a filter, or fade a group that holds a moving layer.
- **Don't** mark status with a coloured stripe on the edge of a card, ledger row, tab or list item; the ink of the caption carries it.
- **Don't** set captions, column heads or buttons in mono, or add a second display face; Archivo is the one webfont, and it is self-hosted.
- **Don't** invent corner radii or make controls into pills; use the shared 4/6/10/12px tokens.
- **Don't** shadow a resting card, row or table, or lift anything on hover.
- **Don't** add distressed stamps, texture overlays, animated decoration or gratuitous arrows to ordinary action labels.
- **Don't** add a hex value outside the token blocks, an inline style, or a font or image from another origin; the CSP blocks them and the build fails.
- **Don't** nest cards, or hide help in a tooltip.
