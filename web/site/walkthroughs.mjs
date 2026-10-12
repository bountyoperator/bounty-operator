import { html } from './components.mjs';

const CLIPS = {
  spec: {
    file: 'spec-intro',
    label: 'Meet Spec: a bug with standards',
    square: true,
    note: '20 seconds, with narration and captions. The review uses the public, invented Tessera Staking example.',
    transcript: [
      ['00:00', 'Critical? Spec has questions.'],
      ['00:04', 'Bounty Operator checks your bug report against the code and proof before you submit.'],
      ['00:11', 'In this example, rewards are affected. Principal is untouched.'],
      ['00:16', 'Try the public example at bounty operator dot com.'],
    ],
  },
  product: {
    file: 'product-tour',
    label: 'Bounty Operator product walkthrough',
    note: '54 seconds, no sound. Actual screens from the saved public example. Tessera Staking is an invented protocol.',
    transcript: [
      ['00:00', 'See what needs fixing before you submit. The tour opens the public Bounty Operator example.'],
      ['00:04', 'Add your evidence: the draft report, source code, proof and known issues. The example contains four files.'],
      ['00:12', 'Choose your review route: your own API key or a chat subscription. This tour loads the saved example rather than running another model review.'],
      ['00:18', 'Read the verdict: rewrite, then submit. The reward-theft finding is supported, but the Critical impact claim is not.'],
      ['00:27', 'Inspect the claim table. The review marks overstated claims and links its objections to the supplied file and line.'],
      ['00:35', 'Open the cited source. Line 115 of TesseraStaking.sol rejects a payout above rewardReserve, limiting this payout to the reward reserve.'],
      ['00:43', 'Download the review packet to keep the verdict, source citations and SHA-256 file manifest together.'],
      ['00:50', 'Try the public example at bountyoperator.com and follow the evidence yourself.'],
    ],
  },
  mcp: {
    file: 'mcp-walkthrough',
    label: 'Bounty Operator MCP walkthrough',
    note: '75 seconds, no sound. Recorded MCP calls with the public, invented Tessera Staking example. Your agent’s normal model costs apply.',
    transcript: [
      ['00:00', 'Keep the review in your coding agent: connect the endpoint, challenge a draft, then keep the evidence packet.'],
      ['00:06', 'For Codex, add the remote endpoint with the terminal command below. No local server package is needed. Core report reviews require no Bounty Operator account or provider key.'],
      ['00:17', 'Ask your agent: Use bounty-operator to challenge draft-report.md against src/TesseraStaking.sol and the supplied proof and programme rules. Answer the prepared request, then build the packet. The example sends four public files and programme context. The remote endpoint receives the file text your agent sends.'],
      ['00:28', 'prepare_review returns a privacy check, file hashes and the review request. Your agent’s own model answers that request. The captured response prepared four files with no privacy findings. The screen shows one manifest entry: TesseraStaking.sol, 5,704 bytes and 152 lines, with its SHA-256 hash.'],
      ['00:40', 'The Codex review says rewrite, then submit: reward theft is supported; principal theft and permanent principal lock are not. It cites TesseraStaking.sol lines 110–118. claim() rejects a payout above rewardReserve. The synthetic programme rules classify theft of unclaimed rewards as Medium. This capture reviewed the source; it did not rerun the supplied test.'],
      ['00:53', 'build_packet checks citation locations and creates a Markdown packet. The captured result has ok: true, verdict: rewrite-then-submit and an empty referenceProblems list. It retains the four-file manifest and SHA-256 hashes. Valid citation locations do not by themselves prove a vulnerability.'],
      ['01:07', 'Keep your workflow and the evidence. This core review uses your agent’s own model, with no Bounty Operator account. Your agent’s normal model costs apply. Hosted reviews are a separate route. Setup is at bountyoperator.com/mcp.'],
    ],
  },
};

/** Native controls and a text alternative; no player script or third-party embed. */
export function walkthrough(kind, headingId) {
  const clip = CLIPS[kind];
  if (!clip) throw new Error(`Unknown walkthrough: ${kind}`);
  const base = `/videos/${clip.file}`;
  return html`<figure class="walkthrough">
<video class="walkthrough__video${clip.square ? ' walkthrough__video--square' : ''}" controls playsinline preload="none" width="${clip.square ? 1080 : 1920}" height="1080" poster="${base}.jpg" aria-label="${clip.label}" aria-describedby="${kind}-video-note">
  <source src="${base}.mp4" type="video/mp4">
  <track kind="captions" src="${base}.vtt" srclang="en" label="English">
  <a href="${base}.mp4">Download video: ${clip.label}.</a>
</video>
<figcaption class="walkthrough__note" id="${kind}-video-note">${clip.note} <a class="link" href="${base}.mp4" download>Download video</a></figcaption>
<details class="walkthrough__transcript">
  <summary>Read the transcript</summary>
  <div class="prose" aria-labelledby="${headingId}">
${kind === 'mcp' && html`<p>Codex setup command:</p><pre><code>codex mcp add bounty-operator --url https://bountyoperator.com/api/mcp</code></pre>`}
    <ol>${clip.transcript.map(([time, text]) => html`<li><strong>${time}</strong> ${text}</li>`)}</ol>
  </div>
</details>
</figure>`;
}
