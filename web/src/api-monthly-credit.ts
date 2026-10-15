// Included credit belongs to a verified paid subscription month, never an event.
import type Stripe from 'stripe';
import { localStripeTest } from './api-topups.ts';
import { seconds } from './env.ts';
import type { Env } from './env.ts';
import { inferenceModels } from './inference.ts';
import { supplierBudgetCreditStatements } from './supplier-costs.ts';

const PRICE_CENTS = 1000;
const CREDIT_MICRO = 2000000;
const idOf = (value: string | { id: string } | null | undefined): string | null => typeof value === 'string' ? value : value?.id ?? null;
const cents = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const hasCredit = (amounts: { amount: number }[] | null | undefined): boolean => Boolean(amounts?.some(({ amount }) => amount !== 0));

interface Grant {
  invoice_id: string;
  account_id: string | null;
  customer_id: string;
  subscription_id: string;
  price_id: string;
  period_start: number;
  period_end: number;
  amount_micro: number;
  credited_micro: number;
  refunded_micro: number;
  dispute_at: number;
  dispute_blocked: number;
  dispute_open: number;
  revision: number;
}

interface InvoiceMonth {
  customer: string;
  subscription: string;
  price: string;
  start: number;
  end: number;
}

/** Historical invoice lines establish which month was purchased. A later plan
 * change or cancellation must neither create nor erase an earlier purchase. */
async function invoiceMonth(api: Stripe, invoice: Stripe.Invoice, priceId: string, live: boolean): Promise<InvoiceMonth | null> {
  const customer = idOf(invoice.customer);
  const subscription = idOf(invoice.parent?.subscription_details?.subscription);
  if (!priceId || !customer || !subscription || invoice.livemode !== live || invoice.status !== 'paid' || invoice.currency !== 'usd' ||
    !['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason ?? '') ||
    invoice.parent?.type !== 'subscription_details' || invoice.amount_due !== PRICE_CENTS || invoice.amount_paid !== PRICE_CENTS ||
    invoice.amount_remaining !== 0 || invoice.subtotal !== PRICE_CENTS || invoice.total !== PRICE_CENTS ||
    hasCredit(invoice.total_discount_amounts) || hasCredit(invoice.total_pretax_credit_amounts) ||
    invoice.pre_payment_credit_notes_amount !== 0 || invoice.lines.has_more || invoice.lines.data.length !== 1) return null;
  const line = invoice.lines.data[0];
  const parent = line.parent?.subscription_item_details;
  if (line.livemode !== live || line.invoice !== invoice.id || line.currency !== 'usd' || line.amount !== PRICE_CENTS || line.subtotal !== PRICE_CENTS ||
    line.quantity !== 1 || (line.quantity_decimal != null && Number(line.quantity_decimal) !== 1) ||
    line.parent?.type !== 'subscription_item_details' || !parent || parent.proration !== false || parent.subscription !== subscription ||
    (line.subscription != null && idOf(line.subscription) !== subscription) ||
    line.pricing?.type !== 'price_details' || idOf(line.pricing.price_details?.price) !== priceId ||
    Number(line.pricing.unit_amount_decimal) !== PRICE_CENTS || hasCredit(line.discount_amounts) || hasCredit(line.pretax_credit_amounts) ||
    !cents(line.period.start) || !cents(line.period.end) || line.period.end <= line.period.start) return null;
  const price = await api.prices.retrieve(priceId);
  if (price.id !== priceId || price.livemode !== live || price.currency !== 'usd' || price.unit_amount !== PRICE_CENTS ||
    price.type !== 'recurring' || price.billing_scheme !== 'per_unit' || price.transform_quantity ||
    price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1 || price.recurring.usage_type !== 'licensed') return null;
  const currentSubscription = await api.subscriptions.retrieve(subscription);
  if (currentSubscription.id !== subscription || currentSubscription.livemode !== live || idOf(currentSubscription.customer) !== customer) return null;
  return { customer, subscription, price: priceId, start: line.period.start, end: line.period.end };
}

interface PaymentState {
  charges: string[];
  refunded: number;
  blocked: number;
  open: number;
}

/** Verify cash backing, including before a first grant. Out-of-band payments,
 * incomplete lists and shared charges cannot prove this month's payment. */
async function paymentState(api: Stripe, invoiceId: string, customer: string, live: boolean): Promise<PaymentState | null> {
  const payments = await api.invoicePayments.list({ invoice: invoiceId, status: 'paid', limit: 100 });
  if (payments.has_more || !payments.data.length) return null;
  const state: PaymentState = { charges: [], refunded: 0, blocked: 0, open: 0 };
  let paid = 0;
  const paymentIds = new Set<string>();
  for (const payment of payments.data) {
    if (!payment.id || paymentIds.has(payment.id) || payment.livemode !== live || payment.status !== 'paid' || payment.currency !== 'usd' ||
      idOf(payment.invoice) !== invoiceId || !cents(payment.amount_paid) || payment.amount_paid === 0) return null;
    paymentIds.add(payment.id);
    let chargeId: string | null = null;
    let intentId: string | null = null;
    if (payment.payment.type === 'payment_intent') {
      intentId = idOf(payment.payment.payment_intent);
      if (!intentId) return null;
      const intent = await api.paymentIntents.retrieve(intentId);
      if (intent.id !== intentId || intent.livemode !== live || intent.status !== 'succeeded' || intent.currency !== 'usd' ||
        intent.amount_received !== payment.amount_paid || idOf(intent.customer) !== customer) return null;
      chargeId = idOf(intent.latest_charge);
    } else if (payment.payment.type === 'charge') {
      chargeId = idOf(payment.payment.charge);
    } else return null;
    if (!chargeId || state.charges.includes(chargeId)) return null;
    // Retrieve even an expanded charge: all adjustments use its current state.
    const charge = await api.charges.retrieve(chargeId);
    if (charge.id !== chargeId || charge.livemode !== live || charge.status !== 'succeeded' || !charge.paid || !charge.captured ||
      charge.currency !== 'usd' || charge.amount !== payment.amount_paid || charge.amount_captured !== payment.amount_paid ||
      idOf(charge.customer) !== customer || idOf(charge.payment_intent) !== intentId ||
      !cents(charge.amount_refunded) || charge.amount_refunded > charge.amount || (charge.refunded && charge.amount_refunded !== charge.amount)) return null;
    state.charges.push(chargeId);
    paid += payment.amount_paid;
    state.refunded += charge.amount_refunded * 10000;
    if (charge.disputed) {
      const disputes = await api.disputes.list({ charge: chargeId, limit: 100 });
      // An absent/incomplete dispute list is not proof that a charge is clear.
      if (disputes.has_more || !disputes.data.length) state.blocked = state.open = 1;
      for (const dispute of disputes.data) {
        if (idOf(dispute.charge) !== chargeId || dispute.livemode !== live) state.blocked = state.open = 1;
        else {
          if (!['won', 'warning_closed'].includes(dispute.status)) state.blocked = 1;
          if (!['won', 'lost', 'warning_closed'].includes(dispute.status)) state.open = 1;
        }
      }
    }
  }
  return paid === PRICE_CENTS ? state : null;
}

/** Issue at most $2 for each paid monthly invoice and subscription period.
 * A refund of any size revokes the whole included grant permanently. A dispute
 * win may restore it only if no refund has ever been observed. */
export async function syncMonthlyCredit(env: Env, api: Stripe, invoiceId: string, eventTime = 0): Promise<void> {
  const live = !localStripeTest(env);
  for (let attempt = 0; attempt < 3; attempt++) {
    let row = await env.DB.prepare('SELECT * FROM api_monthly_grants WHERE invoice_id = ?').bind(invoiceId).first<Grant>();
    if (row && !row.account_id) return;
    const invoice = await api.invoices.retrieve(invoiceId);
    if (invoice.id !== invoiceId) throw new Error('Monthly invoice verification failed');
    // Stored grants retain their historical price when new checkout pricing changes.
    const month = await invoiceMonth(api, invoice, row?.price_id ?? env.STRIPE_PRICE_ID, live);
    if (!month) return;
    const account = await env.DB.prepare('SELECT id FROM accounts WHERE stripe_customer = ?').bind(month.customer).first<{ id: string }>();
    if (!account) return;
    if (row && (row.account_id !== account.id || row.customer_id !== month.customer || row.subscription_id !== month.subscription ||
      row.period_start !== month.start || row.period_end !== month.end)) throw new Error('Monthly credit ownership verification failed');
    const observed = await paymentState(api, invoiceId, month.customer, live);
    if (!observed) return;
    if (!cents(invoice.post_payment_credit_notes_amount)) return;
    observed.refunded = Math.max(observed.refunded, invoice.post_payment_credit_notes_amount * 10000);
    if (!row) {
      const now = seconds();
      const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO api_monthly_grants
        (invoice_id, account_id, customer_id, subscription_id, price_id, period_start, period_end, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(invoiceId, account.id, month.customer, month.subscription, month.price, month.start, month.end, now, now).run();
      if (!inserted.meta.changes) {
        // Another invoice for the same service month must not issue more credit.
        const existing = await env.DB.prepare('SELECT invoice_id FROM api_monthly_grants WHERE subscription_id = ? AND period_start = ?')
          .bind(month.subscription, month.start).first<{ invoice_id: string }>();
        if (existing?.invoice_id !== invoiceId) return;
        continue;
      }
      row = { invoice_id: invoiceId, account_id: account.id, customer_id: month.customer, subscription_id: month.subscription,
        price_id: month.price, period_start: month.start, period_end: month.end, amount_micro: CREDIT_MICRO, credited_micro: 0,
        refunded_micro: 0, dispute_at: 0, dispute_blocked: 0, dispute_open: 0, revision: 0 };
    }
    const refund = Math.max(row.refunded_micro, observed.refunded);
    const freshDispute = !eventTime || eventTime >= row.dispute_at;
    const blocked = freshDispute ? observed.blocked : row.dispute_blocked;
    const open = freshDispute ? observed.open : row.dispute_open;
    const credit = refund || blocked ? 0 : CREDIT_MICRO;
    const now = seconds();
    const result = await env.DB.batch([
      // The trigger posts the adjustment and wallet balance in this transaction,
      // as ledger entry monthly:<invoice>:<new revision>.
      env.DB.prepare(`UPDATE api_monthly_grants SET credited_micro = ?, refunded_micro = ?, dispute_blocked = ?, dispute_open = ?,
        dispute_at = ?, revision = revision + 1, updated_at = ? WHERE invoice_id = ? AND revision = ?`)
        .bind(credit, refund, blocked, open, Math.max(row.dispute_at, eventTime), now, invoiceId, row.revision),
      ...observed.charges.map((charge) => env.DB.prepare('INSERT OR IGNORE INTO api_monthly_grant_charges(invoice_id, charge_id) VALUES(?, ?)').bind(invoiceId, charge)),
      // The supplier budget follows that ledger entry; a lost revision race adds nothing.
      ...supplierBudgetCreditStatements(env, inferenceModels(env),
        { ledgerId: `monthly:${invoiceId}:${row.revision + 1}`, source: `monthly:${invoiceId}`, deltaMicro: credit - row.credited_micro }, now),
    ]);
    if (result[0].meta.changes) return;
  }
  throw new Error('Monthly payment changed concurrently');
}

/** Reconcile every historical grant affected by a charge, even after its
 * subscription has renewed. The payment graph also finds a missed first grant. */
export async function syncMonthlyCreditForCharge(env: Env, api: Stripe, chargeId: string, eventTime = 0): Promise<boolean> {
  const live = !localStripeTest(env);
  const stored = await env.DB.prepare('SELECT invoice_id FROM api_monthly_grant_charges WHERE charge_id = ?').bind(chargeId).all<{ invoice_id: string }>();
  const invoices = new Set(stored.results.map(({ invoice_id }) => invoice_id));
  const charge = await api.charges.retrieve(chargeId);
  if (charge.id !== chargeId || charge.livemode !== live) return false;
  const intentId = idOf(charge.payment_intent);
  if (intentId) {
    const payments = await api.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: intentId }, status: 'paid', limit: 100 });
    for (const payment of payments.data) {
      if (payment.livemode === live && payment.payment.type === 'payment_intent' && idOf(payment.payment.payment_intent) === intentId) {
        const invoice = idOf(payment.invoice);
        if (invoice) invoices.add(invoice);
      }
    }
    // Revoke known grants before retrying discovery of an incomplete graph.
    for (const invoice of invoices) await syncMonthlyCredit(env, api, invoice, eventTime);
    if (payments.has_more) throw new Error('Monthly payment invoice list incomplete');
  } else {
    for (const invoice of invoices) await syncMonthlyCredit(env, api, invoice, eventTime);
  }
  return invoices.size > 0;
}
