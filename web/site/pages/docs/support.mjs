// /support: where a user asks, suggests and reports.
//
// One page routes every kind of request, because they do not all belong in
// public. A question or an idea goes to the forum on GitHub, a bug to the issue
// form, an account or payment problem to email, and a vulnerability in Bounty
// Operator to the private report form. The forum is public and its readers are
// bug hunters, so the page says first what must stay out of it.
//
// The forum is GitHub Discussions on the source repository: it needs no new
// account system, anyone can read it without signing in, and a question that
// was answered once is found by search. The category slugs below are the ones
// the repository has; a test checks that every link here is one of them.

import { button, html, notice } from '../../components.mjs';
import { SITE, breadcrumbsLd } from '../../layout.mjs';
import { DOCS_STYLES, docPage, ext, facts, nextStep, securityLink, supportLink, time } from './_shared.mjs';

const PATH = '/support';
/** The day this page last changed. */
export const SUPPORT_UPDATED = '2026-10-09';

/** Where each kind of request goes. */
export const SUPPORT_LINKS = Object.freeze({
  forum: SITE.forum,
  ask: `${SITE.forum}/categories/q-a`,
  ideas: `${SITE.forum}/categories/ideas`,
  wins: `${SITE.forum}/categories/wins`,
  announcements: `${SITE.forum}/categories/announcements`,
  bug: `${SITE.source}/issues/new?template=bug.yml`,
  advisory: `${SITE.source}/security/advisories/new`,
});

const lead = html`${notice({
  tone: 'warn',
  title: 'The forum and the bug tracker are public',
  body: html`<p>Never post an unreported finding, a report draft, an API key, a connection token or a recovery code. To ask about a verdict, describe what happened and leave out the target and the bug.</p>`,
})}
${facts([
  { icon: 'info', title: 'A question', text: html`How to do something, or why a review said what it said. ${ext('Ask in Q&A', SUPPORT_LINKS.ask)}` },
  { icon: 'plus', title: 'An idea', text: html`Something the product should do, or do differently. ${ext('Post it in Ideas', SUPPORT_LINKS.ideas)}` },
  { icon: 'warn', title: 'A bug', text: html`Something does the wrong thing. ${ext('Open a bug report', SUPPORT_LINKS.bug)}` },
  { icon: 'lock', title: 'Your account or a payment', text: html`This one is private. Write to ${supportLink()}` },
])}`;

const ask = html`<p>${ext('Q&A', SUPPORT_LINKS.ask)} is for questions about using Bounty Operator: a review type, a provider or a model, the MCP server, a verdict you do not follow. An answer that settles the question is marked, so the next person finds it.</p>
<p>You need a GitHub account to post. Reading needs none. With no GitHub account, write to ${supportLink()} instead.</p>
<p>We keep no files, prompts or results, so nobody here can look your review up. Say which review type you ran, on which provider and model, and what came back.</p>`;

const suggest = html`<p>${ext('Ideas', SUPPORT_LINKS.ideas)} is for what the product should do next: a review type, a check, a platform template, a tool. Say where in a hunt it comes up and what you do today.</p>
<p>Vote on the ideas of others, so the ones most wanted stand out. Releases are posted in ${ext('Announcements', SUPPORT_LINKS.announcements)} and listed in the <a href="/changelog">changelog</a>.</p>`;

const bug = html`<p>${ext('The bug report form', SUPPORT_LINKS.bug)} asks where it happened, the version, the steps and what came back. The version is on the <a href="/changelog">changelog</a>; an error message is worth pasting word for word.</p>
<p>A review that reads wrong is not always a bug. If the model missed something or judged it badly, ${ext('Q&A', SUPPORT_LINKS.ask)} is the better place, and the <a href="/guide#model-refuses">guide</a> covers a model that refuses.</p>`;

const account = html`<p>Write to ${supportLink()} about sign-in, a lost passkey, a charge or a refund. Email is private; the forum is not.</p>
<ul>
<li><strong>A payment or a refund:</strong> give the receipt reference, so the subscription can be found. Leave out card numbers, API keys, recovery codes and private reports. The <a href="/terms">terms</a> say when a refund is due.</li>
<li><strong>Cancelling:</strong> open <a href="/#account">Account</a> and go to the billing portal. Access runs to the end of the paid week.</li>
<li><strong>A lost passkey:</strong> sign in with your recovery code and add a new passkey. We keep only a hash of the code, so we cannot read it back to you.</li>
</ul>`;

const security = html`<p>A vulnerability in Bounty Operator itself is reported in private: through ${ext('the report form on GitHub', SUPPORT_LINKS.advisory)} or to ${securityLink()}. <a href="/security#report">The security page</a> says what is in scope and how testing is to be done.</p>`;

const wins = html`<p>${ext('Wins', SUPPORT_LINKS.wins)} is for a hole the review caught before a triager did, or a report that paid. Post a finding only when the programme has resolved it and allows it to be told.</p>`;

const body = docPage({
  head: {
    crumbs: [{ label: 'Bounty Operator', href: '/' }, { label: 'Help and feedback' }],
    title: 'Help and feedback',
    lede: 'Ask a question, suggest a change, report a bug or reach us in private. Each has its own place.',
    meta: html`Last updated ${time(SUPPORT_UPDATED)}`,
    actions: html`${button({ label: 'Open the forum', href: SUPPORT_LINKS.forum, variant: 'primary', external: true, iconEnd: 'arrow-up-right' })}${button({ label: 'Email support', href: `mailto:${SITE.support}` })}`,
  },
  lead,
  sections: [
    { id: 'ask', title: 'Ask a question', body: ask },
    { id: 'suggest', title: 'Suggest a change', body: suggest },
    { id: 'bug', title: 'Report a bug', body: bug },
    { id: 'account', title: 'Account, payment and refunds', label: 'Account and payment', body: account },
    { id: 'security', title: 'A vulnerability in Bounty Operator', label: 'Vulnerabilities', body: security },
    { id: 'wins', title: 'Share a win', body: wins },
  ],
  after: nextStep({
    title: 'Not sure the report is ready?',
    text: 'The guide covers what a triager checks first, and the review argues against your draft before one does.',
    actions: html`${button({ label: 'Review my report', href: '/?profile=report#workspace', variant: 'primary', iconEnd: 'arrow-right' })}${button({ label: 'Report guide', href: '/guide' })}`,
  }),
});

export default {
  path: PATH,
  title: 'Help and feedback | Bounty Operator',
  label: 'Help and feedback',
  description:
    'Where to ask a question about Bounty Operator, suggest a change, report a bug, get help with an account or a payment, and report a vulnerability.',
  styles: DOCS_STYLES,
  jsonld: [breadcrumbsLd([{ name: 'Help and feedback', path: PATH }])],
  lastmod: SUPPORT_UPDATED,
  body,
};
