# Alveron Fashion — REST API Reference

Read-only integration reference for the Alveron Fashion stack. Compiled from a source review of the
`apps/api` NestJS application (`HEAD` of the Alveron Fashion repository, September 2026). This document
describes only what is **actually implemented** in the API source code. Nothing here was invented for
automation convenience; anything referenced in code but not confirmed working is marked explicitly.

- Purpose: give the `alveron-automation` (n8n) project a trustworthy integration contract.
- One hard rule for automation: **do not modify the source, the API, or the database schema.** All integration
  is done through the endpoints documented below, or by reading the database through the existing service role.

---

## 1. System architecture (verified)

```
Internet
  │
  ├── Next.js storefront (apps/web) ── calls the NestJS API over HTTP ──┐
  │        (Bearer token = Supabase session JWT)                        │
  │                                                                     ▼
  ├── Supabase Auth (login/register, JWT issuance, email verification)
  │                                                                     
  Paystack (payment processing)
  │   ├─ browser redirect (paystack/initialize → authorization_url)
  │   └─ server-to-server webhook  ──► POST /api/orders/paystack/webhook
  │                                     (HMAC SHA-512 signature verified)
  ▼
NestJS API (apps/api) ── service-role ► Supabase Postgres (RLS bypassed)
```

- The web app is a **client** of the API: the storefront (`apps/web/src/lib/api/client.ts`) calls
  `NEXT_PUBLIC_API_URL || http://localhost:4000/api` and asserts the Supabase session access token as
  `Authorization: Bearer <token>`.
- The NestJS app communicates with Postgres exclusively through the Supabase JS client
  (`common/supabase.service.ts`): `getDb()` returns a **service-role** admin client that **bypasses Row Level
  Security**, and `getAuth()` returns an anon client used only for auth-admin operations (e.g. reading user
  emails by ID).
- External provider calls in the codebase: Paystack (initialize/verify/webhook), Resend (transactional email),
  Nominatim/OpenStreetMap (shipping reverse-geocode). No other outbound integrations were found.

### Production base URL

The API does not self-describe a production base URL or hostname. The only URL configuration is:
`FRONTEND_URL` (CORS origin / email links), `APP_URL`, and `PAYSTACK_CALLBACK_URL`. **The public/auto
base URL used in test environments and the `.env` files is `http://localhost:4000` (dev default).** The actual
production URL is **unknown and must be confirmed before automation is pointed at it.**

---

## 2. Global conventions

| Item | Value |
|---|---|
| Global prefix | `api` — every route below is served under `/api/...` |
| Default port | `4000` (from `PORT`) |
| Body parser | `rawBody: true` is enabled **globally** (required by the Paystack webhook HMAC) |
| Validation | Global `ValidationPipe` with `whitelist + forbidNonWhitelisted + transform`; unknown body fields are rejected |
| Security headers | `helmet` enabled; CSP `connect-src` includes `FRONTEND_URL` |
| CORS | origin = `FRONTEND_URL || http://localhost:3000` |
| Rate limiting | Global `ThrottlerGuard` 60 req/min/IP; `POST /api/auth/login` additionally throttled 5 req/min |
| Money (store level) | Integer `NGN` (whole naira), e.g. `total: 32000` |
| Money (Paystack level) | Kobo = value × 100, e.g. `amount: 3200000` in payment records / Paystack payloads |
| Time | ISO 8601 / `TimestampTZ` (Postgres returns ISO strings) |

### Authentication (all API calls, 3 modes)

1. **`Authorization: Bearer <JWT>`** — Supabase issued. `AuthGuard` calls `supabase.auth.getUser(token)`.
   Controllers that require it are marked `Auth` below.
2. **`Roles('admin')` + `RolesGuard`** — checks `profiles.role` for `admin` (or `staff`), and for users who are
   employees, the `employees → roles` table (`is_super_admin` / role slug). Controllers marked `Admin`.
3. **`Permissions('module:action')` + `PermissionsGuard`** — resolves the caller's `roles → role_permissions`
   (wildcard `*` = everything). Controllers marked `Admin · perm`.
4. **`EmployeeGuard`** — requires an `active` employee record. Controllers marked `Employee`.

Endpoint categories used throughout this document:

| Category | Meaning |
|---|---|
| `SAFE FOR AUTOMATION` | Public, idempotent-safe, low risk |
| `REQUIRES AUTHENTICATION` | Needs a customer `Bearer` JWT |
| `ADMIN ONLY` | `Roles('admin')` (legacy role or RBAC-based super access) |
| `ADMIN ONLY · PERM` | Behind a `module:action` permission |
| `INTERNAL ONLY` | Service-to-service; do not call directly from public clients |
| `DO NOT CALL DIRECTLY` | Side-effect heavy; prefer the documented flow |
| `NOT CURRENTLY SUITABLE FOR AUTOMATION` | Incomplete / broken / super-admin-only in practice |

HTTP responses: 2xx with JSON; 4xx/5xx return a NestJS error body (`statusCode`, `message`, `error`).

---

## 3. Endpoint inventory

Count: **~158 routes** across 27 controllers. Grouped by module. Exact counts verified from source
`@Controller`/`@Get/@Post/@Patch/@Delete` decorators.

### 3.1 Auth — `/api/auth`

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| POST | `/auth/register` | – | SAFE FOR AUTOMATION | Create account: `email, password, fullName?, username?` |
| POST | `/auth/login` | – | SAFE FOR AUTOMATION | `email, password`. Throttled 5/min. Records `login_events`. Rejects blocked/suspended`,
| POST | `/auth/admin-login` | – | SAFE FOR AUTOMATION | Staff login; scope-dependent. Returns session for employees only |
| GET | `/auth/me` | Auth | REQUIRES AUTHENTICATION | Profile `{ id, email, fullName, role, ... }` |
| PATCH | `/auth/profile` | Auth | REQUIRES AUTHENTICATION | Update own profile |

### 3.2 Products — `/api/products`

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| GET | `/products` | – | SAFE FOR AUTOMATION | List + filter: `category`, `tag`, `search`, `sort`, `featured`, `trending`, `sale`, `newArrival`, `limit`, `offset` |
| GET | `/products/handle/:handle` | – | SAFE FOR AUTOMATION | By URL handle |
| GET | `/products/intro` | – | SAFE FOR AUTOMATION | `intro_collection` editorial picks |
| GET | `/products/category/:slug` | – | SAFE FOR AUTOMATION | By category slug |
| GET | `/products/:id` | – | SAFE FOR AUTOMATION | Full detail incl. variants/images |
| POST | `/products` | Admin | ADMIN ONLY | Create product |
| PATCH | `/products/:id` | Admin | ADMIN ONLY | Update product (also used by n8n-style bulk updates, but must respect `whitelist`) |
| DELETE | `/products/:id` | Admin | ADMIN ONLY | Delete product |

### 3.3 Categories — `/api/categories`

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| GET | `/categories` | – | SAFE FOR AUTOMATION | All categories |
| GET | `/categories/:slug` | – | SAFE FOR AUTOMATION | One category |
| POST | `/categories` | Admin | ADMIN ONLY | Create |
| PATCH | `/categories/:id` | Admin | ADMIN ONLY | Update |
| DELETE | `/categories/:id` | Admin | ADMIN ONLY | Delete |

### 3.4 Cart — `/api/cart`

> **WARNING:** the cart controller has **no AuthGuard at all**. Any route accepts an arbitrary cart UUID in
> the path. Treat cart IDs as unauthenticated, and note that for anonymous carts the frontend passes a
> `sessionId`. **Do not trust cart IDs as proof of identity in automation.**

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| GET | `/cart/:id` | – | DO NOT CALL DIRECTLY | Returns raw cart |
| POST | `/cart` | – | SAFE FOR AUTOMATION | `{ userId?, sessionId? }` → creates/get-or-returns cart |
| POST | `/cart/:id/items` | – | PRESENCE | `{ variantId, quantity }` |
| PATCH | `/cart/items/:itemId` | – | PRESENCE | `{ quantity }` |
| DELETE | `/cart/items/:itemId` | – | PRESENCE | Remove one line |
| DELETE | `/cart/:id` | – | PRESENCE | Clear cart |
| POST | `/cart/merge` | – | PRESENCE | `{ sessionId, userId }` merge anonymous into account |

### 3.5 Wishlist — `/api/wishlist` (all Auth)

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| GET | `/wishlist` | Auth | REQUIRES AUTHENTICATION | User's wishlist |
| POST | `/wishlist/items` | Auth | REQUIRES AUTHENTICATION | `{ productId, variantId? }` |
| DELETE | `/wishlist/items/:productId` | Auth | REQUIRES AUTHENTICATION | Remove |
| DELETE | `/wishlist` | Auth | REQUIRES AUTHENTICATION | Clear all |

### 3.6 Orders & Paystack — `/api/orders` (most important)

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| POST | `/orders` | Auth | DO NOT CALL DIRECTLY | Heavy side effects: validates cart/stock, applies coupon/referral/credit, inserts order + `order_events`, fires `notifyStaff`. Returned object is the created order |
| POST | `/orders/paystack/initialize` | Auth | DO NOT CALL DIRECTLY | `{ orderId, email }`. Calls Paystack `transaction/initialize`, inserts `payments` row (PENDING), returns `{ authorizationUrl, reference, paymentId, orderId }` |
| POST | `/orders/paystack/checkout` | Auth | DO NOT CALL DIRECTLY | `createOrder` + `initialize` in one call. Convenience for storefront |
| POST | `/orders/checkout/quote` | Auth | SAFE FOR AUTOMATION | Dry-run pricing: `subtotal/ discount/ shipping / total`, coupon/referral/credit validation, no DB writes |
| POST | `/orders/paystack/verify` | Auth | DO NOT CALL DIRECTLY | `{ reference }`. Polls Paystack `transaction/verify`, then `confirm_paystack_payment` RPC on success. Used by storefront callback |
| **POST** | **`/orders/paystack/webhook`** | — | **INTERNAL ONLY** | **Paystack webhook receiver.** No auth; verifies HMAC-SHA-512 signature `x-paystack-signature` over the raw body. In production also checks the client IP against `['52.31.139.75','52.49.173.169','52.214.14.220']`. Only `charge.success` is acted on. Returns `{ received: true }` |
| GET | `/orders/:id` | Auth | REQUIRES AUTHENTICATION | Owner only (admin/staff may view) |
| GET | `/orders/:id/events` | Auth | REQUIRES AUTHENTICATION | `order_events` timeline |
| GET | `/orders/user/:userId` | Auth | REQUIRES AUTHENTICATION | Must be self |
| GET | `/orders/session/:sessionId` | Admin | ADMIN ONLY | Orders for an anonymous session |
| GET | `/orders` | Admin | ADMIN ONLY | List all; filters `status`, `paymentStatus`, `state`, `search` (derived from frontend usage) |
| PATCH | `/orders/:id/status` | Admin | ADMIN ONLY · **DO NOT CALL DIRECTLY** | Transition order status — enforced a strict transition map (see Events doc). Sets timestamps, calls inventory RPCs, writes `order_events`, `admin_logs`, customer notification, referral qualification/cancellation |
| PATCH | `/orders/:id/fulfilment` | Admin | ADMIN ONLY | `{ courierName, trackingNumber, trackingUrl, estimatedDeliveryDate }` writes tracking fields + `admin_logs` |

Order status transition map (enforced in `orders.service.ts`):

```
pending            → cancelled
paid               → processing, cancelled, return_requested
processing         → packed, cancelled
packed             → ready_for_shipment
ready_for_shipment → shipped
shipped            → in_transit, delivered
in_transit         → delivered
delivered          → return_requested
return_requested   → under_review
under_review       → return_approved, cancelled
return_approved    → item_received
item_received      → refund_completed
cancelled          → refunded
refunded / refund_completed → terminal
```

Payment confirmation (`confirm_paystack_payment` RPC) additionally: checks amount/currency, verifies stock,
decrements variant stock, marks `payment_status='SUCCESS'`, sets `payment_ref`/`paystack_ref`/`payment_date`,
moves order to `paid`, clears cart items, increments coupon usage, writes an `order_events` row and an
`admin_logs` row. If stock is insufficient it sets `payment_status='VERIFICATION_FAILED'` and returns an
`insufficient_inventory` review state rather than failing the webhook.

### 3.7 Coupons — `/api/coupons` + `/api/admin/coupons`

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| GET | `/coupons/validate?code=&total=` | – | SAFE FOR AUTOMATION | Validates code against `total`. **Public**, reveals coupon validity |
| GET | `/admin/coupons` | Admin | ADMIN ONLY | List all coupons |
| GET | `/admin/coupons/usage` | Admin | ADMIN ONLY | Per-coupon usage aggregates from `coupon_usages` + paid orders |
| POST | `/admin/coupons` | Admin | ADMIN ONLY | Create (code uppercased) |
| PATCH | `/admin/coupons/:id` | Admin | ADMIN ONLY | Update |
| DELETE | `/admin/coupons/:id` | Admin | ADMIN ONLY | Delete |

### 3.8 Shipping — `/api/shipping`

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| GET | `/shipping/config` | – | SAFE FOR AUTOMATION | `{ settings, rates }` (5 min in-memory cache) |
| POST | `/shipping/quote` | – | SAFE FOR AUTOMATION | `{ state, subtotal }` → `{ shippingFee, isFreeShipping, estimatedDelivery, state }` |
| GET | `/shipping/reverse-geocode?lat=&lon=` | – | SAFE FOR AUTOMATION | Calls **Nominatim/OSM**; returns `{ state }` (may be `null`) |
| PATCH | `/shipping/settings` | Admin | ADMIN ONLY | Update singleton settings |
| POST | `/shipping/rates` | Admin | ADMIN ONLY | Create a `shipping_rates` row (per state+city) |
| PATCH | `/shipping/rates/:id` | Admin | ADMIN ONLY | Update |
| DELETE | `/shipping/rates/:id` | Admin | ADMIN ONLY | Delete |

> Note: two shipping tables exist — legacy `state_shipping_rates` (seed, single row per state) and the active
> `shipping_rates` (per state+city, used by `/quote`). The service reads **`shipping_rates`** only.

### 3.9 Returns — `/api/returns` (+ `/api/admin/returns`)

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| GET | `/returns/eligibility?orderId=` | Auth | REQUIRES AUTHENTICATION | Returns window check (48h from `delivered_at`); returns codes `NOT_DELIVERED` / `ALREADY_REQUESTED` / `EXPIRED` |
| GET | `/returns/mine` | Auth | REQUIRES AUTHENTICATION | Customer's returns |
| GET | `/returns/order/:orderId` | Auth | REQUIRES AUTHENTICATION | One return for order |
| POST | `/returns` | Auth | REQUIRES AUTHENTICATION | Create `{ orderId, reason, customReason?, images[] }` (max 5 http(s) images). Reasons: `wrong_size wrong_product damaged_delivery defective not_matching changed_mind other` |
| POST | `/returns/upload` | Auth | REQUIRES AUTHENTICATION | `multipart` image (JPG/PNG, ≤8 MB) → stores to bucket `alveron/returns/<userId>` |
| GET | `/admin/returns/summary` | Admin | ADMIN ONLY | Analytics (status counts, return rate, avg review/resolution time, top reasons/products) |
| GET | `/admin/returns` | Admin | ADMIN ONLY | List; filters `search, status, from, to` |
| GET | `/admin/returns/:id` | Admin | ADMIN ONLY | Detail incl. order + profile |
| PATCH | `/admin/returns/:id/status` | Admin | ADMIN ONLY / **DO NOT CALL DIRECTLY** | Transition (see Events doc) + customer notification + email |
| POST | `/admin/returns/:id/more-info` | Admin | ADMIN ONLY | Requests more info; moves status → `under_review` |

Return status machine (`returns.service.ts`): `pending → under_review|approved|rejected`; `under_review → approved|rejected`; `approved → item_received|refund_completed`; `item_received → refund_completed`; `refund_completed → terminal`. Transitions `approved`/`refund_completed` require `refundAmount` and (for refund_completed) `refundMethod` (`original_payment_method|store_credit|bank_transfer|crypto`) + `refundReference`.

### 3.10 Support (tickets + legacy returns) — `/api/support`

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| POST | `/support/tickets` | – | SAFE FOR AUTOMATION | Create ticket `{ email, name?, subject, category, message, userId? }`. **No auth guard.** Writes `support_tickets` |
| GET | `/support/tickets` | – | **NOT CURRENTLY SUITABLE FOR AUTOMATION** | `?userId=` or `?email=` — **bypasses ownership checks** (anyone can query another user's tickets by guessing their ID/email) |
| GET | `/support/tickets/:id` | – | **NOT CURRENTLY SUITABLE FOR AUTOMATION** | Same unauthenticated disclosure risk |
| POST | `/support/tickets/:id/reply` | – | **NOT CURRENTLY SUITABLE FOR AUTOMATION** | Adds `ticket_replies` row unauthenticated |
| PATCH | `/support/tickets/:id/status` | Admin | ADMIN ONLY | Update ticket status |
| GET | `/support/admin/tickets` | Admin | ADMIN ONLY | All tickets |
| POST | `/support/returns` | – | SAFE FOR AUTOMATION | **Legacy** return request into `return_requests` (separate from module-3.9 `returns`) |
| GET | `/support/returns` | – | **NOT CURRENTLY SUITABLE FOR AUTOMATION** | Legacy list, owner-unsafe query like tickets |
| GET | `/support/admin/returns` | Admin | ADMIN ONLY | All legacy return requests |
| PATCH | `/support/returns/:id/status` | Admin | ADMIN ONLY | Legacy return status update |

> **Two separate return systems coexist.** The support module writes `return_requests` (statuses `requested|approved|rejected|completed`); the returns module writes `returns` (statuses `pending|under_review|approved|rejected|item_received|refund_completed`) with full lifecycle/notifications/emails. The returns module is the current customer-facing flow and is the one suitable for automation.

### 3.11 Referrals — `/api/referrals`, Credits — `/api/credits`

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| POST | `/referrals/validate` | – | SAFE FOR AUTOMATION | `{ code }` → `{ valid, referrerUserId, code }` |
| GET | `/referrals/settings` | – | SAFE FOR AUTOMATION | Public program settings |
| GET | `/referrals/me` | Auth | REQUIRES AUTHENTICATION | Get/create own code → `{ code, link }` (`/r/<code>`) |
| GET | `/referrals/me/stats` | Auth | REQUIRES AUTHENTICATION | Referrer stats; **also runs `processPendingReferrals()`** (see Events doc — this is one of only two places referral qualification runs) |
| GET | `/referrals/admin/all` | Admin | ADMIN ONLY | All referrals |
| GET | `/referrals/admin/stats` | Admin | ADMIN ONLY | Aggregates + runs `processPendingReferrals()` |
| PATCH | `/referrals/admin/settings` | Admin | ADMIN ONLY | Update program settings (validated) |
| GET | `/credits/me/balance` | Auth | REQUIRES AUTHENTICATION | `{ available, pending, expiringSoon }` |
| GET | `/credits/me/transactions` | Auth | REQUIRES AUTHENTICATION | Ledger (labels expired in response) |
| POST | `/credits/me/validate` | Auth | REQUIRES AUTHENTICATION | `{ subtotal }` → eligibility + `maxRedeemable` |

> `CreditService.getAdminCreditStats()` exists but is **not exposed by any controller** — the "admin credits"
> endpoint referenced conceptually does not exist in source. Mark this `NOT CURRENTLY SUITABLE FOR AUTOMATION`.

### 3.12 Reviews — `/api/reviews` + `/api/admin/reviews`

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| GET | `/reviews/product/:productId` | – | SAFE FOR AUTOMATION | Approved reviews + user profile, paginated |
| GET | `/reviews/photo-gallery/:productId` | – | SAFE FOR AUTOMATION | Approved photo reviews |
| GET | `/reviews/summary/:productId` | – | SAFE FOR AUTOMATION | `{ average, count, breakdown }` |
| GET | `/reviews/eligibility/:productId` | Auth | REQUIRES AUTHENTICATION | Verified-purchase check |
| POST | `/reviews/photo` | Auth | REQUIRES AUTHENTICATION | JPG/PNG/WEBP/GIF ≤5MB → uploads to bucket `alveron/reviews` |
| POST | `/reviews` | Auth | REQUIRES AUTHENTICATION | `{ productId, orderId?, rating(1-5), title?, comment? }` → new review `pending`, fires staff notification, marks `review_requests` submitted |
| DELETE | `/reviews/:id` | Auth | REQUIRES AUTHENTICATION | Delete own review; recomputes product rating |
| GET | `/admin/reviews` | Admin·perm `reviews:view` | ADMIN ONLY · PERM | Paginated moderation queue |
| GET | `/admin/reviews/stats` | Admin·perm `reviews:view` | ADMIN ONLY · PERM | Moderator stats |
| PATCH | `/admin/reviews/:id/status` | Admin·perm `reviews:approve` | ADMIN ONLY · PERM | `approved/rejected/hidden/pending`; notifies reviewer on approve/reject |
| PATCH | `/admin/reviews/:id/featured` | Admin·perm `reviews:update` | ADMIN ONLY · PERM | Toggle featured |
| DELETE | `/admin/reviews/:id` | Admin·perm `reviews:delete` | ADMIN ONLY · PERM | Delete + rating refresh |

### 3.13 Admin dashboard — `/api/admin`

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| GET | `/admin/stats` | Admin | ADMIN ONLY | Store KPIs |
| GET | `/admin/analytics?period=` | Admin | ADMIN ONLY | Time-series data |
| GET | `/admin/users` | Admin | ADMIN ONLY | All users |
| PATCH | `/admin/users/:id/role` | Admin | ADMIN ONLY | Change customer role |

### 3.14 Customers — `/api/admin/customers` (permission gated)

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| GET | `/admin/customers` | `customers:view` | ADMIN ONLY · PERM | List (search/status/sort/page) |
| GET | `/admin/customers/:id` | `customers:view` | ADMIN ONLY · PERM | Detail |
| PATCH | `/admin/customers/:id` | `customers:update` | ADMIN ONLY · PERM | Update profile + audit log |
| POST | `/admin/customers/:id/status` | `customers:update` | ADMIN ONLY · PERM | Block/suspend/activate; sends email |
| POST | `/admin/customers/:id/reset-password` | `customers:update` | ADMIN ONLY · PERM | Password reset (Resend) |
| POST | `/admin/customers/:id/resend-verification` | `customers:update` | ADMIN ONLY · PERM | Email verification re-send |
| POST | `/admin/customers/:id/grant-coupon` | `customers:update` | ADMIN ONLY · PERM | Grant admin coupon (writes `customer_coupons`) |

### 3.15 Employees — `/api/admin/employees` (permission gated)

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| GET | `/admin/employees` | `employees:view` | ADMIN ONLY · PERM | List |
| GET | `/admin/employees/departments` | `employees:view` | ADMIN ONLY · PERM | Departments facet |
| POST | `/admin/employees` | `employees:create` | ADMIN ONLY · PERM | Invite employee (Resend email w/ `FRONTEND_URL`) |
| GET | `/admin/employees/:id` | `employees:view` | ADMIN ONLY · PERM | Detail incl. activity |
| PATCH | `/admin/employees/:id` | `employees:update` | ADMIN ONLY · PERM | Update profile/role |
| PATCH | `/admin/employees/:id/status` | `employees:update` | ADMIN ONLY · PERM | Activate/deactivate/ suspend |
| POST | `/admin/employees/:id/reset-password` | `employees:update` | ADMIN ONLY · PERM | Reset + email |
| POST | `/admin/employees/:id/resend-invitation` | `employees:update` | ADMIN ONLY · PERM | Re-send invite |
| GET | `/admin/employees/:id/activity` | `employees:view` | ADMIN ONLY · PERM | Derived from detail |
| DELETE | `/admin/employees/:id` | `employees:delete` | ADMIN ONLY · PERM | Remove |

### 3.16 Notifications — `/api/admin/notifications` (EmployeeGuard)

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| GET | `/admin/notifications` | Employee | INTERNAL ONLY | In-app notifications for staff (30 latest) |
| GET | `/admin/notifications/unread-count` | Employee | INTERNAL ONLY | Count |
| PATCH | `/admin/notifications/read-all` | Employee | INTERNAL ONLY | Mark all read |
| PATCH | `/admin/notifications/:id/read` | Employee | INTERNAL ONLY | Mark one read |

### 3.17 RBAC — `/api/admin/*` (permission gated)

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| GET | `/admin/me` | Auth | ADMIN ONLY · PERM | Session for current user (roles + permissions, super-admin check) |
| GET | `/admin/permissions` | `roles:view` | ADMIN ONLY · PERM | Permission catalog |
| GET | `/admin/roles` | `roles:view` | ADMIN ONLY · PERM | Roles + employee counts |
| POST | `/admin/roles` | `roles:create` | ADMIN ONLY · PERM | Create custom role (slug auto-generated), grants permissions, audits |
| PATCH | `/admin/roles/:id` | `roles:update` | ADMIN ONLY · PERM | Edit; **rejects super-admin and system roles** |
| DELETE | `/admin/roles/:id` | `roles:delete` | ADMIN ONLY · PERM | Delete; rejects system roles |

### 3.18 Audit — `/api/admin/audit-logs` (permission gated)

| Method | Path | Auth | Category | Notes |
|---|---|---|---|---|
| GET | `/admin/audit-logs` | `system_logs:view` | ADMIN ONLY · PERM | Paginated log w/ actor profile embed |
| GET | `/admin/audit-logs/facets` | `system_logs:view` | ADMIN ONLY · PERM | Distinct action + resource facets |

### 3.19 Content / settting endpoints

| Module | Public | Admin |
|---|---|---|
| Announcements | `GET /announcements/active` | `GET /announcements`, `POST`, `PATCH /:id`, `DELETE /:id` (Roles admin) |
| Banners | `GET /banners` | `GET /banners/all`, `POST`, `PATCH /:id`, `DELETE /:id` (Roles admin) |
| Newsletter | `POST /newsletter/subscribe`, `POST /newsletter/unsubscribe` | `GET /newsletter/subscribers` (Roles admin) |
| Pickup locations | `GET /pickup-locations` | — (no write API for pickup locations found) |
| Showroom | `GET /showroom?category=`, `GET /showroom/featured`, `GET /showroom/:slug` | `GET /showroom/admin/all`, `POST`, `PATCH /:id`, `POST /showroom/reorder`, `DELETE /:id` (Roles admin) |
| Settings | `GET /settings/store` | `GET /settings/admin/all`, `PATCH /settings/admin/:key` (Roles admin) |
| Upload | — | `POST /upload` (multipart), `DELETE /upload/:path` (Roles admin) — bucket `SUPABASE_STORAGE_BUCKET \|\| 'alveron'` |

---

## 4. Recommended automation touchpoints (quick map)

| Workflow intent | Best endpoint(s) | Category |
|---|---|---|
| Read product catalog / inventory | `GET /products` (+filters) | SAFE FOR AUTOMATION |
| Detect a newly paid order | `POST /orders/paystack/webhook` (hosted, verified) **or** poll `GET /orders` → `paymentStatus=SUCCESS` | INTERNAL / ADMIN |
| Advance order status / add tracking | `PATCH /orders/:id/status`, `PATCH /orders/:id/fulfilment` | ADMIN ONLY |
| Price quote for a customer | `POST /orders/checkout/quote` | SAFE FOR AUTOMATION |
| Reply/converse on returns | `GET /admin/returns`, `PATCH /admin/returns/:id/status`, `POST /admin/returns/:id/more-info` | ADMIN ONLY |
| Approve/reject reviews | `PATCH /admin/reviews/:id/status` | ADMIN ONLY·PERM |
| Send coupons | `POST /admin/coupons` + `POST /admin/customers/:id/grant-coupon` | ADMIN / ADMIN·PERM |
| Referral program ops | `GET /referrals/admin/stats`, `PATCH /referrals/admin/settings` | ADMIN ONLY |

### Anti-patterns / things automation should avoid

- **Do not** call `/support/tickets:*` or `/support/returns` (read) unauthenticated paths as a staff conduit — they are owner-unsafe in source.
- **Do not** call cart endpoints expecting identity semantics — no auth; cart IDs are opaque.
- **Do not** call `POST /orders` / initialize / verify for ad-hoc "test" payments — they create real orders and staff notifications; use `checkout/quote` for dry runs.
- **Do not** rely on `payment_status` casing. Values seen in source: `PENDING`, `pending`, `SUCCESS`, `paid`, `VERIFICATION_FAILED`. Filter on both `SUCCESS` and `paid`, or on `payments.status = 'SUCCESS'`.

---

## 5. Confidence notes

- Endpoints in this document are derived **only** from `apps/api/src/modules/**/*.controller.ts`. The 5-stage summary
  above matches the frontend API client calls (`apps/web/src/lib/api/*`, `apiFetch` with `authenticated` flag).
- Anything not present in controllers **does not exist** in the API, even if DB tables/comments reference it
  (e.g. pickup-location write API, admin credits endpoint, order `emails` via `src/lib/email-templates`).
- Unknowns to confirm in production: real public hostname, whether an nginx proxy strips `rawBody` (required by the
  webhook), and whether `NODE_ENV=production` (IP allow-listing is conditional on it).