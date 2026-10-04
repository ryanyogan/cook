# sample-app (fixture Phoenix app under `fixtures/sample_app`)

## 2026-10-04

### Status
COMPLETE

### Done
All paths relative to `fixtures/sample_app`.

App (beyond the pre-existing Accounts/auth):
- Migrations: `priv/repo/migrations/20261004153821_create_products.exs`, `..153823_create_orders.exs`,
  `..153824_create_chat.exs` (rooms + messages, also inserts the committed `lobby` room),
  `..153826_create_support_tickets.exs`.
- Contexts: `lib/sample_app/catalog.ex` (+ `catalog/product.ex`), `orders.ex` (+ `orders/order.ex`,
  `orders/workers/confirm_order.ex`), `chat.ex` (+ `chat/room.ex`, `chat/message.ex`), `support.ex`
  (+ `support/ticket.ex`), `reports.ex`, `money.ex`.
- LiveViews in `lib/sample_app_web/live/`: `product_live/{index,show,form,import}.ex`,
  `order_live/index.ex`, `room_live/{index,show}.ex`, `report_live.ex`.
- Controller (plain, not LiveView): `controllers/support_controller.ex`, `support_html.ex`,
  `support_html/{new,show}.html.heex`.
- Home page rewritten: `controllers/page_html/home.html.heex`. Nav in `components/layouts.ex` (`#main-nav`).
- Router: routes added inside the two existing `live_session`s; see Gotchas for the sandbox hook.
- Flash toast moved from top-right to bottom-right (`core_components.ex` line 66), it covered the "Log out" link.

Tests: 44 browser tests in 14 files under `test/features/` (all `async: true`):
chat 4, chat_broadcast 3, catalog_browse 4, delivery_estimate 2, home 3, login 5, order_history 3,
ordering 4, product_import 2, product_management 4, registration 3, reports 2, settings 2, support 3.
- Helpers in `test/support/feature_case.ex`: `visit_live/2`, `wait_for_live/1`, `new_browser_session/1`,
  `log_in/3`, `unique_tag/0`. Fixtures: `test/support/fixtures/{catalog,orders,chat}_fixtures.ex`.
- Slow (`@tag :slow`, one per module): `reports_test.exs:6` ~1.7 s, `product_import_test.exs:8` ~2.3-2.8 s,
  `order_history_test.exs:36` ~4.2 s. The sleeps are `@simulated_work_ms` in `report_live.ex` (1000),
  `product_live/import.ex` (1750), `order_live/index.ex` (3600).
- Flaky (`@tag :flaky`): `delivery_estimate_test.exs:8`. Server delay is `@estimate_delay_ms 1_000..2_250`
  in `product_live/show.ex`.
- `test/sample_app_web/controllers/page_controller_test.exs` updated for the new home page.

### Verified (final code, all run from `fixtures/sample_app`)
- `mix compile --warnings-as-errors` and `MIX_ENV=test mix compile --warnings-as-errors`: pass.
- `mix format --check-formatted`: pass.
- `mix test test/features --exclude flaky`: 5 runs in a row, each `43 passed, 1 excluded`, ~6.0-6.8 s ExUnit time.
- `mix test test/features --only flaky`: 40 runs, 30 pass / 10 fail (25%).
- `mix test test/features` (all 44, a run where the flaky one passed): 6.1 s ExUnit, 7 s wall.
- `mix test --exclude flaky`: `155 passed, 1 excluded`.
- Login stress (temporary module, removed): 300 UI logins, 300 passed after the `wait_for_live` fix.
- No `Process.sleep` in `test/features` or `test/support` (grep count 0).

### Unverified / assumptions
- Slow-test durations vary by about +/-0.4 s between runs; each was measured two or three times, not averaged.
- Flaky rate is from 40 isolated runs; at other delay ranges 20-run batches swung between 20% and 55%,
  so expect noise. It has not been measured while the whole suite runs alongside.
- Dev database was not migrated or exercised; only the test env was run.

### Not done / next steps
- Nothing outstanding from the brief. No context-level (DataCase) tests were written for the new contexts;
  they are covered only through the browser tests.

### Gotchas
- LiveView sandbox hook order. `SampleAppWeb.LiveAcceptance` was only attached per LiveView module, which runs
  AFTER the `live_session` auth hooks. Those hooks query the user on mount, so every LiveView opened by a
  logged-in user crashed with `DBConnection.OwnershipError`. Fixed in `router.ex` with `@sandbox_on_mount`
  prepended to both `live_session` `on_mount` lists (compile-time, only when `:sql_sandbox` is set).
  `live_acceptance.ex` itself is untouched.
- `.phx-connected` is not enough before typing. `phx-mounted={JS.focus()}` on the login page refocuses two
  animation frames after the join; typing in that window went into the wrong field and about 5-8% of UI logins
  failed. `wait_for_live/1` now also awaits two animation frames. Use `visit_live/2` for every LiveView page.
- PhoenixTest.Playwright matching: labels are exact, link/button text is substring. Keep link and button
  texts from being substrings of each other on one page, or the click raises a strict-mode error.
- Playwright's assertion polling backs off, so an element must appear roughly 0.1-0.3 s before the timeout to
  be seen. The flaky test's effective cut-off is about 1.9 s, not 2.0 s.
- Cross-`live_session` links use `href` / `redirect`, not `navigate` / `push_navigate` (avoids a console warning
  and a fallback reload).
- The support form returns 422 on validation errors; the browser logs
  `Failed to load resource ... 422` at error level during `support_test.exs`. Expected noise.
- Database headroom: test pool is 48 connections (`schedulers * 2`), Postgres `max_connections` is 100, and
  `cook_dev` held 10. During one run with other activity the server logged
  `FATAL 53300 too_many_connections`. Two app instances at once will not fit.
- Never post to the `lobby` room in a test: it is committed data shared by every test, and its PubSub topic too.

### Interfaces
- Commands: `mix test test/features`, `--exclude flaky`, `--only flaky`, `--only slow`.
  Run `MIX_ENV=test mix assets.build` after template/CSS/JS changes.
- Tags: `:slow` (3 tests), `:flaky` (1 test).
- Routes: `/`, `/products`, `/products/:id`, `/products/new|import|:id/edit` (auth), `/orders` (auth),
  `/reports` (auth), `/rooms`, `/rooms/:slug`, `/support/new`, `POST /support`, `/support/tickets/:reference`.
- PubSub topic per room: `"room:#{slug}"`, message `{:new_message, %Message{user: %User{}}}`.
- Oban worker: `SampleApp.Orders.Workers.ConfirmOrder`, args `%{"order_id" => id}`.
