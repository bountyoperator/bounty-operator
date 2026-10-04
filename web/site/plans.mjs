// The plan wording, in one place. Every page, card and FAQ that summarises
// Free or Operator reads these lines, so the offer reads the same everywhere.
//
// Pricing is fixed by SPEC section 2: Free = 1 review per day (00:00 UTC
// reset), Operator = US$10 per week. A "review" here is one run through
// bountyoperator.com on the user's own API key (the Worker counts it in
// web/src/quota.mjs). Copy-paste reviews in a chat app are not counted.

export const PRICE = 'US$10 per week';

/** Free plan, one line. */
export const FREE_LINE = '1 review a day, any review type.';

/** Operator plan, one line. */
export const OPERATOR_LINE = 'Unlimited reviews, the Gauntlet, Panel review and 4 reviews at once.';

/** The chat-subscription route, as a plan bullet. */
export const CHAT_LINE = 'Unlimited copy-paste reviews in ChatGPT or Claude for code, Solidity and draft reports';

/** When the free review resets and what does not count. Said once, on /pricing and in the terms. */
export const RESET_LINE = 'The free review resets at 00:00 UTC. A review the provider fails, refuses or cuts off at the start does not count.';

/** Billing, one line. */
export const RENEWAL = 'Billed weekly. Cancel any time in the Stripe portal and keep access until the paid week ends.';

/** Why pay when the user already pays a model provider. */
export const WHY_PAY =
  'Your provider charges for the model. The US$10 pays for Bounty Operator: no daily limit, the Gauntlet, Panel review and 4 reviews running at once. Model usage is not included.';
