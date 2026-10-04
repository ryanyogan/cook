defmodule Cook.Pool.Supervisor do
  @moduledoc """
  Supervises the warm pool.

  `rest_for_one`: the instances hold a websocket to the browser server, so when
  the browser server restarts, every instance restarts after it. Instances are
  independent of each other (`one_for_one` below them).
  """

  use Supervisor

  alias Cook.Pool.AppInstance
  alias Cook.Pool.BrowserServer

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(opts) do
    config = Keyword.merge(Cook.Pool.config(), opts)
    browser = Keyword.fetch!(config, :browser_server)

    case Cook.Pool.Distribution.ensure_started() do
      :ok -> :ok
      {:error, reason} -> raise "Cook could not start Erlang distribution: #{inspect(reason)}"
    end

    children = [
      {Registry, keys: :unique, name: Cook.Pool.Registry},
      {BrowserServer, browser},
      %{
        id: Cook.Pool.Instances,
        type: :supervisor,
        start:
          {Supervisor, :start_link,
           [
             instance_specs(config, BrowserServer.ws_endpoint(browser)),
             [strategy: :one_for_one, name: Cook.Pool.Instances]
           ]}
      }
    ]

    Supervisor.init(children, strategy: :rest_for_one, max_restarts: 5, max_seconds: 60)
  end

  @doc """
  Child specs for the configured apps.
  """
  def instance_specs(config, ws_endpoint) do
    for app <- Keyword.get(config, :apps, []) do
      app
      |> Keyword.update!(:path, &Path.expand/1)
      |> Keyword.put(:ws_endpoint, ws_endpoint)
      |> AppInstance.child_spec()
    end
  end
end
