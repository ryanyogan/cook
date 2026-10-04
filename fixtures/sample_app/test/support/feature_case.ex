defmodule SampleAppWeb.FeatureCase do
  @moduledoc """
  Case template for browser tests driven through Playwright.

  Each test gets its own browser context and its own sandboxed database
  transaction, so features can run with `async: true`.

  The app under test is shared with every other test running at the same
  time. Tests therefore create their own uniquely named data and never assert
  on anything global.
  """

  use ExUnit.CaseTemplate

  using opts do
    quote do
      use PhoenixTest.Playwright.Case, unquote(opts)
      use SampleAppWeb, :verified_routes

      import SampleApp.AccountsFixtures
      import SampleApp.CatalogFixtures
      import SampleApp.ChatFixtures
      import SampleApp.OrdersFixtures
      import SampleAppWeb.FeatureCase

      # Optional: lets the Cook runner attach failure detail (DOM, console, logs).
      # Here, after Playwright's setup, so the context has `:conn`.
      setup context do
        if Code.ensure_loaded?(Cook.Agent), do: Cook.Agent.track(context)
        :ok
      end
    end
  end

  @doc """
  Creates a user with a password and signs them in through the login form.

      setup :register_and_log_in_user
  """
  def register_and_log_in_user(%{conn: conn}) do
    user = SampleApp.AccountsFixtures.user_fixture() |> SampleApp.AccountsFixtures.set_password()
    %{conn: log_in(conn, user), user: user, scope: SampleApp.Accounts.Scope.for_user(user)}
  end

  @doc """
  Signs `user` in with their password. The user must have one set.
  """
  def log_in(conn, user, password \\ SampleApp.AccountsFixtures.valid_user_password()) do
    conn
    |> visit_live("/users/log-in")
    |> submit_password_login(user.email, password)
    |> PhoenixTest.assert_has("#flash-info", text: "Welcome back!")
  end

  @doc """
  Fills in and submits the password form on the login page.
  """
  def submit_password_login(conn, email, password) do
    PhoenixTest.within(conn, "#login_form_password", fn conn ->
      conn
      |> PhoenixTest.fill_in("Email", with: email)
      |> PhoenixTest.fill_in("Password", with: password)
      |> PhoenixTest.click_button("Log in and stay logged in")
    end)
  end

  @doc """
  Visits a LiveView page and waits until its socket is connected.

  The page is usable only from then on: text typed into the server-rendered
  HTML before the join is thrown away, and `phx-click` does nothing yet.
  """
  def visit_live(conn, path) do
    conn
    |> PhoenixTest.visit(path)
    |> wait_for_live()
  end

  @doc """
  Waits until the LiveView on the current page is connected and settled.

  Use after a link or redirect that loads a LiveView with a full page load.

  Connected is not quite enough: `phx-mounted={JS.focus()}` (the login page has
  one) moves the focus two animation frames after the join. Typing that starts
  in between lands in the wrong field, so those two frames are awaited too.
  """
  def wait_for_live(conn) do
    conn
    |> PhoenixTest.assert_has("[data-phx-main].phx-connected")
    |> PhoenixTest.Playwright.evaluate(
      "new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))"
    )
  end

  @doc """
  Opens a second, independent browser session (own cookies, own page) inside
  the current test. It shares the test's database transaction.

      test "two viewers", %{conn: conn} = context do
        other = new_browser_session(context)
  """
  def new_browser_session(context) do
    config =
      context
      |> Map.take(PhoenixTest.Playwright.Config.setup_keys())
      |> PhoenixTest.Playwright.Config.validate!()

    PhoenixTest.Playwright.Case.new_session(config, context)
  end

  @doc """
  A short suffix that makes names, slugs and search terms unique to one test.
  """
  def unique_tag, do: "#{System.unique_integer([:positive])}"
end
