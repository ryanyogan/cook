defmodule Cook.Pool.BrowserServer do
  @moduledoc """
  Owns the Playwright `run-server` process that every app instance attaches to.

  `init/1` returns once the server accepts TCP connections, so children started
  after it can rely on it. If the Node process exits, this GenServer stops with
  an error and the pool supervisor restarts it together with the instances
  (their websocket died with the server).
  """

  use GenServer

  require Logger

  alias Cook.Pool.OsProcess

  @ready_timeout_ms 15_000
  @poll_ms 50

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  The websocket endpoint instances connect to, e.g. `"ws://127.0.0.1:4041"`.
  """
  def ws_endpoint(opts) do
    "ws://#{Keyword.get(opts, :host, "127.0.0.1")}:#{Keyword.fetch!(opts, :port)}"
  end

  @doc """
  Arguments passed to `node` to start the server.
  """
  def args(opts) do
    [
      cli_path(opts),
      "run-server",
      "--port",
      Integer.to_string(Keyword.fetch!(opts, :port)),
      "--host",
      Keyword.get(opts, :host, "127.0.0.1")
    ]
  end

  @doc """
  Path of the Playwright CLI installed for Cook.
  """
  def cli_path(opts) do
    Keyword.get_lazy(opts, :cli, fn ->
      Application.app_dir(:cook, "priv/playwright/node_modules/playwright/cli.js")
    end)
  end

  @doc """
  Returns `%{status: :ready, port: port, os_pid: os_pid, pid: pid, accepting: boolean}`.

  `pid` is this GenServer (a new one after every restart). `accepting` is a
  fresh TCP probe of the server's port: it turns false the moment the Node
  process is gone, before its exit has been reported to this process.
  """
  def status(server \\ __MODULE__), do: GenServer.call(server, :status)

  @impl true
  def init(opts) do
    Process.flag(:trap_exit, true)
    host = Keyword.get(opts, :host, "127.0.0.1")
    tcp_port = Keyword.fetch!(opts, :port)

    with {:ok, node} <- find_node(opts),
         :ok <- check_installed(opts),
         :ok <- check_port_free(host, tcp_port) do
      port = OsProcess.open(node, args(opts))
      deadline = System.monotonic_time(:millisecond) + @ready_timeout_ms

      case await_ready(port, host, tcp_port, deadline, []) do
        {:ok, log} ->
          Logger.info("Cook browser server ready on #{ws_endpoint(opts)}")
          {:ok, %{port: port, tcp_port: tcp_port, host: host, log: log}}

        {:error, reason} ->
          {:stop, reason}
      end
    else
      {:error, reason} -> {:stop, reason}
    end
  end

  @impl true
  def handle_call(:status, _from, state) do
    os_pid =
      case Port.info(state.port, :os_pid) do
        {:os_pid, pid} -> pid
        nil -> nil
      end

    reply = %{
      status: :ready,
      port: state.tcp_port,
      os_pid: os_pid,
      pid: self(),
      accepting: accepting?(state.host, state.tcp_port)
    }

    {:reply, reply, state}
  end

  @impl true
  def handle_info({port, {:data, {_eol, line}}}, %{port: port} = state) do
    {:noreply, %{state | log: OsProcess.remember(state.log, line)}}
  end

  def handle_info({port, {:exit_status, status}}, %{port: port} = state) do
    Logger.error("Cook browser server exited with status #{status}")
    {:stop, {:browser_server_exited, status}, state}
  end

  def handle_info(_message, state), do: {:noreply, state}

  defp find_node(opts) do
    case Keyword.get(opts, :node) || System.find_executable("node") do
      nil -> {:error, :node_not_found}
      node -> {:ok, node}
    end
  end

  defp check_installed(opts) do
    if File.exists?(cli_path(opts)) do
      :ok
    else
      {:error, {:playwright_not_installed, "run `npm install` in priv/playwright"}}
    end
  end

  defp check_port_free(host, tcp_port) do
    if accepting?(host, tcp_port), do: {:error, {:port_in_use, tcp_port}}, else: :ok
  end

  defp await_ready(port, host, tcp_port, deadline, log) do
    cond do
      accepting?(host, tcp_port) ->
        {:ok, log}

      System.monotonic_time(:millisecond) > deadline ->
        {:error, {:browser_server_not_ready, log}}

      true ->
        receive do
          {^port, {:exit_status, status}} ->
            {:error, {:browser_server_exited, status, log}}

          {^port, {:data, {_eol, line}}} ->
            await_ready(port, host, tcp_port, deadline, OsProcess.remember(log, line))
        after
          @poll_ms -> await_ready(port, host, tcp_port, deadline, log)
        end
    end
  end

  defp accepting?(host, tcp_port) do
    case :gen_tcp.connect(String.to_charlist(host), tcp_port, [:binary, active: false], 200) do
      {:ok, socket} ->
        :gen_tcp.close(socket)
        true

      {:error, _reason} ->
        false
    end
  end
end
