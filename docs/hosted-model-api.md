# Hosted model API operations

The hosted API uses the existing passkey accounts, Cloudflare Worker and D1
database. The `/v1/` endpoints accept inference keys, which cannot change an
account or buy credit. Review connection tokens and inference keys are separate.

## Configuration

The public Wrangler template leaves both `INFERENCE_ENABLED` and
`API_TOPUPS_ENABLED` false. Set the runtime secret `RUNPOD_API_KEY` through
Wrangler's secret store. Do not put it in a tracked config or browser asset.

`INFERENCE_MODELS` is a JSON array with these fields:

| Field | Meaning |
| --- | --- |
| `id`, `name` | Public model identifier and display name |
| `source`, `revision`, `license`, `quantization` | Exact weights and redistribution provenance |
| `endpoint` | HTTPS Runpod load-balancer origin; caller URLs are never accepted |
| `upstreamModel` | Model name served by vLLM |
| `context`, `maxOutput` | Input/output limits enforced by the gateway |
| `inputRate`, `outputRate` | Whole US dollars per million tokens |
| `minimumMicro` | Minimum billed request cost, in millionths of a US dollar |
| `description`, `tags` | Short customer description and search/filter tags |
| `capabilities` | Verified `text`, `tools`, `streaming`, `structured_output`, or `reasoning` support |
| `reasoningParameter` | Hybrid model control: `thinking`, `enable_thinking`, or `reasoning_effort`; defaults to direct answers |

Up to 32 validated entries share the catalog used by the public page, account,
`GET /v1/models`, and `GET /v1/models/{id}`. Discovery does not start a worker.
The gateway rejects unsupported capabilities before reserving credit. For Nex,
it keeps the reasoning template setting and the Qwen parser setting in sync.
Customers can explicitly enable reasoning using the documented model parameter.

Use a pinned image and model revision. Disable prompt/response logging and
cross-request prefix caching in the serving engine. Validate streaming usage
counters, tool parsing and the chat template with the exact deployed quantization.
Keep the worker at zero minimum replicas until paid demand justifies continuous
capacity; measure cold-start and generation costs before choosing rates.

Cold startup has a ten-minute allowance, followed by a five-minute generation
allowance. Credit reservations expire after twenty minutes so the reaper cannot
release an active request's hold during the normal timeout window. Recommend a
twenty-minute client timeout. Failed startup with no usage is not charged.

## Payments and release

Top-ups use one-time Stripe Checkout payments for US$20, US$50 or US$100, or
optional customer-authorized automatic top-ups (off by default) with a chosen
amount (US$20, US$50 or US$100), balance threshold (US$5, US$10 or US$20) and
UTC monthly cap (US$20, US$50, US$100, US$200 or US$500). New US$10 monthly
Operator subscriptions also issue US$2 in API credit per verified paid monthly
invoice; existing weekly subscriptions keep their weekly interval without
monthly credit. Credit is posted only after server-side verification of the
account, customer, currency, amount, captured charge and settled PaymentIntent
or Invoice. Redirect query parameters never grant credit. The ledger and
reservations are atomic in D1.

Preserve existing subscription events and enable these events on the shared
Stripe webhook endpoint:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `payment_intent.requires_action`
- `setup_intent.succeeded`, `setup_intent.setup_failed`, `setup_intent.canceled`
- `payment_method.detached`
- `invoice.paid`, `invoice.updated`
- `charge.refunded`
- `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`

Automatic top-ups also require `API_AUTOTOPUPS_ENABLED=true`; an absent or false
value keeps new automatic setups, changes and payments closed. Set it only after
the required Stripe permissions and webhook events are verified. Disabling stays
available, and payments already initiated continue to reconcile.

Model availability requires a configured provider credential, verified unexpired
`SUPPLIER_COST_RULES` for that model and a funded current supplier budget window.
No pricing rule or no remaining supplier allowance means unavailable, even when
a customer has credit. The website catalog retains unavailable models with their
individual status; `/v1/models` lists only available models. These budgets limit
admitted work, not an upstream provider's actual bill, and nothing here refills a
provider account.

Supplier budgets grow automatically from confirmed customer credit. When a paid
top-up (manual or automatic) or a monthly Operator credit grant is credited to a
wallet, the same D1 transaction adds `SUPPLIER_BUDGET_SHARE` of that amount
(a decimal from 0 to 1, default `0.9`) to the current budget window of every
provider with a sellable model: one enabled in `INFERENCE_MODELS` with an
unexpired cost rule. Each such provider receives the full share. With no window
covering the present, the credit opens an enabled 30-day window, ended early
where a later window starts. A disabled window covering the present is a pause:
it receives the share and no automatic window opens beside it. A refund or
dispute removes the share that payment added, at the rate it was added, but
never takes a window below its reserved plus consumed allowance. Each change is
recorded once per ledger entry and provider in `supplier_budget_adjustments`, so
a replayed Stripe event or resync adds nothing. When a window ends, its unspent
customer-funded allowance (reserved holds count as spent) moves into the current
window, opening one if needed; operator-funded allowance still ends with its
window. The move happens on the next credit, on the 15-minute scheduled run, or
when a request finds no funded window. A share of `0` turns automatic funding and
these moves off; refunds still remove what earlier payments added. Operator
funding can still be added as a manually inserted window, and the very first
window still needs either operator funding or a monthly grant, since top-ups
stay closed while no model is available. Apply migration
`0007_supplier_budget_from_credit.sql` before deploying a Worker that writes
this table: without it every credit fails and waits for Stripe's retry, and
`/api/health` reports `db: error`.

Back up D1 and apply migrations before enabling inference. Keep customer
top-ups closed during model acceptance. Run the affected tests, type check,
private-profile checks, and `npm run deploy:check` from `web/`. Deploy using
`npm run deploy`; then run `npm run verify:live -- --base-url YOUR_ORIGIN`.
Read back the public catalog and a real request through the deployed gateway.

The payment acceptance test must cover settled payment, replay, wrong account,
refund, disputes, and out-of-order events. Real Stripe test-mode integration is
allowed only with `BILLING_MODE=test`, a localhost origin and a test secret.
Production requires live events and a live key. Test a live checkout's creation
and contents without paying yourself; Stripe test-mode payment is not evidence
of a real live settlement.

## Ongoing operation

- `/api/inference/catalog` exposes service and per-model availability (`available`, `paused` or `unavailable`) and current rates. A RunPod funding pause blocks its models; an available direct provider can keep the service open. When no model is available, new manual and automatic customer purchases close. Paused requests return HTTP 503 (`inference_paused`) without charging or counting toward the caller's failure limit. The catalog contains no runtime secret or upstream endpoint.
- `/v1/usage` reports wallet and key limits; the account's Model API section
  shows requests and credit entries without storing content.
- The 15-minute scheduled task reaps expired request holds and reconciles
  pending top-ups. An ambiguous Checkout creation is resolved against Stripe
  before its local record can be closed.
- The existing daily task reads the last 72 complete UTC hours of RunPod
  serverless billing for the configured RunPod endpoint IDs, even while inference
  is disabled. It never calls worker health, generation or funding endpoints.
  Successful reads reconcile supplier cost records; a failed read reports
  `unknown` and preserves earlier records. Other providers are not treated as
  RunPod costs, and missing cost evidence is not reported as zero spend.
- Stripe refunds and disputes remove the corresponding credit. A negative
  balance prevents new spending. Account deletion waits for settled balances,
  released holds, completed checkouts and closed disputes.
- Request metadata is purged after 30 days. Keep payment/ledger records for
  accounting and disputes; account deletion detaches retained financial rows.
- Use explicit, uniquely referenced `operator_adjustment` ledger entries for
  an operator-funded acceptance test. Never represent a test grant as a payment.
  Revoke the test key and reverse unused test credit after verification.
- Closing `API_TOPUPS_ENABLED` stops new purchases. Closing
  `INFERENCE_ENABLED` stops new generations. Preserve wallets and payment
  reconciliation during an outage and communicate with affected customers.

Passing runtime compatibility checks does not establish security quality.
Evaluate new models against held-out authorized tasks, verify commercial terms,
measure actual throughput and costs, and publish only capabilities that passed.
