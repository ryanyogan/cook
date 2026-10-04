defmodule Cook.Pool.AppInstance do
  @moduledoc """
  Keeps one target app running warm as a separate BEAM node.

  The app boots in `MIX_ENV=test` with its endpoint serving on a free port and
  `PLAYWRIGHT_WS_ENDPOINT` pointing at `Cook.Pool.BrowserServer`. Once the node
  is up, the `Cook.Agent` modules are injected and `Cook.Agent.boot/1` loads the
  tests. After that the instance is `:ready` and runs go straight to it.

  If the OS process exits, the node disconnects or boot fails (for example the
  app does not compile right now), the instance is torn down and booted again
  after a short backoff; the GenServer itself stays up. The OS process dies with
  this GenServer through `Cook.Pool.OsProcess`.
  """

  use GenServer

  require Logger

  alias Cook.Pool.Distribution
  alias Cook.Pool.OsProcess

  @ready_marker "COOK_INSTANCE_READY"
  @agent_modules [Cook.Agent.Tracker, Cook.Agent, Cook.Agent.Formatter]
  @boot_timeout_ms 180_000
  @min_backoff_ms 1_000
  @max_backoff_ms 10_000

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: via(Keyword.fetch!(opts, :path)))
  end

  def child_spec(opts) do
    %{id: {__MODULE__, Keyword.fetch!(opts, :path)}, start: {__MODULE__, :start_link, [opts]}}
  end

  @doc """
  Registered name of the instance for an (absolute) app path.
  """
  def via(path), do: {:via, Registry, {Cook.Pool.Registry, path}}

  @doc """
  Waits until the instance is ready, at most `timeout` ms.

  Returns `{:ok, %{node: node, http_port: port, base_url: url, boot: info}}` or
  `{:error, {:not_ready, status}}`.
  """
  def await_ready(server, timeout) do
    GenServer.call(server, {:await_ready, timeout}, timeout + 5_000)
  end

  @doc """
  Current state without waiting: `%{status: status, node: node, ...}`.
  """
  def status(server), do: GenServer.call(server, :status)

  @doc """
  Short node name for an instance of the app at `path`. `unique` keeps a
  restarted instance from clashing with one that is still shutting down.
  """
  def short_name(path, unique) do
    hash = :md5 |> :crypto.hash(path) |> Base.encode16(case: :lower) |> binary_part(0, 8)
    "cook_app_#{hash}_#{unique}"
  end

  @doc """
  Arguments for `elixir` that boot the app as a named, hidden node.

  `prepare` is a list of Mix tasks (each a list of arguments) run before the
  app starts, in the same VM.
  """
  def elixir_args(short_name, cookie, prepare) do
    tasks =
      Enum.flat_map(prepare, &(&1 ++ ["+"])) ++
        ["run", "--no-halt", "-e", ~s|IO.puts("#{@ready_marker}")|]

    ["--sname", short_name, "--cookie", to_string(cookie), "--hidden", "-S", "mix", "do"] ++ tasks
  end

  @doc """
  Environment for the instance's OS process.
  """
  def env(http_port, ws_endpoint, extra \\ %{}) do
    Map.merge(
      %{
        "MIX_ENV" => "test",
        "PORT" => Integer.to_string(http_port),
        "PHX_SERVER" => "true",
        "PLAYWRIGHT_WS_ENDPOINT" => ws_endpoint
      },
      extra
    )
  end

  ## Callbacks

  @impl true
  def init(opts) do
    Process.flag(:trap_exit, true)

    state = %{
      path: Keyword.fetch!(opts, :path),
      test_paths: Keyword.get(opts, :test_paths, ["test"]),
      test_helper: Keyword.get(opts, :test_helper, "test/test_helper.exs"),
      prepare:
        Keyword.get(opts, :prepare, [["ecto.create", "--quiet"], ["ecto.migrate", "--quiet"]]),
      env: Keyword.get(opts, :env, %{}),
      ws_endpoint: Keyword.fetch!(opts, :ws_endpoint),
      status: :booting,
      generation: 0,
      backoff_ms: @min_backoff_ms,
      port: nil,
      node: nil,
      http_port: nil,
      holder_ref: nil,
      boot: nil,
      boot_started: nil,
      log: [],
      waiters: %{}
    }

    send(self(), :boot)
    {:ok, state}
  end

  @impl true
  def handle_call({:await_ready, _timeout}, _from, %{status: :ready} = state) do
    {:reply, {:ok, ready_info(state)}, state}
  end

  def handle_call({:await_ready, timeout}, from, state) do
    ref = make_ref()
    timer = Process.send_after(self(), {:waiter_timeout, ref}, timeout)
    {:noreply, %{state | waiters: Map.put(state.waiters, ref, {from, timer})}}
  end

  def handle_call(:status, _from, state) do
    reply = %{
      status: state.status,
      path: state.path,
      node: state.node,
      http_port: state.http_port,
      boot: state.boot,
      log: state.log
    }

    {:reply, reply, state}
  end

  @impl true
  def handle_info(:boot, %{port: nil} = state) do
    generation = state.generation + 1
    http_port = free_port()
    unique = "#{System.pid()}_#{System.unique_integer([:positive])}"
    short_name = short_name(state.path, unique)
    args = elixir_args(short_name, Node.get_cookie(), state.prepare)

    port =
      OsProcess.open(System.find_executable("elixir"), args,
        cd: state.path,
        env: env(http_port, state.ws_endpoint, state.env),
        # No graceful shutdown: a half-stopped instance would still answer a run.
        signal: "KILL"
      )

    Process.send_after(self(), {:boot_timeout, generation}, @boot_timeout_ms)

    {:noreply,
     %{
       state
       | status: :booting,
         generation: generation,
         port: port,
         node: Distribution.sibling(short_name),
         http_port: http_port,
         boot: nil,
         boot_started: System.monotonic_time(:millisecond),
         log: []
     }}
  end

  def handle_info(:boot, state), do: {:noreply, state}

  def handle_info({port, {:data, {_eol, line}}}, %{port: port} = state) do
    state = %{state | log: OsProcess.remember(state.log, line)}

    if state.status == :booting and String.contains?(line, @ready_marker) do
      attach(state)
      {:noreply, %{state | status: :attaching}}
    else
      {:noreply, state}
    end
  end

  def handle_info({port, {:exit_status, status}}, %{port: port} = state) do
    {:noreply, restart(%{state | port: nil}, {:exited, status})}
  end

  def handle_info(
        {:attached, generation, result},
        %{generation: generation, status: :attaching} = state
      ) do
    case result do
      {:ok, info} ->
        boot_ms = System.monotonic_time(:millisecond) - state.boot_started
        Logger.info("Cook instance #{state.node} ready in #{boot_ms} ms (#{state.path})")

        state = %{
          state
          | status: :ready,
            backoff_ms: @min_backoff_ms,
            holder_ref: Process.monitor(info.holder),
            boot: info |> Map.delete(:holder) |> Map.put(:boot_ms, boot_ms)
        }

        Node.monitor(state.node, true)
        {:noreply, reply_waiters(state, {:ok, ready_info(state)})}

      {:error, reason} ->
        {:noreply, restart(state, {:boot_failed, reason})}
    end
  end

  def handle_info({:nodedown, node}, %{node: node, status: :ready} = state) do
    {:noreply, restart(state, :nodedown)}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{holder_ref: ref} = state) do
    {:noreply, restart(state, {:test_helper_exited, inspect(reason)})}
  end

  def handle_info({:boot_timeout, generation}, %{generation: generation, status: status} = state)
      when status in [:booting, :attaching] do
    {:noreply, restart(state, :boot_timeout)}
  end

  def handle_info({:waiter_timeout, ref}, state) do
    case Map.pop(state.waiters, ref) do
      {{from, _timer}, waiters} ->
        GenServer.reply(from, {:error, {:not_ready, state.status}})
        {:noreply, %{state | waiters: waiters}}

      {nil, _waiters} ->
        {:noreply, state}
    end
  end

  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    close_port(state.port)
  end

  ## Internals

  # Connecting, injecting and loading the tests takes seconds; do it off the
  # GenServer so status calls and exit messages are still handled.
  defp attach(state) do
    server = self()
    %{node: node, generation: generation} = state
    boot_opts = [test_paths: state.test_paths, test_helper: state.test_helper]

    spawn_link(fn ->
      result =
        try do
          true = Node.connect(node)
          inject(node)
          :erpc.call(node, Cook.Agent, :boot, [boot_opts], @boot_timeout_ms)
        catch
          kind, reason -> {:error, {kind, reason}}
        end

      send(server, {:attached, generation, result})
    end)
  end

  defp inject(node) do
    for module <- @agent_modules do
      {^module, binary, file} = :code.get_object_code(module)
      {:module, ^module} = :erpc.call(node, :code, :load_binary, [module, file, binary])
    end
  end

  defp restart(state, reason) do
    Logger.warning(
      "Cook instance for #{state.path} is down (#{inspect(reason)}), " <>
        "rebooting in #{state.backoff_ms} ms. Last output:\n" <>
        (state.log |> Enum.take(-15) |> Enum.join("\n"))
    )

    close_port(state.port)
    if state.holder_ref, do: Process.demonitor(state.holder_ref, [:flush])
    if state.status == :ready, do: Node.monitor(state.node, false)
    Process.send_after(self(), :boot, state.backoff_ms)

    %{
      state
      | status: {:down, reason},
        port: nil,
        holder_ref: nil,
        boot: nil,
        backoff_ms: min(state.backoff_ms * 2, @max_backoff_ms)
    }
  end

  defp reply_waiters(state, reply) do
    for {_ref, {from, timer}} <- state.waiters do
      Process.cancel_timer(timer)
      GenServer.reply(from, reply)
    end

    %{state | waiters: %{}}
  end

  defp ready_info(state) do
    %{
      node: state.node,
      http_port: state.http_port,
      base_url: "http://127.0.0.1:#{state.http_port}",
      boot: state.boot
    }
  end

  defp close_port(nil), do: :ok

  defp close_port(port) do
    Port.close(port)
    :ok
  catch
    :error, :badarg -> :ok
  end

  defp free_port do
    {:ok, socket} = :gen_tcp.listen(0, ip: {127, 0, 0, 1})
    {:ok, port} = :inet.port(socket)
    :gen_tcp.close(socket)
    port
  end
end
