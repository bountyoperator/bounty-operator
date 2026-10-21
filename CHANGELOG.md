# Changelog

## 0.9.21 — 2026-10-21

Providers

- Nebius Token Factory is available in the workbench and in local and remote
  MCP. Bring your own Nebius key; DeepSeek V4.1 Flash is the default, and GLM
  5.3 Flash and Kimi K3 are listed model choices.
- Nebius bills model usage separately, and we receive no commission. Each
  request asks Nebius not to store the answer. The setup guide covers Nebius's
  billing details and its zero-data-retention setting.
- The local MCP download is versioned 0.9.21; older release archives are retained.

## 0.9.20 — 2026-10-20

Website

- The website now leads with making a stronger, evidence-backed submission.
  Its first saved example confirms a Critical finding in the explicitly
  invented Halyard Treasury, with a named link to the matching review.
- Unchanged severity is no longer struck through in the saved-review display.
  The cited excerpt includes the complete first fix range.
- The original Tessera film and walkthrough remain together in a collapsed
  supporting section. Existing Tessera links still open the same example.
- Shared messaging and the refreshed Spec share card use the new positioning.
  Review instructions and severity criteria are unchanged.
- The site footer now links to Bounty Operator's official X account,
  `@BountyOperator`.
- Link previews and organization metadata identify the company account
  separately from the builder's personal attribution.

Media update — 21 October 2026

- Created an 18-second Spec film about supporting a confirmed Critical finding
  in the explicitly invented Halyard example, rather than leading with a
  severity reduction.
- Added a repeatable local renderer and timed captions. The source notes
  identify the reused Higgsfield animation and newly generated Cillian
  narration. Rendering does not publish or replace existing website videos
  or X posts.
- Published the film as a new post on `@BountyOperator`. The pinned
  introduction, earlier posts and website videos are unchanged.

Immunefi Studio

- Corrected programme evidence collection: Studio's `list_programs` returns
  names and slugs, not scope or programme rules. The report challenge and
  gauntlet now collect official terms separately and keep missing rules explicit.
- Both MCP endpoints and the agent skills can read Blueprint sections and
  their cited source files with existing access, using the finding's chain.
  Blueprint leads remain hypotheses, and its report scope is not bounty scope.
- The gauntlet keeps Instascope's block and implementation metadata and warns
  about unavailable snapshots, changed implementations and unknown upgrade
  history. A captured getter snapshot is not presented as an arbitrary live read.
- The gauntlet skill documents programme-filtered Signals reads when requested,
  including pagination and withheld metrics. These do not predict a payout.
- Setup checks the intended Studio account with `whoami`. Workspace writes
  still need permission; workflows do not start trials or change subscriptions.
- Checked the official 35-tool catalogue and exercised Blueprint source reads
  and local MCP evidence preparation without model calls or Studio writes.

## 0.9.19 — 2026-10-20

Providers

- Novita AI is available in the workbench and local and remote MCP. Bring your
  own Novita key; DeepSeek V4.1 Flash and GLM 5.3 Flash are listed model choices.
  Novita bills model usage separately from Bounty Operator's hosted-review plan.
- New-account links use our approved Novita referral and disclose the commission
  beside the link. Existing customers have a separate direct key-management
  link. The setup guide explains provider credit, account limits and privacy.
  Affiliate parameters never accompany model requests, and commission does not
  change the default provider or benchmark rankings.
- Provider links leave the copy-paste route when requested and no longer carry
  another provider's model into the selected provider. An explicit model or
  copy-paste-route choice in the link still takes precedence.
- The local MCP download is versioned 0.9.19; older release archives are retained.

## 0.9.18 — 2026-10-15

Website update — 20 October

- The model API quickstart waits for live availability. Only callable models
  can create a request; unavailable or unknown models in a shared link get an
  explicit notice rather than silently selecting another model.
- The catalog keeps every model visible and adds an Available now filter.
  Quickstart links preserve the selected model and client without including
  API keys.
- curl, Python and JavaScript examples now include a complete sample contract,
  model-specific reasoning settings and a 20-minute cold-start timeout.
  Python retries are disabled; JavaScript reports HTTP failures directly.
- The first request is beside the setup instructions, not after the catalog.
  Copy controls and wrapped examples fit narrow phone screens.
- The home-page review button now opens the no-key AI chat route explicitly.
  Core code, Solidity and draft-report reviews can be prepared and pasted back
  without a Bounty Operator account; provider costs and limits still apply.
- The workbench can check OpenRouter's current free models. Choices exclude
  nonzero fees, missing output limits and limits too small for a review. A
  model changes only when selected, and discovery failures never select a
  paid alternative. No files or credentials go with the catalog request.
- OpenCode setup distinguishes the v1 and v2 MCP configurations. The setup
  page now provides a first core-review request, and the agent-facing index
  explains the account-free prepare-review/build-packet path first.
- Model-selection guidance separates chat, agent and free-provider routes,
  their account allowances, and their model-specific data-use restrictions.

Site

- New visitors see Sign up in the header, and it opens Create your account
  with what a free account gets you: Triager simulation, Prior-art overlap and
  six more checks a chat app can't run, once a day on your own AI key, plus a
  token for your coding agent. A browser that has signed in before still sees
  Sign in.
- On a phone the header is one row with a Menu button, so every page starts
  higher on the screen.
- The home page says plainly what works with no account and what a free
  account adds. After the example or a review, the next step offers a free
  account when the next check needs one.
- The report templates point to the review near the top, not only at the end,
  and after you copy one. The Immunefi template notes that recent audit
  competitions and some bounties charge a fee for every report.
- New template: GitHub private vulnerability report, following GitHub's new
  structured form.
- /mcp leads to a free account and a token in one step. The passkey notice now
  helps on computers with no built-in passkey (scan the code with your phone,
  or use 1Password, Bitwarden or a security key).

## 0.9.17 — 2026-10-15

Security

- The `ai-review` command and the sanitizer scan now check the file a path
  really reaches, not only the path as typed. A folder link inside a project
  (for example `references -> ../.kube`) could make a file in `~/.kube`,
  `~/.ssh`, `~/.aws` or another blocked folder pass the private-folder check.
  The file read must also be the very file that was checked. Reported privately
  through GitHub (GHSA-7p9h-3mfj-9vrj), low severity: the text could only go to
  the AI provider you configured, and only for a file you selected yourself.

## 0.9.16 — 2026-10-15

Model API

- Seven models are on sale: Qwen Cyber 27B AWQ, DeepHat V1 7B,
  Foundation-Sec 1.1 8B, Hermes 4 14B and Orca Nex N2.5 Mini at a minimum of
  US$0.30 a request, and Orca Qwen 3.8 27B and Hermes 4.3 36B at a minimum of
  US$0.60. Each passed a live test request on 15 October.
- The catalog shows all 24 models again, each marked available, paused or not
  available yet. 0.9.15 listed only the usable ones; that was undone the same
  day so nothing disappears from view.
- Until the live catalog loaded, the page showed lower minimum charges for six
  models than they cost. It now shows what is charged.
- A paused model says "Paused" rather than "Not available yet". When every
  model is at capacity, the page says buying credit stays open, because new
  credit adds capacity.
- Credit is sold only when it can be spent: a top-up is refused, before any
  card is charged, whenever the model host's funding cannot be confirmed.
- The account panel says why top-ups are closed: paused, unavailable, being
  checked, or switched off on our side.

Reviews and MCP

- A review on a Bounty Operator model waits out a cold start, in the browser
  and from the local MCP server, instead of failing after five minutes. If you
  installed the 0.9.15 MCP package, install it again (npx may keep serving
  its cached copy).
- A review that is cancelled before it finishes is not counted against your
  allowance, and over MCP no review text is sent until the review is complete.

Operating safeguards

- Part of every confirmed top-up and monthly API credit now funds the model
  host's budget automatically, so sales no longer wait on a manual budget
  change. A refund or dispute takes back only what that payment funded.
- The service can email its operator when the RunPod balance runs low, when
  model sales stop for any reason, and when they resume.
- A deploy stops while a database migration is pending or the alert settings
  are half set up.

## 0.9.15 — 2026-10-15

Model API

- The Model API is open. Qwen Cyber 27B AWQ is available to buy and use:
  add prepaid credit, create a key and call it from any OpenAI-compatible
  tool. It passed three live test requests on 15 October.
- The catalog lists only models you can use today. The others return once
  each one passes the same live test.
- When the model has been idle, its first request waits up to 10 minutes
  while a GPU starts. The model now loads from a cache, so that wait is
  mostly set-up time that nobody is charged for. Requests after that answer
  in seconds while it stays warm.
- The minimum charge per request for Qwen Cyber 27B AWQ is US$0.30, so a
  request that wakes the model covers the GPU time it uses.
- While the API is closed, the catalog now says so in plain words.

## 0.9.14 — 2026-10-15

Model API and reviews

- Reviews using the Bounty Operator provider now allow time for a cold model
  to start, keep the review slot reserved during startup, and release it when
  a request fails or is cancelled. JSON-only callers collect the model stream
  into a complete answer. Streaming inactivity checks resume after the first
  response bytes.
- Model cards show availability for each configured model. Gateway model IDs
  link to their provider rather than an assumed model repository; unavailable
  metadata is labelled, and a model-selection guide explains the choices.
- Manual and automatic API top-ups use the same availability checks as the
  catalog. Automatic top-ups require an explicit enable flag and stop initiating
  payments while inference is unavailable.
- Oversized inputs are rejected before contacting a model host. Confirmed usage
  is preserved when a response fails, and customer charges cannot exceed the
  amount reserved for that request.
- Updated Infron rate references and clarified that our application does not
  store prompts or responses, while the selected hosting provider's policies
  also apply.

Operating safeguards

- Added separate supplier budgets and request commitments. Customer API credit
  alone cannot authorize a model request; each request requires a current
  supplier allowance before contacting a model host.
- Interrupted requests retain their supplier allowance until final usage is
  confirmed. These allowances limit admitted work; they are not vendor bill caps.
- Added supplier billing reconciliation and a read-only JSON report that keeps
  actual vendor costs, estimates, customer credit liability and usage revenue
  separate. Missing payment fees and net profit remain unknown.
- Rebuilt the MCP download and checksum manifest for this release while
  retaining the existing versioned downloads.

## 0.9.13 — 2026-10-14

Model API and review providers

- Expanded the `/model-api` and `/v1/models` catalog to 24 zero-idle-cost
  cybersecurity, low-refusal, OrcaCyber Zero, DeepSeek, GLM, Qwen, Gemma 4,
  Kimi K3, Omen 2.0, CyberStrike, Orca, Dolphin, Foundation-Sec and Hermes
  models across scale-to-zero GPU workers and serverless upstream gateways.
- Added `Bounty Operator` (`bountyoperator`, `BOUNTYOPERATOR_API_KEY`),
  `Infron` (`infron`, `INFRON_API_KEY`) and `OrcaRouter` (`orcarouter`,
  `ORCAROUTER_API_KEY`) as supported review providers across the workbench,
  Gauntlet, Panel review, CLI and MCP server (11 providers in all), with
  in-process Worker routing when a review uses a `bo_api_...` key.
- Added a workload cost estimator (`Per 1M tokens`, `Review run`, `Agent
  session`), an interactive quickstart switcher (`curl`, `Python`, `TypeScript`,
  `Agent config`), and one-click `Use in review` deep links on `/model-api`.
- Added a hosting-balance pause gate so `/api/health`, `/api/inference/catalog`
  and `/api/portal` report `paused` when upstream capacity is paused, close
  new top-ups, and exclude `hosting_paused` attempts from the caller failure
  limit.

## 0.9.12 — 2026-10-11

Model catalog and Operator billing

- Moved the Operator plan for new subscribers to US$10 per month, with US$2 in
  Bounty Operator API credit issued on each verified paid monthly subscription
  invoice. Existing weekly subscriptions keep their weekly interval.
- Added optional customer-authorized automatic API top-ups (off by default) with
  configurable recharge amount, balance threshold, and a UTC monthly cap from
  US$20 to US$500, plus in-account controls to turn off automatic top-ups or
  cancel a subscription.
- Added model-specific reasoning controls and a ten-minute cold-start allowance,
  with credit reservations that remain valid for the full request window.
  Health checks use the full allowance without retrying generation.

Hosted API

- OpenAI-compatible model inference with streaming, function tools and
  structured output, using pinned cybersecurity and lower-refusal open-weight
  models on Runpod.
- Prepaid API wallets, one-time Stripe top-ups and expiring API keys with
  lifetime spending limits. API credit is separate from the review subscription.
- Atomic credit reservations, metered settlement, duplicate-payment protection,
  refund and dispute reconciliation, and cancellation that releases unused credit.
- Model rates, source revisions, limits and setup examples at `/model-api`.
  Request history contains usage metadata; prompts and responses are not saved.

Walkthroughs

- A 54-second product tour follows the saved public example from its
  input files to the verdict, source citation and downloadable packet.
- A 75-second MCP walkthrough shows the Codex setup command, a report
  review using the agent's own model, and recorded prepare_review and
  build_packet responses from the public example.
- Both videos have native controls, captions and a text transcript.
  Playback starts on request; the videos use no third-party player.
- Video assets support byte-range requests so the native player can seek.

## 0.9.11 — 2026-10-11

Report check

- The severity check compares an explicit CVSS 3.1 base vector with a
  labelled score on the same line and flags mismatches, missing metrics
  and repeated metrics. It runs locally and uses FIRST's scoring formula.
- CVSS stays optional. Metric choices, other CVSS versions, Temporal and
  Environmental scores, and ambiguous score/vector pairs need manual review.
  The checker does not infer a programme severity or change the draft.

## 0.9.10 — 2026-10-10

Site

- The proof lines give the builder's place on Immunefi's all-time
  leaderboard, with the day it was read: 77th on 10 October 2026. Each one
  links the public profile, which Immunefi marks Top Ranked. The rank is
  recomputed daily, so the day stays beside the number.
- "Built by Tradi3" at the foot of every page links that profile.

## 0.9.9 — 2026-10-10

Site

- Every page now opens the same way. The heading starts at the same height
  on every page: 48px under the header rule, 32px on a phone, and one line
  lower on a page that shows its trail. The landing pages, the benchmark
  and the pricing page started theirs further down, and the template pages
  a few pixels further than the tools and the guide.
- The lede stands the same distance under the heading on every page and
  keeps one line length. The buttons in a page head are the large size on
  every page; on a phone they share the row width, one above the other.
  The guide, the security, support, benchmark and template pages had the
  smaller size.
- The page for an address that does not exist opens on the moving field
  like every other page. It was a card in the middle of a black page.
- A page that ends on a call to action ends on one closing panel. The tool
  pages printed theirs on solid vermilion, the guide and the other
  reference pages used a smaller panel and the templates hub a third. All
  of them are now the panel the landing pages use, with the same buttons.
- Every page ends the same distance above the footer. The reference pages
  ended closer to it and the template pages further.
- A few headings break better for it: "What an invalid report costs on
  each platform" takes two lines, not three.

Payment

- The payment page at Stripe takes the site's paper and its black box. It
  still had the pale blue ground and the blue button of an earlier design.

## 0.9.8 — 2026-10-10

Reviews

- OpenRouter sets a review's whole output allowance against the account's
  credit before a model runs. An account holding less than that was refused,
  though a review seldom uses the allowance. The review now goes once more
  with the allowance the account can pay for, when that is at least 16,000
  tokens. Below that, the message gives both numbers: what the review may
  use and what the credit covers.
- A model identifier OpenRouter does not know is now shown at the Model
  field, like any other unknown model.

MCP

- The official MCP Registry lists the remote endpoint as
  `io.github.bountyoperator/bounty-operator`. The entry is published from
  the source repository by a workflow that signs in as the repository.

## 0.9.7 — 2026-10-10

Reviews

- OpenRouter answers 404 when a model exists and the account's own settings
  leave it no host: its privacy settings, its data policy or its list of
  allowed hosts. The workbench read every 404 as a wrong model identifier.
  It now says which setting ruled the hosts out. For a free model whose
  hosts may train on what they are sent, on an account that does not allow
  that, it says to pick a model that is not free.
- A free model on OpenRouter runs on a request allowance its host shares
  among all of OpenRouter's users. When that allowance is used up the
  answer is HTTP 429, and the message now names the host and says that the
  key and its credit are not the cause.
- OpenAI answers 429 for an account that is out of credit as well as for
  requests sent too fast. The two are now told apart: the first is not a
  wait.

Site and privacy

- /your-model-your-key answers "Can I run it on a free model?".
- The site keeps a daily total of the page views a browser navigated to,
  read from two headers a browser sends when it opens a page. No page
  sends anything new. /privacy lists it.

## 0.9.6 — 2026-10-10

Account and billing

- The site now reads a subscription from Stripe itself when its paid week is
  ending: from twelve hours before the end, at most once an hour, until the
  next week is on record. Until now a renewal, a cancellation or a failed
  payment reached your account only through the notice Stripe sends. Had
  that notice been lost, a subscriber who paid for the next week would have
  lost Operator six hours into it.

Site and privacy

- The counters of the MCP endpoint now hold agents only. Our own release
  checks are not counted, a registry or a monitor that calls on a timer is
  counted apart, and a session is counted under the kind of agent that
  opened it: Claude, Codex, Cursor or "other". A headless browser that
  drives a page is no longer counted as someone using it.
- /privacy lists every counter the site keeps. The list had left out the MCP
  endpoint's counters and eight of the named actions a page reports. A counter
  is still a date, a name and a total, with no account, address or cookie in
  it.

## 0.9.5 — 2026-10-09

Site

- There is a help page, /support, linked from the foot of every page and
  from the billing view of your account. It sends each kind of request to
  its place: a question to Q&A and an idea to Ideas on the forum, a bug to
  the bug report form, an account or payment problem to email, and a
  vulnerability in Bounty Operator to the private report form.
- The forum is GitHub Discussions on the source repository. Anyone can read
  it; posting needs a GitHub account. It is public, so the help page says
  first what stays out of it: unreported findings, report drafts, API keys,
  connection tokens and recovery codes.
- The README, llms.txt and the issue chooser on GitHub point to the same
  places.

## 0.9.4 — 2026-10-09

Site

- /benchmark has a new table, "Right, wrong and not finished". It splits
  every ranked model's inputs into those it answered right, those it
  answered wrong and those it did not finish, with the reason. An unfinished
  input scores as wrong, so a low rank can mean either, and the table tells
  them apart: of 792 inputs, 646 were answered right, 85 wrong and 61 were
  not finished.
- The same section says why two models rank low without one wrong answer.
  Claude Sonnet 5.5 lost 13 inputs, 11 cut off at the output limit and 2
  timed out. That is the agent run at the highest effort; a review in the
  workbench is one request, and Sonnet 5.5 is its default model on
  OpenRouter.

## 0.9.3 — 2026-10-09

Reviews

- Claude Sonnet 5.5 is the default model on OpenRouter. We ran the review the
  product runs, one request, on pairs of the benchmark with seven models.
  With the review method Sonnet 5.5 got the largest share of its pairs right,
  and it is the model that ran all eight stages of the gauntlet without a
  block. GPT-6.1 Sol, the default until now, is second in the list.
- The gauntlet says when a model is known to stop. OpenAI's safeguards
  blocked stage 4, the proof review, on GPT-6.1 Sol for all four drafts we
  tried. The row says so before a run starts on that model.
- When a provider blocks a gauntlet stage on an OpenRouter key, the notice
  has a button that resumes that stage on a model from another vendor. The
  finished stages are kept.
- Blocks and credit errors are named for what they are. A request stopped by
  a guardrail on an OpenRouter key, a credit hold on a new OpenRouter account
  and a key that has used up its own limit each read as a rejected key or an
  empty account before. An OpenAI cyber block passed on by OpenRouter is named
  as OpenAI's. Anthropic's refusal to write out a model's reasoning has its
  own notice, because another model does not get past it.
- The wait after a rate limit is said once, not twice.
- A GitHub import without a token reads the files from GitHub's file host,
  so fifty files no longer use up the 60 API calls an hour GitHub gives a
  visitor. A file kept in Git LFS is reported as a pointer, not imported as
  one.

MCP

- `run_review` can return two more values of `blocked`: `guardrail` and
  `anthropic-reasoning`.

Site

- The guide's "When the model refuses" entry says where blocks happen most
  and what we measured.
- /security says that with OpenRouter a review goes to OpenRouter and on to
  the model host it picks.
- The home page tells search engines the site's name. After a release the
  pages that changed are sent to IndexNow. A visit that comes from ChatGPT,
  Perplexity, Claude, Copilot or Gemini is counted under that name, and
  /privacy lists them.

## 0.9.2 — 2026-10-09

Site

- The foot of every page has a button, Pause motion or Play motion. Motion is
  on unless your system asks for less of it, and your own choice wins: if
  Windows has "Animation effects" switched off, or a phone has Reduce Motion
  on, the site opens still and Play motion starts it. The choice is kept in
  your browser.
- The README says what the MIT licence covers: the code in the repository,
  not the hosted method and not the name.

## 0.9.1 — 2026-10-09

Reviews

- The model, API key and sign-in fields are back. In 0.9.0 the new background
  was given the class name the form's fields already had, and its rules hid
  them. 0.9.0 was live for 17 minutes before it was taken down.

## 0.9.0 — 2026-10-09

Site

- The site has a new look: a black page, bone-white type and one red ink.
  There is one look now. The light and dark themes, and the switch between
  them, are gone.
- Behind the head of every page lie lines of a report and of its code. Lights
  drift over them and a red pen strikes a line now and then. Nothing is drawn
  again after the first time, so scrolling and typing never wait on it, and
  it holds still when your system asks for less motion.
- The home page opens on "Find the hole in your report before the triager
  does." Under it the builder's three results are large figures, each a link
  to its public leaderboard, and the five verdicts run past.
- The home page no longer has the three-step strip or the "More ways to use
  Bounty Operator" list. The header and the footer carry those links.
- Each model on the home page's benchmark strip has a bar as long as its
  score.
- A link that opens the review form says where it goes: "Start a free review"
  or "Review my report". 27 of the 35 pages are reworded.
- A new icon, and a new picture for shared links.

Reviews

- "View example" stops on the first line of the result, with the verdict in
  the same screen. It stopped above the result, on the heading of the form.
- In a result, what the code confirms prints green, what it contradicts
  prints red and what is unproven prints ochre.
- The review form opens on "Challenge a draft report".
- On a phone the five totals of a result sit in two rows: the three
  severities, then Hardening and Checked safe.
- A draft review that lists only the late steps of an attack says "Numbered
  as in the draft." above them.
- The Focus box grows with what you type, in browsers that can size a field
  to its content.
- On a phone the Files box drops the line that asks you to drag files in.
- A dialog with nothing in its foot shows no empty strip there.

## 0.8.4 — 2026-10-09

Reviews

- On a phone, the tables in a result read as a list: each claim with its
  status, its location and the reasoning under it. They were cut off at the
  edge of the screen. The files list and the panel's agreement table read the
  same way, and a long hash or address wraps.
- A file reference inside a sentence keeps the height of its line on a touch
  screen.
- On phones 360px wide or narrower, the numbered steps of a finding are no
  longer cut at the edge of its card.

Site

- A page is no longer laid out wider than a phone screen while a verdict
  stamp lands. It was: the home page on phones up to 380px wide, and an
  opened result on phones up to 409px.
- /benchmark answers "Does Bounty Operator make a model score higher?" The
  2026-10 benchmark release does not say, and the answer gives the reason in
  counts.
- "Which model to use for what" on /benchmark picks each model on its own. It
  listed two picks made with a profile added.
- The Firelight result reads 2nd of 133, the last rank on that board. It read
  135, which counted two disqualified rows.
- The README screenshots show the current design.
- The 0.8.2 entry below says why /benchmark compares nothing.

## 0.8.3 — 2026-10-09

Site

- The home page paints sooner on a slow connection. Its scripts now load
  after the stylesheets and the font, and the median first paint went from
  4.9 s to 3.1 s at Lighthouse's slow-4G settings. The review form was ready
  0.3 s later at those settings. Every page that loads scripts gets the same
  change.
- On a phone, the column picker on /benchmark hides the columns you untick.

## 0.8.2 — 2026-10-09

Reviews

- A review your provider blocks under its usage policy is named as a block
  and is never counted against your allowance. That covers Anthropic's cyber
  safeguards, on a direct key and through OpenRouter, and OpenAI's
  `cyber_policy` error. A block sent as an error used to read as a rejected
  API key.
- The result says who blocked the review and what to do: run it again on
  another model or provider. The Gauntlet stops at a blocked stage, keeps
  the stages that finished and asks for another model. Panel review asks
  for another model in a blocked seat.
- MCP: `run_review` returns `blocked` (`anthropic-cyber`, `openai-cyber` or
  `policy`) next to `refused`, or fails with the code `provider_policy`.
- On a phone, a result shows its verdict before the export buttons. Download
  packet stays in view and the four other exports open under More exports.
- In an in-app browser (X, Facebook, Instagram, LinkedIn, TikTok) the sign-in
  dialog says to open the page in Safari or Chrome when no passkey prompt
  appears, and gives a Copy link button.

Benchmark

- /benchmark ranks the models on their own and no longer compares a model
  with and without Bounty Operator. Four of the 22 ranked models also ran
  with the profiles, once per input: too little to judge the product by. The
  results file keeps every published number of the 2026-10 release, and the
  published files are unchanged.
- Anthropic's cyber safeguards blocked 5 answers in the 2026-10 release, 3
  from Claude Fable 5.1 and 2 from Claude Opus 5.5. The benchmark account is
  not in Anthropic's Cyber Verification Program, and the blocks count as
  misses in that release. /benchmark says so under "How it is kept honest".
  From the next release on, a blocked run is left out of the score and
  counted in its own column. The 2026-10 release is not regraded.

Site

- The guide has a new entry, "When the model refuses", at
  /guide#model-refuses.
- /pricing and /your-model-your-key answer a Claude Max or Team subscriber:
  since October 2026 those plans include monthly credits for the Claude API,
  and a review on a key from the linked Console organization draws on them.
- /invalid-report-costs carries Bugcrowd's limits as changed on 8 October
  2026, and /compare was read again on 9 October 2026.
- The Sherlock template links each rule where Sherlock keeps it today and
  marks the audit contest rules as the earlier rules: Sherlock has replaced
  audit contests with Audit Engine.
- Every page gives the ENS result as 17 valid Critical submissions, the most
  of 186 researchers on that board.
- Page heads hold steadier while the display font loads, and the header
  button reads "Sign in" on every page for a signed-out visitor.

## 0.8.1 — 2026-10-08

Site

- Every stamp is now pressed with real ink. The voids, the mottle and the
  pressure across each stamp's face come from scans of real 1980s
  rubber-stamp imprints, published as CC0 on Wikimedia Commons, so each
  verdict and severity reads as an inked impression on the home page, in a
  review's result and on the social card.

## 0.8.0 — 2026-10-08

Site

- A new design on every page: black print on white and canary stock, with
  verdicts and severities stamped in ink. The dark theme is carbon indigo.
- The home page opens on the example draft, with the severity it claims
  struck through and the verdict stamped at the foot. It also lists the five
  verdicts a review can return.
- Headings, labels and stamps are set in Archivo, served from this site
  under the SIL Open Font License. No font service is called.
- New icons and a new social card.

## 0.7.12 — 2026-10-08

Site

- The proof on the home page, the method, pricing and Gauntlet pages and
  the guide adds Tradi3's ENS result: 15th of 186 in Immunefi's ENS audit
  competition, with 17 valid Criticals, the most on the board. Firelight's
  board now lists 135 researchers, so that line reads 2nd of 135. Every
  result links to its public leaderboard.
- A new social card carries the same results.

## 0.7.11 — 2026-10-07

Immunefi Studio

- Immunefi Studio runs its own MCP server. With it connected next to
  Bounty Operator, the gauntlet and the report challenge find the Immunefi
  programme with its `list_programs` tool and, for a smart contract with
  Instascope access, call `get_proxy_history` and `get_target_state`, and
  pass what they return to the review as files. Both servers' prompts and the gauntlet and
  challenge-report skills say so. Without it, nothing changes.
- After the report, the gauntlet skill offers to keep the verdict and the
  open counterarguments as a Studio case and tasks, and writes to Studio
  only when you say yes.
- /mcp shows the setup for Claude Code, Codex and Cursor. The Studio token
  goes from your agent to Immunefi; Bounty Operator never receives it.

## 0.7.10 — 2026-10-07

Site

- New page, /invalid-report-costs: what a report closed as invalid, N/A or
  spam costs on HackerOne, Bugcrowd, Intigriti, YesWeHack, Immunefi, Cantina
  and Sherlock's Audit Engine, from each platform's own pages, with every
  source numbered and dated.

Report check

- An unfilled `{placeholder}` left from a template counts as a leftover. A
  call option such as `{value: msg.value}`, an event dump and a `{{7*7}}`
  payload do not.

## 0.7.9 — 2026-10-07

Report check

- Three new checks, from the platform rules of 2026, take the tool to
  seventeen. All three run in your browser, like the rest.
- Transactions sent to a live network: a `cast send` or
  `forge script --broadcast` aimed at a remote node, a Hardhat run on a
  named network, or a link to a transaction the report says you sent.
  Immunefi bans testing on mainnet or a public testnet. A forked test, a
  local node and a transaction someone else sent are not flagged.
- AI use disclosed: a line that says which AI tools helped and how, or that
  none did. Intigriti's Code of Conduct requires it, and GitHub's private
  vulnerability report form asks.
- Placeholders and assistant leftovers: `[insert …]`, `<your …>`, TBD,
  `TODO:`, and sentences such as "As an AI" or "I hope this helps". A TODO
  quoted from the target's code, Markdown links and courtesy lines to a
  triager are not flagged.

Compare

- Intigriti's Submission Draft Agent joins the platform pre-checks, and the
  tools table adds a local go or no-go check on one finished report, a bounty
  platform's own report-writing plugin and a bountiability check with
  exploit simulation. Every row has a dated source.

## 0.7.8 — 2026-10-07

MCP and agents

- The Claude Code plugin's server entry sets a 20-minute tool-call timeout.
  Claude Code ends a call at that time even while progress arrives, and
  never aborts it for idleness sooner, so a hosted review can run its full
  15 minutes.
- /mcp gives the Claude Code entries as `.mcp.json` with the same timeout,
  since `claude mcp add` has no timeout option. Codex sets
  `tool_timeout_sec = 1200` on both routes, and the account panel's Codex
  note names the two `config.toml` lines `codex mcp add` cannot set.
- /mcp says claude.ai and Claude Desktop end any tool call at 240 seconds,
  so hosted reviews run from Claude Code, Codex or the website.
  `prepare_review` and `build_packet` work in every client.

Which reviews count

- Pricing, the home page, the terms, the guide, /mcp and llms.txt say the
  same thing: only a review that runs on your key through the website or
  `run_review` counts. Copy-paste reviews, and core reviews your coding
  agent's own model writes with `prepare_review` or the skills, need no
  account and are not counted. /pricing used to say every review from a
  coding agent counted.

Benchmark

- Each lift row gives, for both arms on its own pairs, how many answers
  failed and how many were cut short at the output limit, and marks an arm
  where most were. Claude Sonnet 5.5's three profile arms were: 12 of 12,
  17 of 20 and 3 of 4 answers cut short, so those lifts measure where the
  limit fell, not what the profile changed.
- The notes say the draft-report profile changed in 0.7.5, after these
  runs. The Solidity and code security profiles are sent today exactly as
  measured. The published results are unchanged.

Site and privacy

- /privacy lists every key the site's scripts keep in your browser, where
  it is kept and what it holds, checked against the scripts by a test. It
  also says the Worker keeps no invocation logs and no log line holds an IP
  address.
- On a phone, the benchmark leaderboard's header row is a Sort by control,
  and /benchmark no longer widens a 320-pixel screen.
- The home page loads one stylesheet fewer.
- Example cards beside a page's heading have a paragraph title, template
  buttons start their accessible name with "Open template", and template
  code blocks are labelled by section.
- The Gauntlet is "eight stages" everywhere, page titles fit in 60
  characters, and FAQ structured data has no space before punctuation.

## 0.7.7 — 2026-10-07

Reviews

- A streamed review gets a 64,000-token output allowance on the models that
  take it: Claude Opus 5.5, Sonnet 5.5 and Fable 5.1, GPT-6.1 Sol, Astra and
  Luna, Grok 4.7, and the models in the OpenRouter list. These models reason
  inside the same allowance as the answer, and at 16,000 tokens a large review
  could spend it all on reasoning and come back empty. A model id you type,
  and a review read as one answer, keep 16,000. Your provider bills the
  tokens used.
- An answer the provider breaks off after it has started writing is kept and
  marked cut short. Before, an agent on MCP received nothing for an answer
  its key had paid for.
- A review read as one answer is no longer stopped by the 180-second silence
  limit, which only a stream can use: it runs to the single-answer limit.
- A full review that a provider's filter flags at its end counts like any
  other review, and so does one that broke off after 2,000 characters
  reached you.

Gauntlet and Panel

- Layout never changes a verdict. A proof that is in your files but not
  pasted into the report, unnumbered steps, the title or the limits
  sentence become To do items, and a supported report stays submit.
- Missing evidence leads to prove-first, naming the file or output to add.
  A drop, or any verdict harsher than every stage or every panel seat, now
  quotes the supplied line or rule that settles it.
- The Panel marks a finding unproven when nothing supplied contradicts it
  but its evidence is missing. An unproven finding is prove-first, not drop.
- These answer the measured results of 3 October, when the Gauntlet asked
  for rewrites of three supported reports and the Panel dropped a finding
  all three seats said to prove first. The new rules have not been
  re-measured yet.

MCP

- A streamed run_review over its token's limit comes back as a tool error the
  agent can read, not an HTTP error. It checks the token once, and it shares
  the account's review limit with the website.
- An MCP-Protocol-Version the server does not offer gets HTTP 400. Batches
  from 2025-03-26 clients are answered.
- GET /api/mcp/server-card serves the MCP Server Card, and
  /.well-known/ai-catalog.json and /.well-known/ard.json list it.

Account and billing

- Removing a passkey also revokes your connection tokens: create a new one
  for your AI clients.
- A late update from Stripe can no longer store a canceled subscription as
  unpaid, and deleting an account checks Stripe for a subscription that has
  not ended.
- The data export includes every stored review row and the billing records.

Site and privacy

- Pages are compressed: /benchmark went from 171 KB to about 15 KB.
- /pricing.html and /pricing/ move permanently to /pricing, and /404 answers
  404.
- The service no longer keeps Cloudflare's per-request logs, which held each
  visitor's IP address and browser for seven days.
- The output guard also stops a copy of the method disguised with invisible
  characters, look-alike letters or spaced-out letters.

## 0.7.6 — 2026-10-07

MCP

- Opening a session no longer counts against the remote endpoint's
  allowance. initialize, initialized, tools/list, prompts/list and ping are
  free; only tool calls count, 300 per address per 10 minutes. An agent that
  started many short sessions spent the old allowance on these alone and got
  HTTP 429 on every request for up to ten minutes.
- A tool call over the allowance comes back as a tool error that says how
  long to wait, with a Retry-After header, so the agent can wait and retry
  instead of losing the server.

Site

- /security.txt redirects to /.well-known/security.txt.

## 0.7.5 — 2026-10-05

MCP

- `run_review` on the remote endpoint answers a client that accepts
  `text/event-stream` with a stream: a progress notification every 10 seconds
  while the review runs, then the result. Claude Code stopped waiting after
  about a minute and reported "The operation timed out", so a hosted review
  that took longer than that never reached the agent. A client that accepts
  only JSON gets one JSON body, as before.
- On that stream the review reads the model as a stream too, so a slow model
  is no longer cut off at 270 seconds. A review can run for up to 15 minutes.
- `/mcp`: the Codex remote config sets `tool_timeout_sec = 900`, and the
  install panels no longer shift the page when the client tabs load.

Challenge a draft report

- A missing Context field is never a fail on its own.
- Only proof-inline, form-matches-body and read-back block a submit verdict.
  A failed title, steps, limits or concrete-detail check is a fix note in its
  row and leaves the verdict as it is.
- When Context gives no proof-field contents, proof-inline judges the report
  body alone.
- Published Paydirt results remain the original frozen measurements.

## 0.7.4 — 2026-10-04

Review compatibility

- Prepared reviews list every file's physical line boundaries. Wrapped text and
  sentences within a single numbered line do not create extra citable lines.
- Citations such as `input-1:4` resolve to the one supplied file with that input
  number. Unknown, ambiguous and out-of-range locations remain flagged, and
  valid shorthand opens the cited source in the workbench.
- Gemini 3.8 Flash, Qwen3.8 27B, Qwen3.8 Max 0902, HY4 Preview and GLM 5.3 on
  OpenRouter have a 64,000-token total output allowance, including reasoning.
  Their reasoning defaults are preserved. The model and panel controls disclose
  the larger allowance before a run; provider billing follows actual usage.
- Empty responses report that no completed review was received. The Python
  preparer now counts an empty file as zero lines, matching the shared engine.
- Published Paydirt results remain the original frozen measurements.

## 0.7.3 — 2026-10-03

Reviews

- OpenRouter defaults to GPT-6.1 Sol following checks of its report decisions
  and source references. DeepSeek V4.1 Flash remains a lower-cost option.
- A new Panel starts with GPT-6.1 Sol, Claude Sonnet 5.5 and DeepSeek V4.1 Flash,
  with Sol selected for cross-examination. Existing model choices are preserved.

## 0.7.2 — 2026-10-03

Workbench

- A missing blocker, action or deadline now reads "Not stated in this review."
  An explicit "None" is preserved. An omitted field no longer implies that
  a report is ready to submit.

## 0.7.1 — 2026-10-03

Reviews

- OpenRouter defaults to DeepSeek V4.1 Flash, which completed all 36 core-profile
  inputs in the October benchmark. GLM 5.3 Flash, GPT-6 Luna and GPT-6.1 Sol
  are also available in the model picker. A model the user chose is preserved.
- The website and downloadable MCP server list the same model choices.
  The published October benchmark results and review profiles are unchanged.

## 0.7.0 — 2026-10-03

Skills and Claude Code plugin

- The repository is a Claude Code plugin and its own marketplace. Five skills:
  `challenge-report`, `solidity-review`, `code-security-review`, `gauntlet`
  and `hunt-with-gate`. They install with `claude plugin install`,
  `npx skills add` or `omp plugin install`. The plugin adds the remote MCP
  endpoint and reads `BOUNTY_OPERATOR_TOKEN` and `BOUNTY_OPERATOR_PROVIDER_KEY`.
- `scripts/build-pack.mjs` writes the three review skills from the engine and
  `--check` fails on drift. It refuses to build when a hosted profile's method
  is in reach.
- `/.well-known/agent-skills/index.json` lists the five skills with their
  SHA-256, so `npx skills add https://bountyoperator.com` installs them.
- `/mcp` has a section on the skills and the plugin.

Paydirt benchmark

- Unfinished models cannot change the tiers or recommendations for finished
  models, and profile comparisons require both arms to be complete.
- Retried runs retain their earlier evidence in a private archive. Recorded
  retry costs count toward the budget and the published cost per input.

- `/benchmark`: the Paydirt leaderboard, generated from the published results
  file. Score with its 95% interval and tier, recall, fool's-gold rate,
  challenge accuracy, failure rate, cost per run, median time and the
  reasoning effort sent; picks per task, profile lift, the outcome of every
  model on every held pair, the models not run and why, and the commands that
  check every number. Columns sort and hide in the browser.
- `/benchmark/method`: `bench/METHOD.md`, rendered when the site is built.
- The home page shows the first three places, with every model tied with the
  third, under the proof strip. The benchmark pages, strip and navigation link
  are generated from the published results.
- `bench.mjs publish` writes `not_run` (every model of the release's tiers
  with no counted answer, with a reason from `bench/release-notes/<release>.json`
  or the default) and `notes`, counts the infrastructure retries in each
  counted run's latest stored invocation (`infra_retries`), and takes `--harness-commit <sha>`.
  `verify` recomputes all three.

Reviews

- Every review opens with a verdict: `submit`, `rewrite-then-submit`,
  `prove-first`, `hold-duplicate` or `drop`. Reviews of your own code return
  `fix-before-deploy` or `no-blocking-issues`.
- Eleven review profiles. New: scope and impact fit, design intent and actors,
  prior-art overlap, proof review, severity calibration, triager simulation,
  report editor and scanner triage. The new profiles run as hosted reviews:
  your files and your key go through bountyoperator.com to your provider, the
  service adds the method, and no file, key or review is stored. Code security
  review, Solidity review and Challenge a draft report stay open source and
  also export as a prompt.
- A free account runs any single profile as its hosted review of the day.
- An answer that repeats the review instructions in place of a review is
  stopped with the code `output_withheld`. An unfilled output template is not
  such an answer and is delivered.
- Each finding carries its file-and-line references, the strongest
  counterargument, the one missing artefact, a fix, a test and the next action.
  A reference to a file or line that was not supplied is flagged.
- Evidence fields for what decides a report: the impact row, exclusions,
  revisions, prior material, the proof run and what the platform stored.
- Eight providers on your own key: OpenRouter, Anthropic, OpenAI, Gemini, xAI,
  DeepSeek, Mistral and Groq. OpenRouter connects in one click. Provider errors
  name the cause.
- A review takes up to 50 files, 120 KB per file, 240 KB and 20,000 lines in
  total. The answer is capped at 16,000 tokens.

Operator

- The Gauntlet: one run through eight stages (scope, provenance, prior art,
  proof, severity, triager, report, verdict). It ends in one verdict, one
  blocker, the cheapest action that removes it and a filing deadline. A run
  that is cancelled or interrupted keeps its finished stages.
- Panel review: two to four models review the same files in parallel, then a
  cross-examination pass keeps the findings the cited lines prove and records
  how many models reported each one.
- The last gauntlet stage and the panel cross-examination run on Operator
  only. An account without the plan is refused with the code `operator_only`
  before the provider is called, and keeps its review of the day.
- Four hosted reviews at once. Free stays at one hosted review per UTC day and
  Operator at US$10 per week.

Workbench

- Results stream in and render as finding cards under the verdict. A cited
  line opens in the file it came from.
- Import from GitHub: a repository, a folder, a pull request or a commit,
  pinned to a commit SHA, with a file picker. A local folder can be dropped in
  whole.
- Paste-back for chat subscriptions: export the prompt of a core profile,
  paste the answer back and get the same cards and packet.
- Local history, off by default: finished reviews saved in this browser, with
  export and delete.
- Email and IP matches are warnings you acknowledge. A line that holds a
  secret is masked, or its file removed, before anything is sent.

Account

- Rebuilt account panel: overview with today's usage, recent reviews,
  connections, security and billing.
- Rotating the recovery code, adding or removing a passkey, creating a
  connection token and deleting the account ask for the passkey again when the
  last check is older than ten minutes.

Free tools and templates

- Five free tools that run in the browser: report check, packet verifier,
  secret check, acceptance rates and Slither triage queue.
- Report check treats explicit "prior art not checked" statements and empty
  headings as missing evidence. A reference only confirms that text is present;
  it does not verify comparison quality or duplicate status.
- Five templates: Immunefi, Sherlock, Cantina, HackerOne and a Foundry PoC
  scaffold.
- New pages: the twelve checks, the report guide with a worked example,
  pricing, compare, security, licences and this changelog.

MCP

- Remote endpoint, nothing to install:
  `claude mcp add --transport http bounty-operator https://bountyoperator.com/api/mcp`.
- Local server from the site:
  `npx -y https://bountyoperator.com/dl/bounty-operator-mcp.tgz`. It reads
  files by path and adds `run_gauntlet_plan`.
- Tools renamed to `list_profiles`, `prepare_review`, `build_packet`,
  `run_review` and `account`. Three prompts: `challenge-report`,
  `solidity-review` and `gauntlet`.
- `prepare_review` takes the three core profiles and your agent's own model
  writes the review. `list_profiles` marks every other profile `hosted`:
  `prepare_review` refuses it with `hosted_profile` and `run_review` runs it
  with a connection token and your provider key.
- The `gauntlet` prompt runs seven stages through `run_review` and the report
  stage on your agent's own model, so a full run over MCP takes Operator.

Fixes

- Hosted reviews now work on the production runtime. Provider calls used a
  redirect option that runtime refuses.
- A weekly renewal no longer drops paid access while Stripe is still
  collecting the invoice.
- The sign-up limit counts accounts created, not attempts. A cancelled passkey
  prompt no longer locks sign-up for the day.
- A review that fails validation, or that the provider cuts off at the start,
  does not use the day's free review.
- Billing errors name the cause.

Site

- On narrow screens the header's scrolling nav fades at the right edge, and the
  current page's link scrolls into view.
- New design with dark and light themes. Extensionless URLs, one content
  security policy on every response and no third-party scripts.

CLI

- `ai-review` defaults to `gpt-6.1-sol` and caps output at 16,000 tokens. The
  cap is sent as `max_completion_tokens` to OpenAI, xAI and Groq, as
  `max_tokens` to other endpoints, and is left out for Gemini.
  `--max-output-tokens` changes it.
- `ai-review` reads the finish reason. A review cut off at the cap prints with a
  warning on stderr, and a refusal or an empty answer is an error that names
  the cause.
- `ai-review` sends files with line numbers so the review cites exact lines.
  The manifest and `--dry-run` include a line count per file.
- `ai-review` accepts up to 50 files and waits 180 seconds by default. Failed
  requests report rejected keys, unknown models, rate limits and timeouts
  separately, with the provider's message when it passes the sanitizer.
- `slither-focus` reads a successful scan with no detector results as an empty
  queue.
- `pattern-stats --json` renames the `caution` field to `note`.
- The default agent-pack tool stack lists general tools only.
- Packaging: SPDX licence metadata, Beta status, project URLs.

## 0.6.0 — 2026-10-02

- Add a three-step workbench, an account-free authored example, paste input, and
  GitHub file import pinned to an exact commit.
- Add code security, Solidity source-review and draft-report profiles with
  counterarguments, defensive fixes and evidence gaps.
- Add a stdio MCP server, local checked-request preparation, and revocable hosted
  connections sharing the website's daily allowance.
- Add the account portal: usage, recent review metadata, billing, passkeys,
  recovery rotation, account export, token management and sign-out of all devices.
- Hash connection secrets, expire them after 90 days, and keep billing and account
  administration outside token permissions. Retain exact-origin and CSRF checks.
- Preserve billing-linked accounts when billing is unavailable; require the
  billing support path before deleting their local account record.
- Publish the report guide, template, AI setup guide and Bounty Operator domain.
- Keep provider credentials, uploaded code and review text out of persistent storage.

## 0.5.0 — 2026-10-02

Includes the changes prepared as 0.4.0 on 2026-09-30, which was never tagged.

- Launch the Bounty Operator website on Cloudflare with passkey accounts, one
  free review per UTC day, and a US$10/week subscription using the customer's AI key.
- Add request previews, checked-text hashes, evidence notes, prompt export, and
  downloadable review packets. Keep uploaded files, keys, and results out of storage.
- Enforce daily quotas and one concurrent review per account in D1; restore the
  free allowance after provider failure. Validate Stripe prices, signed webhooks,
  current payment state, cancellations, refunds, and disputes before paid access.
- Check every text suffix and report missing, oversized, binary, linked, unreadable,
  invalid, and excluded inputs with bounded scan coverage.
- Read AI inputs once, add network-free `--dry-run`, bound responses, refuse
  redirects, and keep upstream bodies out of CLI errors.
- Preserve existing generated output by default; add explicit `--force` and
  reject malformed or failed scanner output.
- Make reference downloads opt-in and preserve modified checkouts during updates.
- Add Windows/Linux CI, installed-wheel checks, web checks, and privacy regressions.
- Add the offline `pattern-stats` command: accepted and rejected counts per
  vulnerability pattern from a CC0 snapshot of public Sherlock judging.
- Add AI review preflight checks for sensitive input, binary files, absolute path
  labels, aggregate payload size, and transport security.
- Add exact deployment, live-programme verification, same-root prior-art, and
  strongest-rejection gates to generated hunt material.
- Add a contribution guide and a security policy.

## 0.3.0 — 2026-07-09

- Add the full AI bounty agent pack and the prompt library.

## 0.2.0 — 2026-07-09

- Add the `agent-brief` and `ai-review` commands, the AI agent flow guide and
  the recommended tools list.

## 0.1.0 — 2026-07-09

- Initial public release: `sanitize`, `slither-focus`, `init-ledger` and
  `prior-art`, the workflow guide and the reference installer script.
