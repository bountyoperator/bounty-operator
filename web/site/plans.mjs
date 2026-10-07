// The plan wording, in one place. Every page, card and FAQ that summarises
// Free or Operator reads these lines, so the offer reads the same everywhere.
//
// Pricing is fixed by SPEC section 2: Free = 1 review per day (00:00 UTC
// reset), Operator = US$10 per week. A "review" here is one run through
// bountyoperator.com on the user's own API key: the website's run, or
// run_review from a coding agent over MCP (the Worker counts both in
// web/src/quota.mjs). Not counted: copy-paste reviews in a chat app, and the
// three core profiles prepared over MCP (prepare_review) or run by the skills,
// which the agent's own model answers with no account.
//
// Plan cards and /pricing are buyer-facing: they say "on your API key", not
// "hosted review" or "core profile" (web/tests/pages-hosted.test.mjs).

export const PRICE = 'US$10 per week';

/** Free plan, one line. */
export const FREE_LINE = '1 review a day, any review type.';

/** Operator plan, one line. */
export const OPERATOR_LINE = 'Unlimited reviews, the Gauntlet, Panel review and 4 reviews at once.';

/** The chat-subscription route, as a plan bullet. */
export const CHAT_LINE = 'Unlimited copy-paste reviews in ChatGPT or Claude for code, Solidity and draft reports';

/** The coding-agent route of the three core review types, as a plan bullet. */
export const AGENT_LINE = 'Unlimited reviews by your coding agent’s own model for code, Solidity and draft reports';

/** The two uncounted routes as ticks on the Free cards of the home page and /pricing. */
export const CHAT_TICK = 'Unlimited copy-paste reviews in ChatGPT or Claude (3 review types)';
export const AGENT_TICK = 'Unlimited reviews by your coding agent’s own model (3 review types)';

/** What uses the review of the day. Said with NOT_COUNTED on /pricing, /terms, /mcp and /guide. */
export const COUNTED = 'Only a review that runs on your API key through Bounty Operator counts: on this site, or from your coding agent with `run_review`.';

/** What never uses it. */
export const NOT_COUNTED =
  'Copy-paste reviews in a chat app do not count, and neither do code, Solidity and draft-report reviews your coding agent’s own model writes with `prepare_review` or the skills. Those need no account.';

/** When the free review resets and what does not count. Said once, on /pricing and in the terms. */
export const RESET_LINE = 'The free review resets at 00:00 UTC. A review the provider fails, refuses or cuts off at the start does not count.';

/** Billing, one line. */
export const RENEWAL = 'Billed weekly. Cancel any time in the Stripe portal and keep access until the paid week ends.';

/** Why pay when the user already pays a model provider. */
export const WHY_PAY =
  'Your provider charges for the model. The US$10 pays for Bounty Operator: no daily limit, the Gauntlet, Panel review and 4 reviews running at once. Model usage is not included.';
