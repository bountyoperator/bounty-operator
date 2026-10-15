// /terms — plans, renewal, cancellation, refunds and the rules of use.
//
// Limits come from the engine (LIMITS) and SPEC section 2. Billing text follows
// the edits in .local/audit/w2/audit-legal-trust.md. The sentence that a review
// is not an audit or certification appears here and nowhere else on the site.

import { LIMITS } from '../../../public/review-core.mjs';
import { html, inline, table } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { DOCS_STYLES, docPage, facts, supportLink, time } from './_shared.mjs';
import { FREE_LINE, INCLUDED_API_CREDIT, NOT_COUNTED, OPERATOR_LINE } from '../../plans.mjs';

const PATH = '/terms';
const UPDATED = '2026-10-15';

const kb = (bytes) => `${bytes / 1000} KB`;
const thousands = (value) => value.toLocaleString('en-US');

const glance = facts(
  [
    { icon: 'check', title: 'Free', text: `${FREE_LINE} No payment method.` },
    { icon: 'refresh', title: 'Operator: US$10 per month', text: `${OPERATOR_LINE} Renews monthly until you cancel.` },
    { icon: 'clock', title: 'Cancel any time', text: 'Access runs to the end of the paid period.' },
    { icon: 'key', title: 'US$2 API credit per paid month', text: 'For the Bounty Operator API. Other model providers bill usage separately.' },
  ],
  { className: 'facts--glance' },
);

const service = html`
<p>Bounty Operator reviews the files you give it and argues against your finding before a triager does. It reads text. It runs no uploaded code and contacts no target.</p>
<p>A review is not an audit or certification, and it does not decide scope, duplicates, eligibility or rewards. What you submit is your call.</p>`;

const plans = html`<p>Free costs nothing. New Operator subscriptions cost US$10 per month and include ${INCLUDED_API_CREDIT}. The website and the MCP server share one allowance per account. The <a href="/pricing">pricing page</a> shows the two plans side by side.</p>`;

const plansTable = table({
  label: 'Plans',
  columns: [{ label: 'What you get' }, { label: 'Free' }, { label: 'Operator' }],
  dense: true,
  className: 'plans-table',
  rows: [
    [html`Reviews on your API key, on the website or with <code>run_review</code>`, '1 a day, any review type', 'Unlimited'],
    ['Reviews running at once', '1', '4'],
    ['Bounty Operator API credit', 'Add credit as needed', 'US$2 per paid month on the monthly plan'],
    ['Gauntlet and Panel review', 'Example only', 'Included'],
    [html`Copy-paste reviews, and reviews your coding agent’s own model writes with <code>prepare_review</code> or the skills (code security, Solidity, draft report)`, 'Unlimited, not counted', 'Unlimited'],
    ['Free tools, repo import, local history', 'Included', 'Included'],
  ],
});

const limits = html`
<p>Both plans accept up to ${LIMITS.files} UTF-8 text files per review, ${kb(LIMITS.fileBytes)} per file, ${kb(LIMITS.totalBytes)} and ${thousands(LIMITS.totalLines)} lines in total, with instructions up to ${thousands(LIMITS.promptChars)} characters.</p>
<p>A review is one review type run through our server on your key, from the website or with <code>run_review</code> through the MCP server. ${inline(NOT_COUNTED)} The free review resets at 00:00 UTC. A review the provider fails, refuses or cuts off at the start is not counted.</p>
<p>Our server adds the method of a hosted profile to your request and sends both to the provider you chose, under your key. No page, tool or download returns it. Do not use a review to obtain it: an answer that repeats the method is stopped and counts as a review.</p>
<p>One person per account. No bulk automation, resale or limit bypassing. Rate limits apply.</p>`;

const material = html`
<p>Give the service only material you own or are permitted to review, and permitted to share with the provider you select.</p>
<p>Take live secrets and other people’s personal data out first. The privacy check in the workbench flags what it finds before anything is sent.</p>
<p>Do not use the service to attack a target.</p>`;

const provider = html`
<p>You bring your own API key. Other model providers bill usage to you directly. The monthly Operator plan includes US$2 in Bounty Operator API credit per paid month; it does not pay other providers’ charges.</p>
<p>A hosted review sends your files and your key through our server to that provider. Our server adds the review method and stores none of the request or the answer.</p>
<p>A request that fails or times out can still be billed by the provider.</p>
<p>Prompt export of the three core profiles is free on both plans. You run the exported prompt in your own chat app or local model. Every other profile runs as a hosted review.</p>`;

const billing = html`
<p>New Operator subscriptions cost US$10 every month and renew automatically until you cancel. Stripe shows any tax before you pay.</p>
<p>That is US$120 over 12 months. No trial period: the Free plan is the trial. Cancel in the billing portal before renewal; access runs to the end of the paid period. Price changes are posted here 14 days ahead and never apply to a period already paid.</p>
<p>Existing weekly subscriptions keep their US$10 weekly price and billing interval shown in the Stripe portal until changed or cancelled. They are not automatically moved to the monthly plan and do not receive the monthly plan’s API credit.</p>
<p>If you paid and got no access, or the service was down for a material part of your paid period, we fix it or refund that charge. Otherwise a started period is not refunded. A refund, chargeback or failed renewal ends paid access. Your statutory consumer rights are unaffected.</p>
<p>For a billing problem, email ${supportLink()} with the receipt reference. Leave out card numbers, API keys, recovery codes and private reports.</p>`;

const accounts = html`
<p>Accounts use passkeys. There is no password.</p>
<p>Keep your recovery code private. Anyone who has it can sign in. Using it replaces it and signs out every session and connection token.</p>
<p>We suspend accounts used for abuse.</p>`;

const apiCredit = html`<p>The Model API uses prepaid credit and does not require a subscription. You may add US$20, US$50 or US$100 through Stripe. Each verified paid US$10 monthly Operator invoice also adds US$2 in API credit. Unpaid invoices and grace periods add no credit. Included credit rolls over without expiring, and cancelling a subscription does not remove credit from a paid month.</p>
<p>Auto top-ups are off by default. To opt in, save a payment method with Stripe and choose a top-up amount of US$20, US$50 or US$100, a balance threshold of US$5, US$10 or US$20, and a calendar-month cap of US$20, US$50, US$100, US$200 or US$500. The cap resets at the start of each month in UTC and limits automatic top-ups only. An automatic top-up may charge your saved method when available credit falls below your threshold and no request reservation is active. You can disable auto top-ups at any time; a payment already processing may still complete.</p>
<p>The model catalog shows the rates and minimum request charge before use. Input and output tokens are metered by the model server; output includes reasoning. A request with confirmed usage is charged at the greater of its token cost or the minimum, including when your client cancels a stream. Requests with no confirmed usage are not charged. A temporary reservation is released after settlement or, if processing is interrupted, after the reservation expires.</p>
<p>Credit does not expire, cannot be transferred to another account and is used only for this API. Contact ${supportLink()} to request a refund of unused purchased credit to the original payment method. We refund the unused purchased amount; credit already consumed is not refunded merely because a model answer was unhelpful. Included Operator credit has no separate cash refund; the subscription refund terms apply to its originating payment. Service failures and statutory consumer rights are handled separately and are not excluded by this term.</p>
<p>Refunds and chargebacks remove the related credit, including a monthly grant when its subscription payment is refunded or disputed. If that credit has already been spent, further requests stop until the resulting balance is settled. Set a limit and expiry for each key and revoke keys you no longer control.</p>
<p>Use the API only for authorized activity. Do not use it for unauthorized access, credential theft or deploying malware. The model can make mistakes and produces no guarantee of security, eligibility or bounty payment. Your client, not this API, executes any generated tool calls.</p>
<p>Model availability and capacity vary. An idle model can take time to start. Rates in effect when a request starts determine its charge; check the catalog before submitting requests. Your statutory consumer rights are unaffected.</p>`;

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
    { id: 'api-credit', title: 'Model API credit and use', body: apiCredit },
    { id: 'accounts', title: 'Accounts', body: accounts },
    { id: 'more', title: 'Privacy, source and changes', label: 'Privacy and changes', body: rest },
  ],
});

export default {
  path: PATH,
  title: 'Terms of service | Bounty Operator',
  label: 'Terms',
  description:
    'The Free and Operator plans, monthly billing, included API credit, legacy subscriptions, cancellation, refunds and the rules of use.',
  styles: DOCS_STYLES,
  jsonld: [breadcrumbsLd([{ name: 'Terms', path: PATH }])],
  lastmod: UPDATED,
  body,
};
