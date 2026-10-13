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

- `/api/inference/catalog` exposes availability and current rates. It contains
  no runtime secret or upstream endpoint.
- `/v1/usage` reports wallet and key limits; the account's Model API section
  shows requests and credit entries without storing content.
- The 15-minute scheduled task reaps expired request holds and reconciles
  pending top-ups. An ambiguous Checkout creation is resolved against Stripe
  before its local record can be closed.
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
