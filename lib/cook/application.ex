defmodule Cook.Application do
  # See https://elixir.hexdocs.pm/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children =
      [
        CookWeb.Telemetry,
        Cook.Repo,
        {DNSCluster, query: Application.get_env(:cook, :dns_cluster_query) || :ignore},
        {Phoenix.PubSub, name: Cook.PubSub}
      ] ++
        pool_children() ++
        [
          {Task.Supervisor, name: Cook.Runs.TaskSupervisor},
          Cook.Runs.Coordinator,
          # Start to serve requests, typically the last entry
          CookWeb.Endpoint
        ]

    # See https://elixir.hexdocs.pm/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: Cook.Supervisor]

    with {:ok, pid} <- Supervisor.start_link(children, opts) do
      write_pidfile(System.get_env("COOK_PIDFILE"))
      {:ok, pid}
    end
  end

  # `bin/cook start --detach` passes COOK_PIDFILE so `bin/cook stop` knows the
  # OS pid of this VM whatever wrapper scripts started it.
  defp write_pidfile(file) when file in [nil, ""], do: :ok
  defp write_pidfile(file), do: File.write(file, System.pid() <> "\n")

  # The warm pool launches a browser server and boots target apps, so it only
  # starts where it is enabled (never in Cook's own test environment).
  defp pool_children do
    if Cook.Pool.enabled?(), do: [Cook.Pool.Supervisor], else: []
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    CookWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
