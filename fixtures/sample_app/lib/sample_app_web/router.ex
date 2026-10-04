defmodule SampleAppWeb.Router do
  use SampleAppWeb, :router

  import SampleAppWeb.UserAuth

  # In browser tests a LiveView has to join its test's database sandbox before
  # any other hook runs: the auth hooks below look the user up on mount, and
  # `live_session` hooks run ahead of the ones a LiveView declares itself.
  @sandbox_on_mount if Application.compile_env(:sample_app, :sql_sandbox),
                      do: [SampleAppWeb.LiveAcceptance],
                      else: []

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {SampleAppWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
    plug :fetch_current_scope_for_user
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", SampleAppWeb do
    pipe_through :browser

    get "/", PageController, :home

    get "/support/new", SupportController, :new
    post "/support", SupportController, :create
    get "/support/tickets/:reference", SupportController, :show
  end

  # Other scopes may use custom stacks.
  # scope "/api", SampleAppWeb do
  #   pipe_through :api
  # end

  # Enable LiveDashboard in development
  if Application.compile_env(:sample_app, :dev_routes) do
    # If you want to use the LiveDashboard in production, you should put
    # it behind authentication and allow only admins to access it.
    # If your application does not have an admins-only section yet,
    # you can use Plug.BasicAuth to set up some basic authentication
    # as long as you are also using SSL (which you should anyway).
    import Phoenix.LiveDashboard.Router

    scope "/dev" do
      pipe_through :browser

      live_dashboard "/dashboard", metrics: SampleAppWeb.Telemetry
    end
  end

  ## Authentication routes

  scope "/", SampleAppWeb do
    pipe_through [:browser, :require_authenticated_user]

    live_session :require_authenticated_user,
      on_mount: @sandbox_on_mount ++ [{SampleAppWeb.UserAuth, :require_authenticated}] do
      live "/users/settings", UserLive.Settings, :edit
      live "/users/settings/confirm-email/:token", UserLive.Settings, :confirm_email

      live "/products/new", ProductLive.Form, :new
      live "/products/import", ProductLive.Import, :new
      live "/products/:id/edit", ProductLive.Form, :edit
      live "/orders", OrderLive.Index, :index
      live "/reports", ReportLive, :index
    end

    post "/users/update-password", UserSessionController, :update_password
  end

  scope "/", SampleAppWeb do
    pipe_through [:browser]

    live_session :current_user,
      on_mount: @sandbox_on_mount ++ [{SampleAppWeb.UserAuth, :mount_current_scope}] do
      live "/users/register", UserLive.Registration, :new
      live "/users/log-in", UserLive.Login, :new
      live "/users/log-in/:token", UserLive.Confirmation, :new

      live "/products", ProductLive.Index, :index
      live "/products/:id", ProductLive.Show, :show
      live "/rooms", RoomLive.Index, :index
      live "/rooms/:slug", RoomLive.Show, :show
    end

    post "/users/log-in", UserSessionController, :create
    delete "/users/log-out", UserSessionController, :delete
  end
end
