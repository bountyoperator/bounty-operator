// /terms — plans, renewal, cancellation, refunds and the rules of use.
//
// Limits come from the engine (LIMITS) and SPEC section 2. Billing text follows
// the edits in .local/audit/w2/audit-legal-trust.md. The sentence that a review
// is not an audit or certification appears here and nowhere else on the site.

import { LIMITS } from '../../../public/review-core.mjs';
import { html, table } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { DOCS_STYLES, UPDATED, docPage, facts, supportLink, time } from './_shared.mjs';

const PATH = '/terms';

const kb = (bytes) => `${bytes / 1000} KB`;
const thousands = (value) => value.toLocaleString('en-US');

const glance = facts(
  [
    { icon: 'check', title: 'Free', text: 'One hosted review per UTC day, any single profile. No payment method.' },
    { icon: 'refresh', title: 'Operator: US$10 per week', text: 'Unlimited hosted reviews, the Gauntlet, Panel review and four reviews at once. Renews weekly until you cancel.' },
    { icon: 'clock', title: 'Cancel any time', text: 'Access runs to the end of the paid week.' },
    { icon: 'key', title: 'Your key, your provider bill', text: 'The subscription does not include model usage.' },
  ],
  { className: 'facts--glance' },
);

const service = html`
<p>Bounty Operator reviews the files you give it and argues against your finding before a triager does. It reads text. It runs no uploaded code and contacts no target.</p>
<p>A review is not an audit or certification, and it does not decide scope, duplicates, eligibility or rewards. What you submit is your call.</p>`;

const plans = html`<p>Free costs nothing. Operator is US$10 per week. The website and the MCP server share one allowance per account. The <a href="/pricing">pricing page</a> shows the two plans side by side.</p>`;

const plansTable = table({
  label: 'Plans',
  columns: [{ label: 'What you get' }, { label: 'Free' }, { label: 'Operator' }],
  dense: true,
  className: 'plans-table',
  rows: [
    ['Hosted reviews', '1 per UTC day, any single profile', 'Unlimited'],
    ['Reviews running at once', '1', '4'],
    ['Gauntlet and Panel review', 'Example only', 'Included'],
    ['Prompt export and MCP prepare for the three core profiles', 'Included', 'Included'],
    ['Free tools, repo import, local history', 'Included', 'Included'],
  ],
});

const limits = html`
<p>Both plans accept up to ${LIMITS.files} UTF-8 text files per review, ${kb(LIMITS.fileBytes)} per file, ${kb(LIMITS.totalBytes)} and ${thousands(LIMITS.totalLines)} lines in total, with instructions up to ${thousands(LIMITS.promptChars)} characters.</p>
<p>A hosted review is one profile run through our server on your key, from the workbench or through the MCP server. A review the provider fails, refuses or cuts off at the start is not counted.</p>
<p>Our server adds the method of a hosted profile to your request and sends both to the provider you chose, under your key. No page, tool or download returns it. Do not use a review to obtain it: an answer that repeats the method is stopped and counts as a review.</p>
<p>One person per account. No bulk automation, resale or limit bypassing. Rate limits apply.</p>`;

const material = html`
<p>Give the service only material you own or are permitted to review, and permitted to share with the provider you select.</p>
<p>Take live secrets and other people’s personal data out first. The privacy check in the workbench flags what it finds before anything is sent.</p>
<p>Do not use the service to attack a target.</p>`;

const provider = html`
<p>You bring your own API key and pay the provider you select directly. The subscription does not include model usage.</p>
<p>A hosted review sends your files and your key through our server to that provider. Our server adds the review method and stores none of the request or the answer.</p>
<p>A request that fails or times out can still be billed by the provider.</p>
<p>Prompt export of the three core profiles is free on both plans. You run the exported prompt in your own chat app or local model. Every other profile runs as a hosted review.</p>`;

const billing = html`
<p>Operator costs US$10 every week and renews automatically until you cancel. Stripe shows any tax before you pay.</p>
<p>That is US$520 over 52 weeks. No trial period: the Free plan is the trial. Cancel in the billing portal before renewal; access runs to the end of the paid week. Price changes are posted here 14 days ahead and never apply to a week already paid.</p>
<p>If you paid and got no access, or the service was down for a material part of your week, we fix it or refund that charge. Otherwise a started week is not refunded. A refund, chargeback or failed renewal ends paid access. Your statutory consumer rights are unaffected.</p>
<p>For a billing problem, email ${supportLink()} with the receipt reference. Leave out card numbers, API keys, recovery codes and private reports.</p>`;

const accounts = html`
<p>Accounts use passkeys. There is no password.</p>
<p>Keep your recovery code private. Anyone who has it can sign in. Using it replaces it and signs out every session and connection token.</p>
<p>We suspend accounts used for abuse.</p>`;

const rest = html`
<p>The <a href="/privacy">privacy policy</a> lists what we store. The <a href="/security">security page</a> shows how it is protected.</p>
<p>The three core profiles, the free tools, the command-line kit and the MCP server are open source under the MIT licence. Using them needs no subscription. The gauntlet stages and the panel cross-examination run on the hosted service. The method of a hosted profile is not published, and the open-source licence does not cover it. The licence is on the <a href="/licenses">licences page</a>.</p>
<p>We update this page when the terms change. The date at the top is the current version.</p>`;

const body = docPage({
  head: {
    crumbs: [{ label: 'Bounty Operator', href: '/' }, { label: 'Terms' }],
    title: 'Terms of service',
    lede: html`Built by Tradi3. Sold and operated by Vaytric, the name on your Stripe receipt. Support: ${supportLink()}.`,
    meta: html`Last updated ${time(UPDATED)}`,
  },
  before: glance,
  sections: [
    { id: 'service', title: 'The service', body: service },
    { id: 'plans', title: 'Plans and limits', body: html`${plans}${plansTable}${limits}` },
    { id: 'material', title: 'Your material', body: material },
    { id: 'provider', title: 'Your AI provider', body: provider },
    { id: 'billing', title: 'Subscription, cancellation and refunds', label: 'Billing and refunds', body: billing },
    { id: 'accounts', title: 'Accounts', body: accounts },
    { id: 'more', title: 'Privacy, source and changes', label: 'Privacy and changes', body: rest },
  ],
});

export default {
  path: PATH,
  title: 'Terms of service | Bounty Operator',
  label: 'Terms',
  description:
    'The Free and Operator plans, the US$10 weekly renewal, cancellation, refunds and the rules for using Bounty Operator, in plain language.',
  styles: DOCS_STYLES,
  jsonld: [breadcrumbsLd([{ name: 'Terms', path: PATH }])],
  lastmod: UPDATED,
  body,
};
