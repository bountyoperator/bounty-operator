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

Payments fail closed on the RunPod funding state. When every usable model is
hosted on RunPod, a purchase needs the hosting API to confirm the account is
funded (`underBalance: false`). A worker answering `/health` with 200 does not
count, because a draining worker can answer on an account that has run out; a
worker's 402 closes payments at once. A non-200 answer, a redirect, a network
error, a five-second timeout, GraphQL errors, `myself: null`, a missing flag or
a malformed body leaves the state unknown. Manual top-ups, automatic setup and
automatic changes then answer HTTP 503 `topups_unavailable` with Retry-After 60
before any Stripe request. These decisions use an answer cached for one minute.
The scheduled task never does: each run reads the hosting API before its first
reservation or send, reuses that answer for ten seconds, and reads an unknown
answer once more after one second. If the run's answer is not funded, it
reserves nothing, and unsent reservations expire (status `expired`: nothing
reached Stripe) so the next run decides again from the current balance. The
send boundary also re-checks the consented trigger: a reservation left by a
stopped Worker is sent only while available credit is still below the
threshold and no request of that account is running. A reservation closed by a
disable, a settings change or that re-check expires the same way; `failed` is
kept for payments that reached Stripe. Payments already sent to
Stripe always reconcile. The catalog and model requests still show an unknown
state as available, and the worker probe decides each request. A setup that
completes during an outage turns the setting on, because that records consent
and moves no money; its first charge waits until hosting is confirmed funded.
An available direct provider keeps purchases open whatever the RunPod state.

Failing closed must not hide a sales outage. Each hosting read that leaves the
state unknown logs `Hosting status unknown; payments closed` with a reason
code: `http_<status>`, `redirect`, `network_error`, `timeout`,
`graphql_errors` (with the error count and the first error's code),
`no_account`, `no_flag` or `malformed_body`. A refused purchase logs
`Top-up refused; hosting status unknown`, and an unsent automatic reservation
logs `Automatic top-up not sent; purchases closed`. No log holds the key, a
response body or an upstream message. `GET /api/health` reports `topups`
(`open` or `closed`) and `topups_reason`: `disabled` (`API_TOPUPS_ENABLED` is
not true), `billing_not_ready`, `inference_unavailable`, `hosting_paused` or
`hosting_unknown:<reason>`. The purchase route, the catalog's
`topups_enabled`, the account panel and health take this one decision.
`npm run verify:live` fails when inference is available and top-ups are closed
for any reason but `disabled`, or when the catalog disagrees with health.

Model availability requires a configured provider credential, verified unexpired
`SUPPLIER_COST_RULES` for that model and a funded current supplier budget window.
No pricing rule or no remaining supplier allowance means unavailable, even when
a customer has credit. The website catalog retains unavailable models with their
individual status; `/v1/models` lists only available models. Customer payments and
monthly credit grants do not create supplier budgets or refill provider accounts.
Supplier funding must be recorded separately; these budgets limit admitted work,
not an upstream provider's actual bill.

Back up D1 and apply migrations before enabling inference. Keep customer
top-ups closed during model acceptance. Before opening top-ups on a RunPod-only
catalog, confirm that the production `RUNPOD_API_KEY` answers
`{ myself { underBalance } }` with HTTP 200, a boolean flag and no `errors`;
otherwise every purchase stays closed. Run the affected tests, type check,
private-profile checks, and `npm run deploy:check` from `web/`. Deploy using
`npm run deploy`; then run `npm run verify:live -- --base-url YOUR_ORIGIN`,
which also fails if top-ups closed after the deploy.
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
