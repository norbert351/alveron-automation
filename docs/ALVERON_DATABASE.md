# Alveron Fashion — Supabase / Postgres Database Reference

Read-only reference of the Alveron Fashion database as described by the migration files under
`apps/api/supabase/migrations/` (001–016) plus `apps/api/supabase-schema.sql` (baseline schema) and
confirmed against the SQL the application actually executes (services in `apps/api/src/modules/*`).
Compiled September 2026 from the Alveron Fashion repository `HEAD`.

> **Access model (critical):** the NestJS API talks to Postgres exclusively through the Supabase **service
> role** client (`common/supabase.service.ts` → `getDb()`), which **bypasses RLS**. RLS policies exist for the
> storefront's anon/Auth clients, but any integration that reads/writes through the service role **must not
> rely on RLS for security** — auth-, audit- and ownership checks are implemented in application code.

---

## 1. Schema sources & application order

Migrations apply in **lexical order** (`MIGRATIONS.md`). There is no in-repo ledger; environments track
applications externally. `012_secure_showcase_storage.sql` was renamed from a duplicate `010` — if the old file
was already applied, mark `012` applied after confirming the two showcase policies exist.

| Source | Role |
|---|---|
| `supabase/supabase-schema.sql` | Baseline schema (enums, core tables, RLS, seed policies) — "run in SQL editor" |
| `001` intro_collection | Editorial intro products |
| `002` content_management | Storage buckets `hero-slides`, `showcase-products`; `hero_slides`, `showcase_products` + RLS |
| `003` product_images_options_rls | Public-read/admin RLS on `product_images`, `product_options` |
| `004` shipping | `shipping_settings` (singleton), `state_shipping_rates` (37 states) |
| `005` product_management | `products` columns (status, merchandising, specs, meta, inventory) + `product_media` + `product_related_products` |
| `006` shipping_rates | New `shipping_rates` (per state+city), seeded from state capitals |
| `007` returns | `orders.delivered_at`, `returns`, `notifications` (+ RLS) |
| `008` restore_missing_tables | Recreates missing core tables idempotently (orders, order_items, product_media, product_related_products, shipping_settings, support_tickets, ticket_replies, return_requests, coupons, admin_logs, intro_collection), enums `order_status`, `fulfillment_method` |
| `009` order_lifecycle | Extended `order_status` values; `orders` lifecycle columns; `order_events`; `order_inventory_reservations`; inventory RPCs; `admin_logs.metadata` |
| `010` rbac | RBAC (`roles`, `permissions`, `role_permissions`, `employees`, `customer_coupons`, `employee_sessions`, `login_events`), `profiles` lifecycle columns, `notifications.data`, seed roles/permissions/grants, legacy admin→employee migration |
| `011` paystack_payments | `payments`; `orders` payment/coupon/cart columns; `confirm_paystack_payment` RPC |
| `012` checkout_snapshots | `orders.pickup_location_snapshot`, `customer_name`, `customer_phone` |
| `012` secure_showcase_storage | RLS on `storage.objects` for `showcase-products` (admin only) |
| `013` showroom | `showroom_entries`, `showroom_products` (+ public RLS) |
| `014` launch_promotions_settings | `coupons` promo fields; `coupon_usages`; `store_settings` (singleton key/value) |
| `015` reviews_four | `reviews` moderation columns + `review_requests` (+ RLS) |
| `016` referral_credits | `referral_codes`, `referrals`, `credit_transactions`, `orders` referral/credit columns, RLS, default settings |

Database seed: `src/database/seed.mjs` (`npm run db:seed`) upserts 4 categories, 10 products w/ variants+images,
1 pickup location. `MIGRATIONS.md` warns not to run the seed against production unverified.

---

## 2. Enums (Postgres types)

| Enum | Values |
|---|---|
| `user_role` | `customer`, `staff`, `admin` |
| `order_status` | `pending`, `paid`, `processing`, `shipped`, `delivered`, `cancelled`, `refunded` + (009) `packed`, `ready_for_shipment`, `in_transit`, `return_requested`, `under_review`, `return_approved`, `item_received`, `refund_completed` |
| `fulfillment_method` | `shipping`, `pickup` |

---

## 3. Table inventory

Categories used:
- **CONFIRMED** — created/altered by schema + migrations.
- **REFERENCED/EXPECTED** — referenced by service code / supabase-schema but not present in the migration set applied by an environment (likely existed before 008 and were therefore never re-created). Flagged for verification against the live DB.
- **NOT CURRENTLY IN USE** — no service code writes/reads; present in schema/migrations.

### 3.1 Catalog & products

| Table | Category | Notes |
|---|---|---|
| `categories` | CONFIRMED (005/008 context, base) | `name, slug(unique), description, image_url, item_count, sort_order` — seeded: clothing, combo, shoes, accessories |
| `products` | CONFIRMED | Base + 005 columns. Money `base_price/compare_at_price` INTEGER NGN. Merchandising: `status(draft/published/archived)`, `subcategory, collection, is_featured, is_trending, is_best_seller, season, gender`. Inventory: `cost_price, track_inventory, allow_backorders, low_stock_alert, barcode`. Specs/meta: `material, fit, sleeve, neck, closure, pattern, care_instructions, country_of_origin, weight_grams, package_dimensions, meta_title, meta_description, keywords[], canonical_url`. Storefront: `featured_image_url, avg_rating, review_count` (maintained by reviews service) |
| `product_variants` | CONFIRMED | `product_id, title, sku, price, compare_at_price, available, stock, size, color, style, image_url, sort_order` |
| `product_images` | CONFIRMED | `product_id, url, alt_text, sort_order` |
| `product_options` | CONFIRMED | `product_id, name, values[]` |
| `product_media` | CONFIRMED (005, 008) | `product_id, url, media_type(image/video/360), color, alt_text, sort_order, is_cover` |
| `product_related_products` | CONFIRMED (005, 008) | junction: `product_id, related_product_id, relation_type(also_bought/complete_look/frequently_bought)` |
| `intro_collection` | CONFIRMED (001, 008) | `product_id(unique), editorial_label, sort_order` (public read) |
| `hero_slides` | CONFIRMED (002) | Homepage slides; bucket assets |
| `showcase_products` | CONFIRMED (002) | Editorial showcase items; bucket assets |

### 3.2 Commerce runtime

| Table | Category | Notes |
|---|---|---|
| `carts` | REFERENCED/EXPECTED | `id, user_id, session_id, updated_at`; anonymous carts use `session_id`. No RLS restored in 001–016 |
| `cart_items` | REFERENCED/EXPECTED | `cart_id, variant_id, quantity, UNIQUE(cart_id, variant_id)` |
| `wishlist_items` | REFERENCED/EXPECTED | `user_id, product_id, variant_id` with coalesced unique index |
| `orders` | CONFIRMED (008, 009, 011, 012, 016) | See §4 below — large table |
| `order_items` | CONFIRMED (008) | Snapshot: `product_id, variant_id, title, variant_title, quantity, price, image_url, cart_item_id(011)` |
| `order_events` | CONFIRMED (009) | `order_id, status, note, admin_id, created_at`; owner+staff select; staff insert |
| `order_inventory_reservations` | CONFIRMED (009) | `order_id+variant_id PK, quantity, state(reserved/released/deducted)`; managed by RPCs |
| `payments` | CONFIRMED (011) | `order_id, provider('PAYSTACK'), provider_reference(unique), amount(INTEGER, kobo), currency('NGN'), status(PENDING/SUCCESS/FAILED/ABANDONED/REVERSED/VERIFICATION_FAILED), channel, gateway_response JSONB, paid_at, metadata` |

### 3.3 Customer identity

| Table | Category | Notes |
|---|---|---|
| `auth.users` | CONFIRMED (Supabase managed) | Login identity, email. `profiles.id = auth.users.id` |
| `profiles` | CONFIRMED (base + 010) | `full_name, username, avatar_url, phone, role(user_role)`, 010 adds `status(active/blocked/suspended/deleted), gender, birthday, last_login_at, email_verified, phone_verified, email` (backfilled from auth.users) |
| `addresses` | REFERENCED/EXPECTED | Base schema only; not used by any service found |
| `email_otps` | NOT CURRENTLY IN USE | Base schema; no service code found writing it |

### 3.4 Marketing & content

| Table | Category | Notes |
|---|---|---|
| `banners` | CONFIRMED (base; 008 did not touch) | Hero slides content: `eyebrow, title_line1/2, subtitle, cta_text/link, image_url, is_active, sort_order` |
| `announcements` | CONFIRMED | `text, link, is_active` |
| `newsletter_subscribers` | CONFIRMED | `email(unique), is_subscribed` |
| `coupons` | CONFIRMED (008 + 014) | `code(unique), name, discount_type(percentage/fixed), discount_value, min_order_amount, max_uses, used_count, per_user_limit, max_discount, start_date, expires_at, is_active` |
| `coupon_usages` | CONFIRMED (014) | `coupon_id, order_id(unique), user_id, discount_amount, created_at`; admin RLS |
| `store_settings` | CONFIRMED (014 + 016 seed) | Singleton key/value JSONB. Seed keys: `launch_promotion`, `whatsapp`, `referral_program`. Public read, admin write |

### 3.5 Referrals & credits

| Table | Category | Notes |
|---|---|---|
| `referral_codes` | CONFIRMED (016) | `user_id(unique), code(unique), status(active/disabled)` |
| `referrals` | CONFIRMED (016) | `referrer_user_id, referred_user_id(unique partial), referral_code, referred_order_id, status(pending/qualified/rewarded/cancelled/rejected), qualifying_order_subtotal, customer_discount_amount, referrer_reward_amount, attributed_at, qualified_at, rewarded_at, cancelled_at` |
| `credit_transactions` | CONFIRMED (016) | Ledger: `user_id, amount, type(referral_reward/redemption/expiry/reversal/admin_adjustment), status(pending/available/used/expired/reversed), referral_id, order_id, description, available_at, expires_at`; unique partial on `referral_id`, index on unexpired available |
| `customer_coupons` | CONFIRMED (010) | Admin-granted coupons: `customer_id, coupon_id, granted_by, note, granted_at, expires_at, used_at` |

### 3.6 Support & returns

| Table | Category | Notes |
|---|---|---|
| `support_tickets` | CONFIRMED (008) | `user_id, email, name, subject, category, message, status(open/pending/resolved/closed)` |
| `ticket_replies` | CONFIRMED (008) | `ticket_id, user_id, author, message` |
| `return_requests` | CONFIRMED (008, **legacy**) | Older flow used by the support module: `order_id, user_id, email, full_name, order_number, reason, description, photo_urls[], status(requested/approved/rejected/completed), admin_note` |
| `returns` | CONFIRMED (007, **current flow**) | One per order (`UNIQUE(order_id)`): `user_id, reason, custom_reason, images[], status(pending/under_review/approved/rejected/item_received/refund_completed), requested_at, approved_at, rejected_at, received_at, completed_at, admin_notes, refund_amount, refund_method, refund_reference, tracking_number, delivery_date, return_deadline` |

### 3.7 RBAC, employees & audit

| Table | Category | Notes |
|---|---|---|
| `roles` | CONFIRMED (010) | `slug(unique), label, description, is_system, is_super_admin`. Seed: `super_admin, admin, operations_manager, inventory_manager, customer_support, marketing_manager, finance, content_manager, warehouse_staff`. `super_admin` = wildcard `*`; `admin` = all catalog grants |
| `permissions` | CONFIRMED (010) | Catalog `(module, action)` unique. Modules: dashboard, products, inventory, orders, customers, coupons, shipping, returns, payments, analytics, support, reviews, settings, employees, roles, api_keys, system_logs |
| `role_permissions` | CONFIRMED (010) | `role_id, permission("module:action"|'*'), granted` PK `(role_id, permission)` |
| `employees` | CONFIRMED (010) | `user_id(unique→auth.users), first_name, last_name, email, phone, role_id→roles, department, status(active/inactive/suspended), invitation_token, invitation_expires_at, invited_at, activated_at, last_login_at` |
| `employee_sessions` | CONFIRMED (010) | `employee_id, token_hash, user_agent, ip_address, last_active_at, expires_at, revoked_at` — **no service code writes it (future-ready)** |
| `login_events` | CONFIRMED (010) | Auth audit: `user_id, employee_id, method, success, ip_address, user_agent` — written by auth service on login/admin-login |
| `admin_logs` | CONFIRMED (008 + 009 metadata + 010 FK→profiles) | `action, resource, resource_id, details, metadata JSONB, ip_address, user_id(→profiles)` |

### 3.8 Notifications & reviews

| Table | Category | Notes |
|---|---|---|
| `notifications` | CONFIRMED (007 + 010 `data`) | `user_id, type, title, body, link, read_at, data JSONB` — customer in-app notifications; staff notifications fan out one row per active employee |
| `reviews` | CONFIRMED (015; base showed pre-cursor) | `user_id, product_id, order_id, rating(1-5), title, comment, photo_url, is_verified, is_featured, status(pending/approved/rejected/hidden)`; UNIQUE `(user_id, product_id)` |
| `review_requests` | CONFIRMED (015) | `order_id, user_id, status(awaiting/submitted/declined), responded_at`, UNIQUE `(order_id, user_id)` — created on order delivered, flipped to `submitted` when the review is posted |
| `pickup_locations` | CONFIRMED | `name, address, city, state, hours, phone, is_active, is_default, sort_order` — seeded: Alveron Office, Owerri |

### 3.9 Shipping

| Table | Category | Notes |
|---|---|---|
| `shipping_settings` | CONFIRMED (004, 008) | Singleton `id=true`: `store_state('imo'→Owerri default), store_city, free_shipping_enabled, free_shipping_threshold, free_shipping_scope(same_state_only/nationwide)` |
| `state_shipping_rates` | CONFIRMED (004, **legacy**) | `state(PK), delivery_fee, estimated_days, active` — seed only |
| `shipping_rates` | CONFIRMED (006, **active**) | `state, city(unique pair), delivery_fee, estimated_delivery('3-5 Days' etc), status(active/inactive)` — **the service reads/writes this table** |

### 3.10 Storage (Supabase Storage, not Postgres)

| Bucket | Public | Write policy | Use |
|---|---|---|---|
| `alveron` | default bucket name (from `SUPABASE_STORAGE_BUCKET`) | admin upload via API; returns/review uploads write under `returns/<userId>` and `reviews` folders | General/admin images, return photos, review photos |
| `hero-slides` | yes (002) | authenticated upload, admin delete | Homepage hero slides |
| `showcase-products` | yes (002, 012) | admin-only (012 tightened the 002 policy that allowed any authenticated upload) | Showcase media |

---

## 4. `orders` columns (merged across migrations)

```
id UUID PK
user_id → auth.users (nullable = anonymous/legacy)
session_id TEXT                -- anonymous orders keyed by browser session
order_number SERIAL            -- human-readable #n
status order_status            -- default 'pending' (see enum §2)
fulfillment fulfillment_method -- 'pickup' | 'shipping' (default 'pickup')
subtotal INTEGER NGN
shipping INTEGER NGN
discount INTEGER NGN (011)
total INTEGER NGN
currency 'NGN'
delivered_at (007)
payment_status TEXT            -- default 'pending'(009) but created as 'PENDING'(011) — SEE INCONSISTENCY §5.1
payment_date, gateway_response JSONB, payment_provider, payment_reference (009/011)
payment_method, payment_ref, paystack_ref (base/011)
coupon_id → coupons SET NULL (011)
cart_id → carts SET NULL (011)
courier_name, tracking_number, tracking_url, estimated_delivery_date DATE, admin_notes (009)
cancelled_at, refunded_at (009)
pickup_location, pickup_location_snapshot JSONB, shipping_address JSONB, billing_address JSONB (012)
customer_email, customer_name, customer_phone (009/012)
referral_id → referrals, referral_code, referral_discount, alveron_credit_amount, credit_transaction_id (016)
created_at, updated_at
```

**Money note:** `orders.subtotal`/`total` are post-discount amounts the customer pays in NGN whole units.
Paystack `amount` is `total * 100` (kobo); `payments.amount` stores the kobo figure, and
`confirm_paystack_payment` enforces `p.amount = orders.total * 100 AND currency = 'NGN'`.

---

## 5. Postgres functions (RPCs)

Called with Supabase `rpc()`. All are `SECURITY DEFINER` (run as definer, bypassing RLS).

| Function | Source | Behavior |
|---|---|---|
| `confirm_paystack_payment(p_payment_id, p_gateway)` | 011 | Idempotent payment confirmation. Validates amount/currency; checks stock sufficiency; decrements stock; clears cart lines; bumps coupon `used_count`; order → `paid` + `payment_status='SUCCESS'`; writes `order_events` + `admin_logs` (`PAYMENT_SUCCESS`); on mismatch/inventory → `VERIFICATION_FAILED` + `admin_logs PAYMENT_INVENTORY_REVIEW`. Returns JSON `{confirmed, idempotent, review?}` |
| `reserve_order_inventory(p_order_id)` | 009 | Ad-hoc v1: decrements variant stock, records reservation rows (used when an admin marks an order `paid`) |
| `release_order_inventory(p_order_id)` | 009 | Restores stock for `reserved` rows (used on cancel/refund) |
| `finalize_order_inventory(p_order_id)` | 009 | Marks reservations `deducted` (used on delivery) |

> Note the **two inventory paths** that can coexist: the 011 `confirm_paystack_payment` RPC decrements stock directly
> without inserting reservation rows, while the 009 RPCs operate on `order_inventory_reservations`. A paid-via-webhook
> order that is later cancelled will have its stock restored by `release_order_inventory` only if a reservation row
> exists — those are created only by the admin `paid` transition, not by webhook payment. **Flagged as a reconciliation
> risk for automation.**

---

## 6. Known inconsistencies & things to verify against the live DB

1. **`orders.payment_status` casing:** created as `'PENDING'`, default `'pending'` (009), success = `'SUCCESS'` (RPC)
   or `'paid'` (manual admin transition). Automation must treat all of `SUCCESS`/`paid` as paid.
2. **Coupon `used_count` double counting:** `coupons.service.applyCoupon` increments `used_count` at order creation
   and writes `coupon_usages`; `confirm_paystack_payment` (011) increments `used_count` **again** at payment success
   without a `coupon_usages` row. Unpaid/cancelled orders never decrement. Expect `used_count` to drift above reality.
3. **Two return systems:** `returns` (current, full lifecycle) vs `return_requests` (legacy support-module flow).
   Data in the legacy table will not appear in `/admin/returns`.
4. **Two shipping tables:** `shipping_rates` is authoritative for quotes; `state_shipping_rates` is seed-only legacy.
5. **`order_inventory_reservations` vs direct stock decrement** — see §5 note.
6. **Notification writers vs `notifications.data`:** writers assume the 010 `data JSONB` column exists; environments
   that applied only up to 007 will fail those inserts.
7. **Unreferenced-by-code tables:** `addresses` (base schema), `email_otps` (base schema), `employee_sessions`
   (010, future-ready). Do not design automation around these without confirming live usage.
8. **RLS:** service-role client bypasses all RLS; the storefront's `anon`/`authenticated` clients are governed by the
   policies above. Admin test accounts rely on `profiles.role='admin'` in policy check subqueries — e.g. `store_settings`
   reads are public but writes are admin-only.
9. **`pickup_locations`** has no write API; seeded via seed script only.
10. **Payloads vs schema:** services frequently insert JSONB keys (`notifications.data`, `payments.metadata`,
    `orders.shipping_address`) — column types are JSONB; content shape is application-defined. `order_events.status`
    duplicates `orders.status` history and is the cleanest "event log" table in the system (see Events doc).

---

## 7. Recommended read patterns for automation

- **New paid orders:** read `payments` (`status='SUCCESS'`) joined to `orders`; or read `orders.payment_status` values
  `SUCCESS`/`paid`. Both are written server-side; the `payments` table is the canonical Paystack record.
- **Order timeline:** `order_events` (order_id, status, created_at, admin_id).
- **Pending moderation:** `reviews` where `status='pending'`; **pending returns:** `returns` where
  `status='pending'`; **staff to-dos:** `notifications` where `read_at IS NULL` and `user_id = <employee>`.
- **Referral funnel:** `referrals` status transitions `pending → qualified → rewarded`; ledger in
  `credit_transactions`.
- **Inventory:** `product_variants.stock` + `order_inventory_reservations.state`.
- Aggregations for dashboards should be computed from these tables, not from cached fields where avoidable
  (`products.avg_rating`, `coupons.used_count` are derived and drift-prone).