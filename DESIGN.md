---
name: Bounty Operator
description: "A black page, bone-white print and one hot ink. The report is paper lying on the page, the red pen has been through it, and the verdict is stamped on it."
colors:
  # The page: the one palette of the site (:root and .theme-dark)
  bg: "#09090a"
  surface: "#121214"
  surface-2: "#19191c"
  surface-3: "#232327"
  line: "#26262b"
  line-strong: "#43434b"
  line-control: "#7c7c86"
  rule: "#3a3a41"
  text: "#f4f1ea"
  muted: "#a9a69e"
  placeholder: "#8b8982"
  field: "#09090a"
  on-field: "#f4f1ea"
  on-field-muted: "#a9a69e"
  field-rule: "#26262b"
  stock: "#ff4d2e"
  on-stock: "#09090a"
  on-stock-muted: "#3d0f04"
  copy: "#2a2a2f"
  accent: "#ff6a4d"
  accent-hover: "#ff8f78"
  accent-solid: "#ff4d2e"
  accent-solid-hover: "#ff6a4d"
  on-accent: "#09090a"
  focus: "#f4f1ea"
  heat: "linear-gradient(100deg, #ff2d2d 0%, #ff5a1f 46%, #ffb224 100%)"
  observed: "#6fd39b"
  gap: "#f2c552"
  gap-bg: "#f2c5521f"
  sev-crit: "#ff5d7a"
  sev-high: "#ff9d5c"
  sev-med: "#f2c552"
  sev-low: "#6fd39b"
  sev-info: "#8fb2ff"
  sev-none: "#a5a3ad"
  ok: "#6fd39b"
  danger: "#ff5d7a"
  code-bg: "#0e0e10"
  code-text: "#ebe8e1"
  code-muted: "#8a8880"
  code-line: "#232327"
  code-hl: "#ff6a4d"
  code-flag: "#f2c552"
  code-ok: "#6fd39b"
  brand-tile: "#ff4d2e"
  brand-glyph: "#09090a"
  brand-slash: "#f4f1ea"
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
    fontSize: "clamp(2rem, 1.25rem + 3vw, 3.5rem)"
    fontWeight: 820
    lineHeight: 1.03
    letterSpacing: "-0.024em"
    fontVariation: "'wdth' 108"
  headline-section:
    fontFamily: "Archivo, 'Archivo fallback', system-ui, sans-serif"
    fontSize: "clamp(1.625rem, 1.2rem + 1.7vw, 2.5rem)"
    fontWeight: 810
    lineHeight: 1.07
    letterSpacing: "-0.021em"
    fontVariation: "'wdth' 106"
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
    fontSize: "0.75rem"
    fontWeight: 680
    lineHeight: 1.4
    letterSpacing: "0.07em"
    fontVariation: "'wdth' 85"
  button:
    fontFamily: "Archivo, 'Archivo fallback', system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 700
    fontVariation: "'wdth' 90"
  stamp:
    fontFamily: "Archivo, 'Archivo fallback', system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 860
    letterSpacing: "0.1em"
    fontVariation: "'wdth' 68"
  code:
    fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Mono', 'Cascadia Code', Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
    lineHeight: 1.7
rounded:
  chip: "2px"
  control: "2px"
  card: "2px"
  hero: "3px"
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
  stamp: "420ms"
  field-drift: "64s linear, one loop"
  verdict-run: "52s linear, one loop"
  ember: "9s ease-in-out, alternating"
  pen-ring: "900ms cubic-bezier(0.6, 0, 0.2, 1), once, after 500ms"
---

# Design System: Bounty Operator

## Overview

A finding goes through inspection before a triager sees it. The site shows that inspection: a report lying on a black page, marked by a red pen, with the verdict stamped on it.

The page is black and its print is bone white. One hot ink does all the marking: vermilion, the red of a seal and of a marking pen. It is the action button, the links, the ring around two words of the headline, the strike through a line. The report is paper: a bright sheet lying on the page, in black print, with real stamp ink on it.

Behind the head of every page lie lines of a draft report and of the code it cites, set small. Lights drift over them and now and then the pen strikes a line. Under the home hero the builder's three results stand as large figures in the heat of the ink, and the five verdicts run past.

There is one look. Nothing follows the system's colour scheme, and there is no theme to choose.

## Colors

Every colour is a token in `web/public/css/base.css` section 1. `:root` and `.theme-dark` hold the palette of the page. `.theme-light` holds the paper palette, with the same 57 token names, for a sheet lying on the page: the report slip in the home hero and beside a landing page.

### The page
- **Page Black** (`#09090a`): the page, the field and the footer.
- **Surfaces** (`#121214`, `#19191c`, `#232327`): cards and inputs, bars and office-use boxes, and the track of a bar.
- **Bone** (`#f4f1ea`): all running print, headings and the focus ring. **Muted Bone** (`#a9a69e`) is secondary print.
- **Rules** (`#3a3a41` frames and part rules, `#26262b` hairlines, `#43434b` emphasis, `#7c7c86` control borders, 3:1 on every surface).

### The hot ink
- **Vermilion** (`#ff4d2e`): the solid action, the brand tile, the pen's ring and strokes, the current step and the highlighted plan (`--stock`, with black print on it).
- **Vermilion, for print** (`#ff6a4d`, hover `#ff8f78`): links, file line numbers, a marked line of code.
- **Heat** (`linear-gradient(100deg, #ff2d2d, #ff5a1f 46%, #ffb224)`): the ground of the large figures, the bars of the benchmark strip and the name across the foot of the page. It is never the colour of a sentence.

### Standing
- **Observed Green** (`#6fd39b`): what the code shows. Confirmed, pass, proven, resolved.
- **Ochre** (`#f2c552`): unproven. Overstated, not supplied, an open objection.
- **Rose Red** (`#ff5d7a`): critical, contradicted, failed. It is a different red from the ink, so a mark of the pen never reads as an error.
- **Severity:** critical `#ff5d7a`, high `#ff9d5c`, medium `#f2c552`, low `#6fd39b`, info `#8fb2ff`, unrated `#a5a3ad`.

### Paper
Paper is `#fbfaf6` on `#f4f1ea`, printed in `#121214`, with the pen in `#c2280f`. On paper the solid action is black with white letters, and observed, unproven and critical print in `#1b6b3a`, `#855a00` and `#b0172f`.

### Named Rules
**The One Ink Rule.** Vermilion is the only hot colour of the interface, and it means the pen or the action. Green, ochre and rose red carry standing and nothing else.

**The Heat Is For Figures Rule.** The gradient sets figures and bars. Text that must be read is bone or muted bone.

## Typography

One webfont, self-hosted: Archivo as a variable file, width 62 to 125 and weight 100 to 900. Running text is the system sans, so it renders before the font arrives. Mono is for code, paths, references, hashes, model ids and typed entries, never for labels.

### Hierarchy
- **Display** (820, `clamp(2.375rem, 1.15rem + 4.9vw, 4.5rem)`, width 110%, -0.022em, line 1.02): the home headline.
- **Page head** (820, `clamp(2rem, 1.25rem + 3vw, 3.5rem)`, width 108%, -0.024em): every h1.
- **Section head** (810, `clamp(1.625rem, 1.2rem + 1.7vw, 2.5rem)`, width 106%, -0.021em): every h2.
- **Title** (760, 22px, width 100%): h3, card and finding titles.
- **Figure** (850 to 880, width 104% to 125%, about -0.03em): the three results (48px on a phone, up to 116px), a plan's price (56px), a result's counts (28px), the name across the foot.
- **Verdict run** (840, width 118%, capitals, up to 76px): an outline 2px wide, with the page's black as fill.
- **Body** (system sans, 16px, line 1.6) and **Lede** (18px, line 1.55, muted bone).
- **Label** (680, 12px, width 85%, 0.07em, capitals): margin captions, column heads, breadcrumbs.
- **Button** (700, 15px, width 90%).
- **Stamp** (860, 18px, 0.1em, capitals, width 68%): the rubber-stamp verdict. At the head of a result it prints at 24px from 960px, the size its impression is drawn at. The hand-stamped severity is 14px at width 72% and 0.08em.
- **Code** (mono, 13px, line 1.7, ligatures off).

### Named Rules
**The Wide And Narrow Rule.** Wide heavy cuts are for headlines and figures. Condensed cuts are for what is stamped or printed small: stamps, chips and labels. Nothing between is used for display.

**The Font Does Not Move The Page Rule.** Until Archivo arrives, a headline prints in a local face sized to the same advance: Arial Narrow Bold for the condensed bands, Arial Bold for the regular width, Arial Black for the wide cuts. Measures that depend on a cut are written in em.

## Motion

Everything that moves is cheap by construction, and all of it runs only while the page's motion is on. `<html>` carries `data-motion="on"` or `"off"`, set by `theme.js` before the first paint: on unless the visitor's system asks for less motion, and the visitor's own choice wins over the system. The foot of every page has the button, Pause motion or Play motion. A choice that differs from the system is remembered in the browser.

- **The field** (`web/public/field.mjs`, built in every `.page-field`). Four layers, none painted again after the first time. The text: 11px mono, rows 19px apart, drawn once to a canvas. The shade: the page's black at 87% with lights cut out of it, a picture 320px wide, stretched to twice the field and moved round one loop in 64s by a transform. The pen: a 2px vermilion line drawn left to right, held, then let go over 5.2s, a new one every 0.9 to 2.6s; side by side with a head's words it keeps to the right of them or to the top and foot of the field. The fade: the foot of the field sinks into the page, and a wash keeps the field quiet behind the words. There is no frame loop, no mask and no group opacity. Without script the head is printed on black.
- **The pen's ring.** One SVG stroke around "the hole" in the home headline, drawn once in 900ms after 500ms (`pen()` and `penned()` in `web/site/components.mjs`).
- **The ember.** A vermilion glow behind the report slip, breathing over 9s.
- **The verdict run.** The five verdicts in outlined capitals, one loop in 52s, hidden from assistive technology; the section under it says what each one means.
- **Stamps.** A stamp lands large and light (from 155% and transparent), overshoots to 96% just past halfway and presses flat at its tilt in 420ms on the out-ease. A verdict at the head of an arriving result lands the same way. The page stops on the first line of that result, just under the stepper, and the verdict follows in the same screen. On the home slip the pen strike draws across in 260ms (starting at 380ms), Medium lands at 660ms and the verdict lands over 480ms at 1000ms.
- **Rise on scroll.** A part with `.rise` comes up 28px into place as it enters the window, driven by the scroll position where the browser has scroll-driven animation. Elsewhere it is simply visible.
- **The action.** The primary button glows in its own ink under the pointer. Colour and border change in 120ms and a pressed button sinks 1px.

### Named Rules
**The Nothing Per Frame Rule.** A background is drawn once and moved by a transform or an opacity, which the browser animates off the main thread. Scrolling and typing never wait on decoration.

**The Still State Rule.** Every animation rule is keyed on `:root[data-motion="on"]`; no stylesheet asks the system directly. With motion off, `:root:not([data-motion="on"])` cuts every animation and transition to nothing, and each motion has a still state that reads complete: the ring drawn, two lines struck, the stamps pressed. Working indicators (a spinner, the running bar) are the only animations declared without the switch, and that rule stills them too.

## Layout

The page is a stack of forms in one centred column. The wrap holds 75rem of content inside a fluid gutter; long-form pages narrow it to 46rem and wide views open it to 86rem. Spacing steps on a 4px base (4, 8, 12, 16, 24, 32, 48, 72, 112).

Every page opens on the field: the page head stands over the moving field, which spans the window and starts directly under the header rule, while the head's content keeps to the wrap.

Every page but the home page opens on the same head: the trail on a page two levels down, the h1, the lede, then the page's own line or its actions in the large box. Its rhythm is set once: 48px of field above the head (32 on a phone) and 48 below, 16 between parts, 24 above the lede and above the actions. The heading therefore starts at the same height on every page. A page that ends on a call to action ends on one closing band: a raised panel with a sentence in the section cut, a line under it and the large boxes, the first one solid. Every page ends the same distance above the footer.

On the home page the first viewport is that field. From 960px it holds two columns (1.08fr of text and 0.92fr of slip): the kicker, the headline with its ring, the lede, the solid Review my report box and the ruled View example box, and one line that says what a review costs. The tilted paper slip stands on the right. Under them come one line of proof and the three results as figures, each a link to its public leaderboard, then the verdict run. On a phone the order is kicker, headline, lede, actions, price line, slip.

Forms are ledgers. The finding card and the workbench sheet print a 9.75rem caption margin, one 1px rule and the content to its right, and under 704px the caption moves above its content. Grids of cells are ruled by 1px gaps over the hairline ground inside a 1px frame, like the rack of verdict stamps.

The header keeps the brand at left and the nav and account control at right. Under 928px the nav becomes a second row that scrolls sideways with no link hidden. The footer ends in the name of the site across the window, set in the heat and sinking into the black.

Print is black on white whatever the screen shows: deeper inks, flat cards and panels, no header, footer, field or buttons, code wrapped.

### Named Rules
**The Part Rule.** A 2px printed rule opens every section, heads every ledger and table, and underlines the site header, the dialog head and the slip's head; a 1px hairline divides inside. Nothing sits above a heading but that rule. The home hero alone carries a kicker, one line that names the kind of tool.

**The Field Opens The Page Rule.** Every page head stands on the field, full width, directly under the header rule.

**The One Head Rule.** The page head and the closing band are each built and styled in one place. A page places what follows its head and what stands above its band; it never restates either, and never prints the band on vermilion.

## Elevation & Depth

Depth comes from light on black. The page is flat, cards cast nothing at rest (`--shadow-card` is none), and what lies above the page is lit: the paper slip in the ember's glow, a dialog over a backdrop of black at 78%.

### Shadow Vocabulary
- **Loose panel** (`0 1px 1px #00000066, 0 12px 28px -14px #000000cc`): a tool panel, a raised card or finding.
- **Loose sheet** (`0 1px 2px #00000080, 0 30px 60px -18px #000000d9`, with a 1px ring of white at 6% on the page): the report slip.
- **Pop** (`0 2px 6px #00000080, 0 28px 64px -20px #000000e6`): dialogs.

### Named Rules
**The Loose Sheet Rule.** A shadow means a sheet laid over the page: the slip over its second sheet, a raised tool panel, a dialog. It is never hover feedback, and never on a resting card.

## Shapes

Forms are square. Chips, controls, cards, tables and sheets turn their corners at 2px; dialogs and example frames at 3px. The rubber stamp is the only soft corner: 0.28em on the large verdict and 0.2em on the hand-stamped severity, set in em so one inked impression fits the stamp at every size. Circles appear only as marks: the status dot, the dots between the words of the verdict run, the radio mark of a pick and the busy spinner.

Only the slip, the stamps and the pen sit off square: the slip at -1.25° (-0.75° on a phone) over its second sheet at +1.75°, the verdict stamp at -2° (-4° on the slip), the severity stamp at -3°, and the pen's ring drawn by hand.

**The Dashed Means Blank Rule.** A dashed line is a field left blank or a sheet that is not real: an unrated severity, Hold: duplicate, unsupplied code, an evidence gap, the frame around invented output. It is never decoration.

## Components

Markup, helper signatures and every variant are in `web/site/COMPONENTS.md`, and a dev build renders them all at `/_kit`. This section records how each one looks and behaves.

### Buttons
- **Shape:** square (2px), a 1.5px border, 44px minimum height; small is 36px and grows to 44px on touch, large is 52px.
- **Primary:** the solid action box, vermilion with black letters. Under the pointer it brightens and glows (`0 0.5rem 2rem -0.5rem` of its ink at 70%). On paper and on vermilion stock it is black, with no glow.
- **Secondary:** a transparent box with a 1.5px rule. Under the pointer it fills with bone and its letters turn black.
- **Quiet / Danger:** quiet has no box and takes an 8% tint on hover; danger is a rose-red outline that fills on hover.
- **States:** disabled sits at 50% opacity; a running button shows a spinner and keeps its label. Focus is a 2px bone ring 2px outside.
- **Links:** vermilion with a half-strength 1px underline that turns full strength on hover.

### Chips
Stamps, not pills: a 1.5px outline in the chip's ink, ink letters in condensed caps and a trace of the same ink as fill (10% on the page, 6% on paper), 2px corners, 24px tall. Tones are observed (green), unproven (ochre), ok, danger (rose red) and neutral. A file reference and a hash are mono at 12px in a ruled box; a reference keeps to one line, and its line numbers print in vermilion.

### Stamps
The verdict, stamped. The large verdict is a double rule around condensed black caps, tilted. Each verdict and severity shows its ink through its own inked impression (`/stamps/verdict-<id>.webp`, `/stamps/sev-<id>.webp`) used as a CSS mask, so the ink is the chip's colour. The words stay in the markup for search, selection and screen readers. `scripts/build-stamps.mjs` makes the impressions from scans of real rubber-stamp imprints (`scripts/ink/SOURCES.md`); re-run it when a label, the stamp geometry or the font changes.

### Cards / Containers
A ruled box on the page: 2px corners, a 1px frame, hairlines between head, body and foot, no shadow at rest. Cards never nest. The dossier is the card at the head of a result: the verdict stamp, the headline and the counts under a 4px head rule. Under 480px the counts print in two rows: the three severities, then Hardening and Checked safe.

### Inputs / Fields
A surface box with a 1px control border (3:1 on every surface), 2px corners, 44px minimum height, 14px text that becomes 16px under 768px so phones do not zoom. Help is always visible text under the control; there are no tooltips. A tick box is a 20px square that fills with the action colour when checked.

### Navigation
- **Header:** the brand at left, nav and account control at right, a rule under it.
- **Links:** 44px targets. The current page is filled with vermilion and printed in black.
- **Brand mark:** a vermilion tile, the b in black, the slash in bone. `scripts/build-icons.mjs` draws the icons from the same paths.
- **Footer:** the promise, the primary action, vermilion column titles in condensed caps, and the name across the foot.
- **Tabs, stepper, segmented control:** the open tab joins the sheet under it. The current step of the stepper and the chosen segment are vermilion with black print; done steps carry a solid marker.

### Code Blocks
Near-black (`#0e0e10`) inside a ruled frame, 2px corners. Mono at 13px and 1.7 with ligatures off; line numbers come from data, stay in a sticky gutter and never copy. A marked line takes a tint of the vermilion with a 2px mark in its gutter; an unproven line does the same in ochre.

### Tables
A 1px frame; column heads in condensed caps over a 2px rule; hairlines between rows; tabular figures aligned right. On a narrow screen a stack table reads as one block per row, each cell under its column name.

### Dialog
A sheet laid over the page: a 1px frame, 3px corners and the pop shadow over the backdrop. Its head stays in view while the body scrolls, its foot sticks to the bottom and is not printed when every control in it is hidden, and widths are 440, 640 and 900px. It enters with a fade from 98% scale in 160ms.

### Finding Card
The result as an inspection form: a file bar, a head with the finding's id, severity and status chips, its title and its file references, then ledger rows with condensed-caps captions in a 9.75rem margin. A row's standing prints in its caption's ink: Observed is green; Counterargument is ochre while open and green when resolved; Evidence gap is ochre with its margin rule dashed. Path steps are numbered 01, 02. A draft review that lists only late steps keeps the draft's numbers under one line, "Numbered as in the draft." The full markup is in `web/site/COMPONENTS.md` under "The finding card".

### Report Slip
The home hero and the share image show the review as a slip, built by `reportSlip()` in `web/site/social/example.mjs`. It is paper (`.theme-light`), tilted -1.25° over its second sheet (`--copy`). On it: the draft's typed title in mono, the claimed severity struck through with one pen stroke, the severity the code supports hand-stamped beside it, the review's headline, the deciding source line under its reference, and the verdict stamped at the foot beside the date and the model. On a phone the slip leads with the claim, the two stamps and the verdict.

### Figures, bars and the run
- **The three results** (`.home-stats`): a figure in the heat over a muted caption, the whole item a link to the leaderboard it comes from.
- **Score bars** (`.bench-teaser__bar`): an inline SVG 4px tall on the heat, with the rest of the track covering it from the score to 100. It is an SVG because the page's own policy refuses a style attribute.
- **The verdict run** (`.verdict-run`): decoration between the hero and the five verdicts, with a dot in each verdict's ink between the words.

## Do's and Don'ts

### Do:
- **Do** take every colour, size, radius and duration from the tokens in `web/public/css/base.css` section 1. A new colour goes into both palettes, the page and paper, and a test keeps their token names the same.
- **Do** open every page on the field and every section with the 2px part rule.
- **Do** keep vermilion for the pen and the action, and carry standing in green, ochre and rose red.
- **Do** set headlines and figures in the wide cuts, and stamps, chips and labels in the condensed ones; keep mono for code, paths, references, hashes, model ids and typed entries.
- **Do** print verdicts and severities as stamps, and give a large verdict its inked impression.
- **Do** put invented output in a dashed frame labelled Example.
- **Do** keep every touch target at 44px, except a file reference inside a sentence, which keeps the height of its line (25px); keep every text at 12px or more, and form controls at 16px under 768px.
- **Do** give every motion a still state, key it on `:root[data-motion="on"]`, and move it by a transform or an opacity.

### Don't:
- **Don't** add a second hot colour, a second gradient, or a gradient on text that has to be read.
- **Don't** redraw a canvas on a frame loop, animate a mask or a filter, or fade a group that holds a moving layer.
- **Don't** mark status with a coloured stripe on the edge of a card, ledger row, tab or list item; the ink of the caption carries it.
- **Don't** set captions, column heads or buttons in mono, or add a second display face; Archivo is the one webfont, and it is self-hosted.
- **Don't** round a corner past 3px or draw a pill; the stamp's em corner is the only soft one, and circles are kept for marks.
- **Don't** shadow a resting card, row or table, or lift anything on hover.
- **Don't** fake ink with a repeating noise tile or a texture overlay; each stamp carries its own impression.
- **Don't** add a hex value outside the token blocks, an inline style, or a font or image from another origin; the CSP blocks them and the build fails.
- **Don't** nest cards, or hide help in a tooltip.
