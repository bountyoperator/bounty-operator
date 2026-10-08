# Components and page reference

The design system for bountyoperator.com. Every page is generated from a module in `web/site/pages/` and styled by `web/public/css/base.css` plus one stylesheet per page group.

See every component rendered: `node scripts/build-site.mjs --dev`, serve `web/public`, open `/_kit`.

Direction: **Inspection office** (DESIGN.md at the repository root records the whole system). A finding goes through inspection before it goes to a triager, and the verdict comes back as a stamp. Forms print in black on white and canary stock, verdicts and severities are stamped in ink, code sits on carbon. Violet marks what was observed in the supplied files; ochre marks what is still unproven. Printed labels are Archivo condensed caps; mono is for code, paths and hashes only. Dark is the night shift: carbon indigo, pale print, canary for what you act on.

## Contents

1. [Rules](#rules)
2. [Add a page](#add-a-page)
3. [Build, check, validate](#build-check-validate)
4. [The html template](#the-html-template)
5. [Tokens](#tokens)
6. [Layout primitives](#layout-primitives)
7. [Typography](#typography)
8. [Components](#components)
9. [The finding card](#the-finding-card)
10. [Behaviour wired by theme.js](#behaviour-wired-by-themejs)
11. [Motion](#motion)
12. [Building the same markup from script](#building-the-same-markup-from-script)
13. [Icons](#icons)

## Rules

Do:

- Use the tokens. A colour, size or radius that is not a token does not ship.
- Use the helpers in `components.mjs` for static pages. They escape text and emit the classes below.
- Put page-specific rules in your own stylesheet (`css/home.css`, `css/workbench.css`, `css/tools.css`, …) and list it in the page's `styles`.
- Write root-relative, extensionless links: `/guide`, `/tools/report-check`, `/#pricing`.
- Keep every text size at 12px or more, in `rem`. Form controls are 16px under 768px (already handled by `.input`, `.select`, `.textarea`).
- Keep touch targets at 44px. `.btn`, nav links, summaries, the dialog close button and checkbox rows already are.

Do not:

- Write `style="…"`, a `<style>` element, an inline `<script>` or an `on…=` attribute. The CSP blocks them and the generator fails the build.
- Add a hex colour outside the token blocks. If a new state needs a colour, add a token to all three theme blocks in `base.css`.
- Style bare elements in a page stylesheet (`details { … }`, `nav { … }`). Scope everything to a class.
- Link to `.html`, use relative links, or add a trailing slash.
- Nest cards.
- Use `raw()` on anything a user, a model or a file could have written.
- Hand-edit a generated `.html` file. Change the page module and rebuild.

## Add a page

Create `web/site/pages/<name>.mjs` (subfolders become nothing special: only `path` decides the URL).

```js
import { html, sectionHeading, button } from '../components.mjs';
import { breadcrumbsLd } from '../layout.mjs';

export default {
  path: '/tools/report-check',
  title: 'Report check | Bounty Operator',
  description: 'Paste a draft report and see which claims have no line reference. Runs in the browser.',
  nav: 'tools',
  styles: ['/css/tools.css'],
  scripts: ['/tools/report-check.mjs'],
  jsonld: [breadcrumbsLd([{ name: 'Tools', path: '/tools' }, { name: 'Report check', path: '/tools/report-check' }])],
  lastmod: '2026-10-02',
  body: html`
    <section class="section wrap">
      ${sectionHeading({ title: 'Report check', level: 1, lede: 'Find the claims with no line reference.' })}
      ${button({ label: 'Open the workbench', href: '/#workspace', variant: 'primary' })}
    </section>`,
};
```

### Page module contract

| Field | Required | Meaning |
|---|---|---|
| `path` | yes | Extensionless, lower-case, starts with `/`. `/` is the home page. Unique. Output: `/` → `index.html`, `/guide` → `guide.html`, `/tools/x` → `tools/x.html`. |
| `title` | yes | The full `<title>`. Unique across the site. |
| `description` | yes | 50 to 160 characters. |
| `body` | yes | The result of `html\`…\``. Rendered inside `<main id="main">`. |
| `nav` | no | Which header item is current: `workbench`, `method`, `tools`, `benchmark`, `guide`, `mcp`, `pricing`. |
| `og` | no | `{ image, title, description, type, width, height, alt }`. `image` defaults to `/social-v4.png` (1200 × 630). |
| `styles` | no | Root-relative stylesheets, loaded after `/css/base.css`. |
| `scripts` | no | Root-relative module scripts. Their static imports are followed and emitted as `modulepreload` links. |
| `preload` | no | Extra `modulepreload` hrefs, or `false` to turn the automatic ones off. |
| `jsonld` | no | Array of objects, each emitted as `<script type="application/ld+json">`. |
| `bodyClass` | no | Class on `<body>`. |
| `sitemap` | no | `false` keeps the page out of `sitemap.xml`. |
| `lastmod` | no | `YYYY-MM-DD`, written to the sitemap. |
| `robots` | no | Robots meta content. `noindex` also removes the canonical link and the sitemap entry. |
| `label` | no | Short name for footer links. Default: the title up to its first ` \| `, ` — ` or ` · `. |
| `order` | no | Sort order of a `/tools/*` page in the footer (default 100, then by path). |
| `skip` | no | `{ href, label }` for the skip link. Default: `#main`, "Skip to content". |
| `overlays` | no | `html` rendered after the footer. Put dialogs here. |
| `dev` | no | `true` builds the page only with `--dev`, with `noindex` and no sitemap entry. |

A module may default-export an array of pages. A module with no default export is treated as a shared helper and skipped.

What the layout adds: charset, viewport, title, description, canonical, `color-scheme`, two `theme-color` metas, Open Graph and Twitter tags, icons, manifest, `/theme.js`, stylesheets, preloads, scripts, JSON-LD, the skip link, the header and the footer.

Header: brand, nav (Workbench `/#workspace`, Method `/method`, Tools `/tools`, Benchmark `/benchmark` only when that page exists, Guide `/guide`, MCP `/mcp`, Pricing), theme toggle, account control. Pricing links to `/#pricing` on the home page and to `/pricing` everywhere else. The account control is `<button id="account-button">` on `/` and a link to `/#account` everywhere else.

Footer: Product, Tools, Resources and Legal columns. The Tools column lists the first six `/tools/*` pages. Method, gauntlet, panel review, templates, changelog, benchmark, security and licences links appear when those pages exist.

JSON-LD helpers in `layout.mjs`: `organizationLd()`, `softwareApplicationLd()` (Free and Operator offers), `faqPageLd(items)`, `breadcrumbsLd(trail)`.

## Build, check, validate

```
node scripts/build-site.mjs           # build
node scripts/build-site.mjs --dev     # also build dev pages; a link to a page that does not exist yet only warns
node scripts/build-site.mjs --check   # CI: write nothing, exit 1 if web/public is out of date
```

The build fails, and writes nothing, when a page has:

- a duplicate `path` or `title`, or a description outside 50 to 160 characters
- an inline `<script>` other than `application/ld+json`, a `<style>` element, a `style` attribute or an inline event handler
- an external script, stylesheet or image
- an internal link that ends in `.html`, is relative, has a trailing slash, or does not resolve to a generated page or a file in `web/public`
- a duplicated `id`, an `<img>` without `alt`, or a JSON-LD block that does not parse

Warnings: a same-page `#fragment` with no matching id, and a page without exactly one `<h1>`.

Generated files are listed in `web/site/.generated.json`. A file that is no longer produced is deleted on the next build. Files the generator did not write are never deleted.

Icons are drawn by `node scripts/build-icons.mjs` (needs Playwright; run it only when the mark changes).

## The html template

```js
import { html, raw, esc, attrs, cx, inline } from '../components.mjs';

html`<p>${userText}</p>`                     // escaped
html`<ul>${items.map((item) => html`<li>${item}</li>`)}</ul>`   // arrays join, nested html passes through
html`<p>${isNew && html`<b>New</b>`}</p>`     // false, null and undefined render nothing
html`<a${attrs({ href, 'aria-current': current ? 'page' : null })}>…</a>`
inline('The guard on `claim` does not cover `exit`.')   // escapes, turns `spans` into <code>
raw('<b>fixed markup</b>')                    // trusted markup only
```

`attrs()` throws on `style` and `on…` attributes.

## Tokens

Defined in `base.css` section 1. Light is the default block. Dark applies through `prefers-color-scheme` and through `data-theme="dark"` on `<html>`; `.theme-dark` forces dark on one element (the site footer), `.theme-light` forces light (the report slip in the home hero). `.page-field` prints a page head on the field, full width, and `.on-stock` prints anything on canary in either theme (the Operator plan, the tools call-out).

| Group | Tokens |
|---|---|
| Paper | `--bg` page · `--surface` cards, inputs · `--surface-2` bars, office-use boxes · `--surface-3` selected segment |
| Field and stock | `--field` page-head ground (canary by day, lifted carbon at night) · `--on-field` · `--on-field-muted` · `--field-rule` · `--stock` canary · `--on-stock` · `--on-stock-muted` |
| Lines | `--rule` printed rules and frames · `--line` hairlines · `--line-strong` emphasis · `--line-control` control borders (3:1 on every surface) · `--rule-w` part rule width |
| Ink | `--text` · `--muted` · `--placeholder` |
| Violet, observed | `--accent` stamp ink: links, marks, observed · `--accent-hover` · `--accent-solid` primary button fill (black by day, canary at night) · `--accent-solid-hover` · `--on-accent` · `--focus` |
| Ochre, unproven | `--gap` · `--gap-bg` |
| Severity | `--sev-crit` · `--sev-high` · `--sev-med` · `--sev-low` · `--sev-info` · `--sev-none` |
| State | `--ok` · `--danger` |
| Chips | `--chip-fill` · `--chip-line` (tint percentages) |
| Code | `--code-bg` · `--code-text` · `--code-muted` · `--code-line` · `--code-hl` · `--code-flag` · `--code-ok` (copied) |
| Brand mark | `--brand-tile` · `--brand-ring` · `--brand-glyph` · `--brand-slash` |
| Depth | `--shadow-card` (none: paper lies flat) · `--shadow` · `--shadow-pop` · `--shadow-slip` a loose sheet · `--backdrop` |
| Stamps | `--stamp` the impression a stamp shows its ink through (set per verdict and severity) · `--stamp-tilt` · `--copy` the pink carbon copy |
| Type | `--font-display` Archivo · `--font-sans` system · `--font-mono` · `--fs-12` `--fs-13` `--fs-14` `--fs-16` `--fs-18` `--fs-22` `--fs-28` `--fs-40` `--fs-64` `--fs-88` |
| Space | `--sp-4` `--sp-8` `--sp-12` `--sp-16` `--sp-24` `--sp-32` `--sp-48` `--sp-72` `--sp-112` |
| Radius | `--r-chip` 2px · `--r-ctl` 2px · `--r-card` 2px · `--r-hero` 3px. A stamp's corners are in em (0.28em, 0.2em), so they scale with its impression. |
| Layout | `--wrap` 75rem · `--gutter` · `--tap` 44px |
| Motion | `--ease` · `--ease-out` · `--t-fast` 120ms · `--t-panel` 180ms · `--t-dialog` 160ms · `--t-stamp` 420ms · `--stagger` 40ms |

Changing a dark value means changing it in both dark blocks. `web/tests/site-build.test.mjs` fails when they differ.

## Layout primitives

| Class | Use |
|---|---|
| `.wrap` | Page width with gutters. `.wrap--narrow` (46rem), `.wrap--wide` (86rem). |
| `.section` | Vertical padding for a page section. `.section--tight` for less. |
| `.stack` | Column with one gap. `.stack--4/8/12/24/32/48` set the gap; default 16. |
| `.cluster` | Row that wraps. `.cluster--tight`, `.cluster--between`. |
| `.grid` | Equal columns that collapse: `.grid--2`, `.grid--3`, `.grid--4`, `.grid--auto` (set `--col-min`). |
| `.split` | Two panes side by side from 960px. `.split--aside` gives a 15rem first column. |
| `.divider` | `<hr class="divider">` hairline. |
| `.visually-hidden` | Text for screen readers only. |
| `.no-print` | Hidden on paper. |

```html
<section class="section wrap">
  <div class="grid grid--3">…</div>
</section>
```

## Typography

Plain `h1` to `h6` are styled. `.h1` to `.h4` give any element that look.

| Class | Use |
|---|---|
| `.display` | Hero headline. Archivo condensed black, 44px on a phone, 88px on a desktop. |
| `.lede` | Intro paragraph, 18px, muted. |
| `.meta` | Archivo condensed caps, 12px, muted: printed labels and counters. |

Headings print in Archivo, semi-condensed and heavy. Nothing sits above a heading: no eyebrow, no kicker. A section opens with a part rule (`.section-head`).
| `.muted` `.small` `.fine` | Secondary ink · 14px · 13px muted. |
| `.mono` `.num` `.nowrap` | Mono family, for code, paths, hashes and typed entries · tabular figures · no wrapping. |
| `.prose` | Wrapper for long-form pages. Plain `h2`, `p`, `ul`, `ol`, `blockquote`, `a`, `code`, `kbd`, `table`, `hr`, `img` inside it are styled. |

Inline `<code>` is styled everywhere. The mono stack puts Cascadia Mono before Cascadia Code so `!=` and `<=` are never drawn as ligatures.

## Components

### Button

`.btn` with `.btn--primary` `.btn--secondary` `.btn--quiet` `.btn--danger`; sizes `.btn--sm` `.btn--lg`; `.btn--block`; `.btn--icon`. Disabled: the attribute or `aria-disabled="true"`. Running: `aria-busy="true"` shows a spinner.

```js
button({ label: 'Run review', variant: 'primary', iconEnd: 'arrow-right' })
button({ label: 'Report guide', href: '/guide' })                // renders <a class="btn …">
button({ label: 'Copy reference', icon: 'copy', iconOnly: true }) // label becomes the accessible name
```

```html
<button class="btn btn--primary" type="button"><span class="btn__label">Run review</span><span class="icon icon--arrow-right" aria-hidden="true"></span></button>
```

### Link

```js
link({ label: 'Read the report guide', href: '/guide' })
link({ label: 'Firelight leaderboard', href: 'https://…', external: true })   // new tab, arrow icon
```

`.link`, `.link--external`. Links inside `.prose` need no class.

### Form controls

`.field` wraps `.label`, the control, `.help` and `.field-error`. Controls: `.input`, `.select`, `.textarea`, and `.check` (a label row holding `.check__box` and `.check__label`). Add `.mono` to a control for keys, hashes and model ids. Invalid: `aria-invalid="true"`.

```js
field({
  label: 'API key',
  for: 'api-key',
  control: input({ id: 'api-key', type: 'password', mono: true, invalid: true, attrs: { 'aria-describedby': 'api-key-error' } }),
  help: 'Used for this request only.',
  error: 'OpenRouter rejected this key (401). Paste a current key and run the review again.',
})
select({ id: 'provider', value: 'openrouter', options: [{ value: 'openrouter', label: 'OpenRouter' }] })
textarea({ id: 'focus', rows: 4 })
checkbox({ id: 'consent', label: 'I own this material or have permission to review it.' })
```

Help text is always visible text under the control. There are no tooltips.

### Segmented control

A radio group for two to four exclusive choices.

```js
segmented({ name: 'mode', label: 'Mode', value: 'bounty', options: [{ value: 'bounty', label: 'Bounty' }, { value: 'own-code', label: 'Own code' }] })
```

`.segmented` > `label.segmented__option` > `input[type=radio]` + `span`.

### Chips

Stamps, not pills: an ink outline, ink letters in Archivo condensed caps. Base class `.chip`; the variant sets the ink. `.verdict--lg` is the rubber stamp (a double rule, a tilt with `--stamp-tilt`) and `severityChip(id, label, { stamp: true })` adds `.sev--stamp`, a severity stamped by hand. Both show a pressed impression: `scripts/build-stamps.mjs` renders the live box crisp (`.stamp--proof`), presses it once with its own seed and writes `web/public/stamps/verdict-<id>.webp` and `sev-<id>.webp`; the box shows the chip colour through that file as a mask, so day and night share one asset, and keeps its words in the markup. Their geometry is in em, so one impression fits every size. Re-run the script when a label, the geometry or the font changes; `web/tests/home-page.test.mjs` checks every verdict and severity has its file and that the labels match the app's.

| Helper | Markup | Values |
|---|---|---|
| `severityChip('high')` | `<span class="chip sev" data-sev="high">High</span>` | `critical` `high` `medium` `low` `info` `unrated` |
| `verdictChip('prove-first')` | `<span class="chip verdict" data-verdict="prove-first">` | `submit` `rewrite-then-submit` `prove-first` `hold-duplicate` `drop` `fix-before-deploy` `no-blocking-issues`; `{ size: 'lg' }` adds `.verdict--lg` |
| `statusChip('resolved')` | `<span class="chip status" data-status="resolved">` | `proven` `needs-test` `unsupplied` `resolved` `open` `running` `queued` `done` `failed` `example` `free` `operator` |
| `chip('Passed', { tone: 'ok' })` | `<span class="chip" data-tone="ok">` | tones `observed` `unproven` `ok` `danger` `neutral`; `{ dashed: true }` adds `.chip--dashed` |
| `refChip('input-1/Vault.sol:60-69')` | `<span class="ref" title="…"><span class="ref__file">…</span><span class="ref__lines">:60-69</span></span>` | Also takes `{ label, start, end }`. `{ href }` renders a link. |
| `hashChip(sha256)` | `<span class="hash"><span class="hash__algo">sha256</span>2d204875f798…</span>` | `{ algo, length }` |

A reference chip stays on one line. When space runs out the file part shortens and the line numbers stay whole, so keep the two spans.

### Card

```js
card({ title: 'Manifest', meta: '1 file', body: kv([['Lines', '179']]), foot: 'Check it again at the verifier.' })
```

`.card` > `.card__head` (`.card__title`, `.card__meta`) + `.card__body` + `.card__foot`. Variants: `.card--raised`, `.card--inset`, `.card--accent`.

### Key/value list

```js
kv([['Profile', 'Solidity review'], ['Model', html`<span class="mono">anthropic/claude-sonnet-5.5</span>`]])
```

`dl.kv` > `div.kv__row` > `dt` + `dd`.

### Dossier and counts

The head of a review: verdict, headline, totals.

```js
dossier({ verdict: 'fix-before-deploy', headline: 'Two independent paths pay out ETH owed to other stakers.', counts: { critical: 1, high: 1, medium: 0, hardening: 3, 'checked-safe': 4 } })
counts({ critical: 1, high: 0 })
```

`.dossier` > `.dossier__verdict` + `.dossier__headline` + `ul.counts` (`li[data-sev]` > `.counts__n` + `.counts__label`; a zero gets `data-zero`).

### Code block

```js
codeBlock({ code, name: 'input-1/TidalStaking.sol', start: 60, highlight: [64], flag: [63], copy: true })
codeBlock({ code: 'forge test -vvv', numbers: false, copy: true })
```

| Option | Meaning |
|---|---|
| `name` | File name in the bar. Without it there is no bar and the copy button sits in the corner. |
| `start` | Number of the first line. |
| `highlight` | Lines marked violet (observed). Numbers or `[from, to]` pairs. |
| `flag` | Lines marked ochre (unproven). |
| `dim`, `dimOthers` | Recede context lines. |
| `numbers: false` | No line numbers. |
| `wrap: true` | Wrap instead of scrolling, for prompts. |

`figure.code.code--numbered` > `figcaption.code__bar` (`.code__name`, `.code__range`, `button.code__copy[data-copy]`) + `pre.code__pre` > `code` > `span.code__line[data-n]` (`.is-hl`, `.is-flag`, `.is-dim`). Each line span ends with a line feed so the text copies correctly.

### Notice

```js
notice({ tone: 'warn', title: '1 file contains an email address', body: 'Remove the line, or confirm and send it as it is.' })
notice({ tone: 'error', id: 'review-status', live: true })   // empty live region the app fills later
```

`.notice` with `.notice--info` `.notice--success` `.notice--warn` `.notice--error`; children `.icon`, `.notice__content` > `.notice__title` + `.notice__body`. Errors carry `role="alert"`. An empty notice takes no space.

### Tabs

```js
tabs({ label: 'Result view', items: [{ id: 'findings', label: 'Findings', count: 2, selected: true }, { id: 'raw', label: 'Raw' }] })
```

`div.tabs[role=tablist]` > `button.tabs__tab[role=tab][aria-selected]` (+ `.tabs__count`). The helper emits the tab list; the page script owns the panels (`id="panel-<id>"`) and arrow-key focus.

### Stepper

```js
stepper({ label: 'Review steps', steps: [{ label: 'Files', state: 'done' }, { label: 'Review', state: 'current' }, { label: 'Results' }] })
```

`nav.stepper` > `ol` > `li` > `button.stepper__step[data-state=done|current|todo]` > `.stepper__marker` + `.stepper__label`. The current step has `aria-current="step"`.

### Table

```js
table({
  caption: 'Checked and safe',
  columns: [{ label: 'Item', sort: 'none' }, { label: 'Lines', align: 'end' }, { label: 'SHA-256', mono: true }],
  rows: [['recoverToken', '158-163', '2d20…']],
  dense: true,
})
```

`div.table-wrap` (scrolls sideways, focusable) > `table.table` (`.table--dense`). A column with `sort` gets `aria-sort` on its `<th>` and a `button.table__sort`; the page script does the sorting. `.num` right-aligns figures.

`.table-wrap` is `position: relative`, so a visually hidden caption or label inside a wide table stays inside the wrap and cannot widen the page.

### Stack table

```js
stackTable({
  caption: 'The four results',
  columns: [{ label: 'Result' }, { label: 'Meaning' }, { label: 'What to do' }],
  rows: [['Match', 'The file hashes to the value in the manifest.', 'Nothing.']],
  plain: false, // true: leave the column names out of the stacked cells
  wide: false,  // true: stack below 60em instead of 44em, two cells abreast on a tablet
})
```

A reference table that reads as a list on a narrow screen: one block per row, every cell after the first under its column name. It takes the options of `table()` and emits `table.table.stack-table` (`.stack-table--plain`, `.stack-table--wide`) with a `span.cell-label` in each cell after the first. The rules are in `base.css`; a page stylesheet only adds what is specific to its own table. A script that builds the same table in the browser writes the `span.cell-label` itself (see `/tools/slither-focus.mjs`).

### Disclosure and accordion

```js
disclosure({ summary: 'Paste code instead', hint: 'One file', body: html`…` })
faq([{ q: 'What do you keep?', a: 'Account and passkey records.' }], { exclusive: 'faq' })
```

`details.disclosure` > `summary.disclosure__summary` (+ `.disclosure__hint`) + `.disclosure__body`.
`div.accordion` > `details.accordion__item` > `summary.accordion__summary` + `.accordion__body`.

Pass the same items to `faqPageLd(items)` for the structured data. A bare `<details>` is not styled.

### Dialog

```js
dialog({ id: 'account-dialog', title: 'Sign in', size: 'sm', body: html`…`, foot: html`…` })
```

`dialog.dialog.dialog--sm|md|lg` (440 / 640 / 900px) > `header.dialog__head` (`.dialog__title`, `button.dialog__close[data-close-dialog]`) + `.dialog__body` + `footer.dialog__foot`. Open it with `showModal()`. The head stays in view while the body scrolls, the page behind does not scroll, and `closedby="any"` lets a backdrop tap close it. Put dialogs in the page's `overlays`.

### Progress, meter, skeleton

```js
progress({ label: 'Review running' })      // <div class="progress" role="progressbar">: the indeterminate 2px bar
skeleton('title'); skeleton('text', { lines: 3 }); skeleton('chip'); skeleton('block')
```

```html
<progress class="meter" value="3" max="4" aria-label="Concurrent reviews in use">3 of 4</progress>
```

Pair the running bar with an elapsed timer and `statusChip('running')`.

### Section heading and breadcrumbs

```js
sectionHeading({ title: 'Free tools', lede: 'Run them without an account.', id: 'tools', aside: html`…` })
breadcrumbs([{ label: 'Tools', href: '/tools' }, { label: 'Report check' }])
```

`header.section-head` > `.section-head__text` + `.section-head__aside`, under a part rule. `nav.breadcrumbs` > `ol` > `li`. A trail of two (home and this page) prints nothing: the mark in the header is the way home, and a lone label above a heading reads as a kicker. Every trail stays in the page's BreadcrumbList JSON-LD.

### Page head on the field

Every page opens on the field: `pageHero()` (method and landing pages), `docHead()`, `toolHead()` and the template heads carry `.page-field`, which prints a full-width band in `--field` behind the head and switches its ink to `--on-field`. A `.section` whose first child is a page field gives up its top padding, so the band starts under the header rule. `pageHero({ stamp, meta })` prints an Operator stamp or a file line under the title; there is no eyebrow.

### Site header and footer

Emitted by the layout. Classes: `.site-header`, `.site-header__inner`, `.brand` (`.brand__mark`, `.brand__name`), `.site-nav`, `.site-header__actions`, `.theme-toggle`, `.site-footer`, `.site-footer__grid`, `.site-footer__col`, `.site-footer__base`, `.site-footer__cta`. The current page's nav link is marked with canary. The footer is the carbon back sheet in both themes (`.theme-dark`) and closes every page with the promise and the Review my report action. Under 928px the nav becomes a second row that scrolls sideways; no link is hidden.

`brandMark()` returns the "b/" mark as inline SVG paths.

## The finding card

The signature component of the results view. It appears there, in the examples, the 404 page and the kit. The home hero and the social card show the report slip instead (`reportSlip()` in `web/site/social/example.mjs`): the example draft's own header lines with the claimed severity struck, the supported one stamped and the verdict stamped in the box the form keeps for it.

```js
findingCard(finding, {
  bar: { name: 'input-1/TidalStaking.sol', hash: sha256, tag: '179 lines' },
  code: { code, name: 'input-1/TidalStaking.sol', start: 60, highlight: [64], copy: true },
  reveal: true,
})
```

`finding` is the object `parse.mjs` returns for one finding:

```js
{ id: 'F-1', title, severity: 'critical', basis: 'proven-in-source',
  locations: [{ label: 'input-1/TidalStaking.sol', start: 60, end: 69 }],
  impact, path: ['step', 'step'],
  counterargument: { objection, status: 'resolved' | 'open', why },
  gap: 'none' | 'one artifact' | ['artifact', 'artifact'],
  fix, test: 'code' | { …codeBlock options }, next }
```

| Option | Meaning |
|---|---|
| `level` | Heading level of the title. Default 3. `0` renders the title as a paragraph, for an example card that is not a section of the page (a hero example directly under the `h1`). |
| `bar` | Window bar: `{ name, hash, tag }`. |
| `code` | `codeBlock()` options for the excerpt under the path. |
| `rows` | Rows to render, in order. Default: every row that has content. |
| `reveal` | Entrance animation: rows rise 40ms apart while the spine draws down. |
| `refHref` | `(ref) => url` to make the reference chips links. |
| `id`, `className` | `finding--raised` adds the shadow, `finding--glow` lifts it like a loose sheet, `theme-dark` forces dark. |

Markup:

```html
<article class="finding" data-sev="critical" aria-labelledby="f-1-title">
  <div class="finding__bar">…<span class="finding__file">input-1/TidalStaking.sol</span><span class="hash">…</span><span class="finding__tag">179 lines</span></div>
  <header class="finding__head">
    <div class="finding__tags"><span class="finding__id">F-1</span><span class="chip sev" data-sev="critical">Critical</span><span class="chip status" data-status="proven">Proven in source</span></div>
    <h3 class="finding__title" id="f-1-title">…</h3>
    <ul class="finding__refs"><li><span class="ref">…</span></li></ul>
  </header>
  <dl class="finding__rows">
    <div class="rail" data-rail="observed"><dt class="rail__label">Observed</dt><dd class="rail__body">…</dd></div>
  </dl>
</article>
```

Rows (`data-rail`), in order, and what the label's ink says (the margin rule is one neutral 1px line, dashed for an evidence gap):

| `data-rail` | Label | Ink | Body |
|---|---|---|---|
| `impact` | Impact | grey | `<p>` |
| `observed` | Observed | violet | `ol.steps` and the code excerpt |
| `counter` | Counterargument | ochre when `data-status="open"`, violet when `resolved` | `p.rail__quote` then `p.rail__answer` (status chip + text) |
| `gap` | Evidence gap | ochre, dashed; grey when `data-status="none"` | `ul.gaps` |
| `fix` | Fix | grey | `<p>` |
| `test` | Test | grey | a code block |
| `next` | Next | grey | `p.rail__next` (arrow icon + text) |

`rail(kind, body, { label, status })` builds one row for a custom card, as the 404 page does. A list of cards goes in `.findings`.

Under 704px the label moves above its content and the margin rule moves to the card's inner margin.

## Behaviour wired by theme.js

`/theme.js` is loaded on every page, blocking, in `<head>`. It:

- applies the stored theme before first paint (`localStorage["bo-theme"]` = `light` | `dark`; absent = follow the system) by setting `data-theme` on `<html>`
- toggles the theme from any `[data-theme-toggle]` and dispatches `themechange` on `document` with `detail.theme`
- copies a code block when its `[data-copy]` button is clicked, sets `data-copied` on the button for two seconds and swaps the `[data-copy-label]` text to "Copied"
- closes the enclosing `<dialog>` when a `[data-close-dialog]` control is clicked

Page scripts do not need to wire any of these.

## Motion

| Class | Effect |
|---|---|
| `.panel-enter` | A step panel or result block fades in and rises 6px over 180ms. |
| `.stagger` | Children enter one after another, 40ms apart (first eight). |
| `.finding--reveal` | The finding card's rows rise while its spine draws down. |
| `.stamp-land` | The one authored moment: a stamp lands large and light, then presses flat at its tilt in 420ms. A verdict in a result that enters with `.panel-enter` lands the same way, and the home slip runs strike, Medium, verdict in sequence. |

Colour and border transitions run 120ms. Dialogs fade and scale from 98% over 160ms. Everything is off under `prefers-reduced-motion: reduce`: the running bar becomes a solid line and skeletons go flat.

## Building the same markup from script

The app builds results with `createElement` and `textContent`; model output and pasted text are never parsed as markup. Use the same classes and attributes as the helpers. Three details matter:

- Icons are empty spans: `<span class="icon icon--copy" aria-hidden="true"></span>`. No SVG markup is needed.
- A reference chip needs both inner spans (`.ref__file`, `.ref__lines`) to truncate correctly.
- Each `.code__line` span ends with `"\n"` and carries its number in `data-n`.

The `--i` custom property drives stagger order. The stylesheet sets it for the first eight children; set it from script (`element.style.setProperty('--i', index)`) for longer lists.

## Icons

`icon('copy')` → `<span class="icon icon--copy" aria-hidden="true"></span>`. Pass `{ label }` when the icon is the only content of a control. Icons are CSS masks, so they take the current text colour and size with `width` / `height` (default `1em`).

`check` `x` `plus` `minus` `arrow-right` `arrow-left` `arrow-up-right` `chevron-down` `chevron-right` `copy` `download` `upload` `file` `search` `lock` `key` `sun` `moon` `info` `warn` `error` `ok` `clock` `play` `refresh` `terminal` `shield` `hash` `eye` `trash` `user` `menu` `code` `sort` `sort-up` `sort-down`

To add one: draw it on a 24px grid with a 1.75 stroke and round caps, add an `--icon-<name>` data URI next to the others in `base.css` (encode `<` as `%3C`, `>` as `%3E`, `#` as `%23`), add the `.icon--<name>` rule, and add the name to `ICONS` in `components.mjs`.
