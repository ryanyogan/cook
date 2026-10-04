ExUnit.start()
Ecto.Adapters.SQL.Sandbox.mode(SampleApp.Repo, :manual)

{:ok, _} = PhoenixTest.Playwright.Supervisor.start_link()
Application.put_env(:phoenix_test, :base_url, SampleAppWeb.Endpoint.url())
