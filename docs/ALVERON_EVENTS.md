# Alveron Fashion — Events & Webhooks Reference

Read-only reference describing every confirmed event source, lifecycle and side-effect in the Alveron Fashion
system, for the purpose of wiring automation (n8n / `alveron-automation`).

**Summary of the event architecture (verified):**
- **One inbound webhook:** Paystack → `POST /orders/paystack/webhook` (`charge.success`), HMAC-verified.
- **No outbound webhooks, no message queue, no cron/scheduler anywhere** in `apps/api` (grep of the whole src for
  `@Cron`, `SchedulerRegistry`, queues, `setTimeout`-based schedulers found nothing). All other "events" are
  **database state changes** produced by HTTP handlers.
- The only periodic-ish mechanism is `processPendingReferrals()`, which is **not scheduled** — it runs as a side
  effect of two read endpoints (`GET /referrals/me/stats`, `GET /referrals/admin/stats`). See §5.
- The web storefront does **not** subscribe to Supabase Realtime / WebSockets (grep found none); notification is
  via polling the REST API and in-app `notifications` rows.

---

## 1. CONFIRMED event: Paystack charges (payments)

### Trigger
- Paystack sends webhook `event: "charge.success"` → `POST /api/orders/paystack/webhook`.

### Verification performed by the API (before any action)
1. `PAYSTACK_SECRET_KEY` must be configured and `req.rawBody` present, else `401`.
2. Recomputes `HMAC-SHA-512(secret, rawBody)` and compares with `x-paystack-signature` using
   `crypto.timingSafeEqual` — length mismatch ⇒ `401`.
3. If `NODE_ENV === 'production'`, client IP must be one of
   `52.31.139.75`, `52.49.173.169`, `52.214.14.220`, else `401`.

### Payload handled (`body`)
`{ event, data: { reference, amount, currency, status, ... } }`. Only `charge.success` is processed. All other
events return `{ received: true }` without action.

### Actions on a valid `charge.success`
1. Look up `payments` by `provider_reference = data.reference` (404 if absent).
2. Validate `transaction.reference === payment.provider_reference && amount === payment.amount &&
   currency === payment.currency` — mismatch ⇒ `400`, no state change.
3. Call RPC `confirm_paystack_payment(p_payment_id, payment.id, gateway = payload.data)` which:
   - Idempotency: if `payments.status` is already `SUCCESS` → returns `{confirmed: true, idempotent: true}`, no re-run.
   - Amount/currency re-check (`amount === orders.total * 100`, `NGN`); fails → `VERIFICATION_FAILED`.
   - Inventory sufficiency re-check; fails → `VERIFICATION_FAILED` + review flag
     (`admin_logs action='PAYMENT_INVENTORY_REVIEW'`), order reset to `status='pending'`.
   - Success path: decrements `product_variants.stock`; `payments → SUCCESS`; `orders →
     payment_status='SUCCESS', payment_method='paystack', payment_ref=paystack_ref, payment_date=now(),
     status='paid'`; deletes the source cart items; bumps `coupons.used_count` (see DB doc §6.2);
     inserts `order_events(order_id,'paid', 'Payment confirmed by Paystack')` and
     `admin_logs action='PAYMENT_SUCCESS'`.
4. If non-idempotent, the service also sends the **order confirmation email** via
   `require('../../../src/lib/email-templates')` — **this module does not exist in `apps/api/src/lib`
   (verified)**, so the email silently fails (errors logged, `sendEmailNotification` catches). See §5.

### Also (same flow, initiated by the client)
- `POST /orders/paystack/verify` runs an equivalent flow after calling Paystack `transaction/verify`
  (requires AuthGuard, order ownership). It shares the exact same `confirmPaystack` path, so results are
  idempotent with the webhook.

---

## 2. CONFIRMED event: order lifecycle (status transitions)

### Actor
- Admin via `PATCH /orders/:id/status` (Roles admin). Also implicitly by payment confirmation (paid) and
  customer "return requested" (initiates `return_requested`).

### Transition enforcement (strict map)
```
pending → cancelled
paid → processing | cancelled | return_requested
processing → packed | cancelled
packed → ready_for_shipment
shipped → in_transit | delivered
in_transit → delivered
delivered → return_requested
return_requested → under_review
under_review → return_approved | cancelled
return_approved → item_received
item_received → refund_completed
cancelled → refunded
```
Anything else ⇒ `400 Cannot move order from X to Y`.

### Side effects of each transition (verified in `orders.service.updateOrderStatus`)
- **Timestamps:** moving to the "final" state writes: `paid→payment_status='paid',payment_date`;
  `delivered→delivered_at`; `cancelled→cancelled_at`; `refunded|refund_completed→refunded_at`.
- **Inventory RPCs:** `paid→reserve_order_inventory`; `cancelled|refunded|refund_completed
  →release_order_inventory`; `delivered→finalize_order_inventory`.
- **Audit:** always inserts `admin_logs(action='order_status_changed', details='X -> Y')`.
- **Customer notification:** always inserts `notifications(user_id, type='order', title='Order <status>', data[order_id,status])` when the order has a `user_id`.
- **Email:** `sendEmailNotification(...)` type `status` — same broken path as confirmation email (§5).
- **On `delivered`:**
  - upserts `review_requests(order_id, user_id, 'awaiting')` (best-effort);
  - calls `referralService.qualifyReferral(orderId)` — **but see §5**: qualification only completes if the return
    window (`delivered_at + return_window_days`) has already passed, which on the day of delivery it has not.
- **On `cancelled | refunded | refund_completed | return_requested`:** calls
  `referralService.cancelReferral(...)` (best-effort) → referral to `cancelled` (only if `pending|qualified`).

### Emitted-but-manual output events (candidates for your automation)
- `order_events` row per status (the canonical order event log).
- `admin_logs` row per change.
- `notifications` row for the customer.

---

## 3. CONFIRMED event: returns lifecycle

### Actor
- Customer submits via `POST /returns` (Auth). Admin drives status via `PATCH /admin/returns/:id/status`
  and `POST /admin/returns/:id/more-info`.

### Status machine
`pending → under_review | approved | rejected` · `under_review → approved | rejected` ·
`approved → item_received | refund_completed` · `item_received → refund_completed` ·
`rejected` and `refund_completed` are terminal. `requestMoreInfo` forces `under_review`.

### Hard requirements
- Return window: 48h from `orders.delivered_at` (customer-facing eligibility returns codes
  `NOT_DELIVERED` / `ALREADY_REQUESTED` / `EXPIRED`).
- `refund_completed` requires an integer `refundAmount ≥ 0`, a `refundMethod`
  (`original_payment_method` | `store_credit` | `bank_transfer` | `crypto`) and a `refundReference`.
- `rejected` requires an admin note (becomes the customer-facing reason).

### Side effects
- Each transition inserts a `notifications(user_id, type='return', title/body preset)` and sends a customer
  **email via Resend** (`mail.service.sendReturnUpdate` — THIS one works when `RESEND_API_KEY` is set).
- New return submission also fires `notifyStaff` (row per active employee) → `notifications(user_id=<employee>, type='return', link='/admin/returns/<id>')`.
- Timestamps written: `approved_at`, `rejected_at`, `received_at`, `completed_at`.
- **No order-status change is made automatically by the returns module** (no "return_requested" transition is
  triggered from the returns module; that transition is only reachable via order status, §2).

---

## 4. CONFIRMED event: reviews lifecycle

- **New review:** `POST /reviews` (Auth, must have purchased). Inserts `reviews` row `status='pending'`,
  `is_verified` when the order is `delivered`, flips the related `review_requests` row to `submitted`, fires
  `notifyStaff` (`type='review'`, "New review awaiting approval"). Product rating is **not** refreshed here.
- **Moderation:** `PATCH /admin/reviews/:id/status` (`reviews:approve`). Status set to
  `approved|rejected|hidden|pending`; always refreshes `products.avg_rating`/`review_count` (approved only);
  writes `admin_logs` (`review_<status>`); on `approved` notifies the reviewer ("Your review is live"), on
  `rejected` notifies with the admin note.
- **Featured:** `PATCH /admin/reviews/:id/featured` toggles `is_featured` + audit log.
- **Deletion:** customer or admin delete recomputes the product rating.

---

## 5. CONFIRMED event: referral & credit qualification — PARTIALLY WIRED

### Flow (as designed)
`pending` (referral attached at order creation, discount applied) → on delivery `qualifyReferral` runs → if
`delivered_at + return_window_days ≤ now` and payment `SUCCESS/paid` → `qualified` → `rewarded` (a
`credit_transactions` row `type='referral_reward'`, `status='available'`, `expires_at = now + credit_expiry_days`).
Cancellation path: `cancelReferral` on `cancelled|refunded|refund_completed|return_requested`.

### Reality (verified, important for automation)
- `processPendingReferrals()` exists but **has no scheduler**. It only runs when a user/ admin visits:
  `GET /referrals/me/stats` and `GET /referrals/admin/stats`. Its effect is global (scans *all* pending referrals).
- `qualifyReferral` is called on delivery but early-returns because the return window (default 2 days) has not
  elapsed. So, in practice, rewards are granted **only** when someone happens to hit those two endpoints after the
  window — or by an external process.
- `credit_transactions` rows can be `pending` (never set by current code — only `available/used` are written;
  `expired/reversed` are read-time labels in some endpoints and never materialized). The expiry itself is
  **evaluated at read time** (`getBalance`, `getTransactions`, `validateRedemption`), not written to the row.
- Award idempotency is enforced twice: app-side check + partial unique index `credit_transactions(referral_id)`.

**Automation implication:** an n8n workflow is effectively **required** to make referral rewards happen on time
(poll `referrals` where `payment_status` is paid + `delivered_at + window ≤ now` and `status='pending'`, then call
the current code path or write directly). This is a NOT-CURRENTLY-AUTOMATED business process.

---

## 6. CONFIRMED event: staff notifications fan-out (`notifyStaff`)

Inserted **in bulk** (one row per `employees` with `status='active'`):

| Source event | type | title | link |
|---|---|---|---|
| New order (`createOrder`) | `order` | "New order" | `/admin/orders` |
| New return submission | `return` | "New return request" | `/admin/returns/<id>` |
| New review awaiting approval | `review` | "New review awaiting approval" | `/admin/reviews` |

- The customer notification on order-status change inserts a single row for `orders.user_id` (see §2).
- Consumers read them via `GET /admin/notifications` (EmployeeGuard).

---

## 7. Audit trail (`admin_logs`) — a write-stream you can rely on

Confirmed actions written by application code:

| Action | Where |
|---|---|
| `PAYMENT_SUCCESS`, `PAYMENT_INVENTORY_REVIEW` | Paystack RPC (011) |
| `order_status_changed` (`X -> Y`) | orders service |
| `courier_updated` | orders service (fulfilment) |
| `review_approved/rejected/hidden/pending/featured/unfeatured/deleted` | reviews service |
| `role_created/updated/deleted` | RBAC controller |
| `settings_updated` | referrals updateSettings |
| customer lifecycle actions (`customer_*`, e.g. `customer_verification_resent`) | customers service |
| employee lifecycle actions | employees service |

The audit module exposes `GET /admin/audit-logs` (permission `system_logs:view`) but **no webhook/filter exists**
server-side — automation that wants a real-time audit stream must poll or attach a notification trigger.

---

## 8. Emails — status per type

| Email | Status | Mechanism |
|---|---|---|
| Return status updates | **WORKS** | `mail.service.sendReturnUpdate` ⇢ Resend (requires `RESEND_API_KEY`; `RESEND_FROM` default `Alveron <onboarding@resend.dev>`) |
| Employee invite / reset | **WORKS** | employees.service ⇢ `mail.send` (Resend) |
| Customer status / reset / verification | **WORKS** | customers.service ⇢ `mail.send` (Resend) |
| Order confirmation / status updates | **BROKEN (referenced only)** | orders.service dynamically `require`s `apps/api/src/lib/email-templates` which **does not exist** in the repo → every call throws inside a `try/catch` and logs `Failed to send email notification`. No order emails are actually delivered. |
| WhatsApp | **NOT IMPLEMENTED** | `store_settings['whatsapp']` key and a web hook exist (frontend button w/ pre-filled message); no server-side `twilio`/WhatsApp provider calls found. Comment in migration 007 says notifications table was built with a "future WhatsApp slot". |

---

## 9. Proposed event catalog for `alveron-automation` (n8n)

### Wait, do these exist today? — No. These are **proposals** for the n8n project, built on the confirmed mechanics above.

| Proposed event / trigger | Data source (poll or hook) | Suggested trigger condition |
|---|---|---|
| `order.paid` | `POST /orders/paystack/webhook` (existing) or poll `payments` / `orders.payment_status IN ('SUCCESS','paid')` | New row / status change |
| `order.delivered` | poll `orders.status='delivered'` or `order_events.status='delivered'` | New event row |
| `shipment.tracking_added` | poll `orders.courier_name/tracking_number` changes | fields populated |
| `return.requested` | poll `returns.status='pending'` or → `notifyStaff` row | New `return` notification |
| `return.refund_completed` | poll `returns.status='refund_completed'` | transition |
| `review.pending` | poll `reviews.status='pending'` | insert |
| `inventory.low_stock` | poll `product_variants.stock <= products.low_stock_alert` | derived |
| `referral.qualified` / `referral.rewarded` | poll `referrals` transitions **or** scheduled job calls `processPendingReferrals`-equivalent logic | time-based |

### Recommended integration posture
1. **Prefer the existing webhook** for payment events — it already handles idempotency and signature checks; do not
   build a second Paystack consumer.
2. **For everything else, drive from the database** using the service-role connection (the app itself does): poll on
   a cadence, using created_at/updated_at watermarks, and treat `order_events`/`admin_logs`/`notifications` rows as
   the append-only signals.
3. **Do not create external Postgres triggers** unless planned against the app's own write paths — the app performs
   multiple sequential writes per operation; triggers keyed on intermediate rows could fire spuriously.
4. **Idempotency:** payment confirmation (RPC) and key mutations are already idempotent at the DB level where it
   matters. For any webhook n8n hosts, replay-safe ordering by `payments.provider_reference`/`order_events.id`.

---

## 10. Unknowns / to confirm in production

- Actual public hostname & whether nginx (or equivalent) preserves `rawBody` for the Paystack webhook.
- Whether `NODE_ENV=production` (activates webhook source-IP allow-listing).
- Whether `RESEND_API_KEY`, `PAYSTACK_SECRET_KEY`, `APP_URL` are actually set (order confirmation emails and
  paystack would otherwise fail/mock).
- Whether any external scheduler already calls `processPendingReferrals` (nothing in this repo does).
- Live confirmation of tables flagged as `REFERENCED/EXPECTED` in the database doc (carts, cart_items,
  wishlist_items, addresses).