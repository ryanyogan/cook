defmodule Cook.Agent.Tracker do
  @moduledoc """
  Ties browser pages, console errors and server log lines to the test they belong to.

  Runs inside the target app's VM (injected with `Cook.Agent`). A target app opts in
  with one guarded `setup` in its browser case template, placed after
  `use PhoenixTest.Playwright.Case` so the context already has `:conn`:

      setup context do
        if Code.ensure_loaded?(Cook.Agent), do: Cook.Agent.track(context)
        :ok
      end

  For a tracked test this module records, when the test exits and before its
  browser context is closed: the page's HTML, the console errors and page errors
  of its browser context, and the log lines of every process working for it.

  A process works for a test when it is the test process, has it in `$callers`,
  or serves a request / LiveView whose User-Agent carries the test's sandbox
  metadata (`Phoenix.Ecto.SQL.Sandbox`): the owner in that metadata is the test pid.
  """

  @compile {:no_warn_undefined,
            [ExUnit.Callbacks, PlaywrightEx, PlaywrightEx.Frame, Phoenix.Ecto.SQL.Sandbox]}

  @table :cook_agent_tracker
  @owner_key {__MODULE__, :owner}
  @handler_id :cook_agent_tracker
  @telemetry_events [[:phoenix, :endpoint, :start], [:phoenix, :live_view, :mount, :start]]
  @snapshot_timeout_ms 2_000
  @collect_timeout_ms 1_000
  @max_lines 200
  @max_line_bytes 2_000

  @doc """
  Creates the table and installs the log handler and telemetry handlers. The
  calling process owns the table, so call it from a process that never exits.
  """
  def install do
    if :ets.whereis(@table) == :undefined do
      :ets.new(@table, [:named_table, :public, :ordered_set, write_concurrency: true])
    end

    {formatter, formatter_config} = Logger.Formatter.new(format: "[$level] $message")
    config = %{level: :all, config: %{formatter: {formatter, formatter_config}}}
    _ = :logger.remove_handler(@handler_id)
    _ = :logger.add_handler(@handler_id, __MODULE__, config)

    if Code.ensure_loaded?(:telemetry) do
      _ = :telemetry.detach(@handler_id)
      _ = :telemetry.attach_many(@handler_id, @telemetry_events, &__MODULE__.handle_event/4, nil)
    end

    :ok
  end

  @doc """
  Starts collecting for a run; artifacts are written to `dir`.
  """
  def start_run(dir) do
    if :ets.whereis(@table) != :undefined do
      :ets.delete_all_objects(@table)
      File.mkdir_p!(dir)
      :ets.insert(@table, {:run, dir})
    end

    :ok
  end

  @doc """
  Stops collecting. Returns `%{{module, test_name} => artifacts}` for the keys
  for which `keep?` returns true and deletes the files of the others.
  """
  def finish_run(keep?) do
    if :ets.whereis(@table) == :undefined do
      %{}
    else
      results = :ets.select(@table, [{{{:result, :"$1"}, :"$2"}, [], [{{:"$1", :"$2"}}]}])
      :ets.delete_all_objects(@table)

      for {key, artifacts} <- results, reduce: %{} do
        kept ->
          if keep?.(key) do
            Map.put(kept, key, artifacts)
          else
            if artifacts.dom_snapshot, do: File.rm(artifacts.dom_snapshot)
            kept
          end
      end
    end
  end

  @doc """
  Called from the target app's `setup` (in the test process). Never raises.
  """
  def track(context) do
    case run_dir() do
      nil ->
        :ok

      dir ->
        test_pid = self()
        key = {inspect(context.module), Atom.to_string(context.test)}
        session = session(Map.get(context, :conn))
        collector = session && start_collector(session.context_id, test_pid)
        :ets.insert(@table, {{:test, test_pid}, key})
        name = file_name(context)

        ExUnit.Callbacks.on_exit({__MODULE__, test_pid}, fn ->
          capture(dir, name, test_pid, key, session, collector)
        end)

        :ok
    end
  catch
    _kind, _reason -> :ok
  end

  @doc """
  `artifacts/<name>` base name for a test: `"checkout_test_42"` for
  `test/features/checkout_test.exs:42`.
  """
  def file_name(%{file: file, line: line}) do
    base = file |> Path.basename() |> Path.rootname() |> String.replace(~r/[^a-zA-Z0-9_]/, "_")
    "#{base}_#{line}"
  end

  ## Logger handler (runs in the process that logs)

  @doc false
  def log(event, %{config: %{formatter: {formatter, formatter_config}}}) do
    with pid when is_pid(pid) <- owner(),
         true <- :ets.member(@table, {:test, pid}) do
      line =
        event
        |> formatter.format(formatter_config)
        |> IO.chardata_to_string()
        |> String.trim_trailing()
        |> truncate()

      :ets.insert(@table, {{:log, pid, System.unique_integer([:monotonic])}, line})
    end

    :ok
  catch
    _kind, _reason -> :ok
  end

  def log(_event, _config), do: :ok

  defp owner do
    cond do
      :ets.whereis(@table) == :undefined -> nil
      :ets.member(@table, {:test, self()}) -> self()
      owner = Process.get(@owner_key) -> owner
      true -> Enum.find(Process.get(:"$callers") || [], &:ets.member(@table, {:test, &1}))
    end
  end

  ## Telemetry handlers (run in the request / LiveView process)

  @doc false
  def handle_event([:phoenix, :endpoint, :start], _measurements, %{conn: conn}, _config) do
    conn.req_headers |> List.keyfind("user-agent", 0) |> mark()
  catch
    _kind, _reason -> :ok
  end

  def handle_event([:phoenix, :live_view, :mount, :start], _measure, %{socket: socket}, _config) do
    case socket.private do
      %{connect_info: %{user_agent: user_agent}} when is_binary(user_agent) ->
        mark({"user-agent", user_agent})

      _other ->
        :ok
    end
  catch
    _kind, _reason -> :ok
  end

  def handle_event(_event, _measurements, _metadata, _config), do: :ok

  defp mark({"user-agent", user_agent}) do
    if run_dir() && Code.ensure_loaded?(Phoenix.Ecto.SQL.Sandbox) do
      case Phoenix.Ecto.SQL.Sandbox.decode_metadata(user_agent) do
        %{owner: owner} when is_pid(owner) -> Process.put(@owner_key, owner)
        _other -> Process.delete(@owner_key)
      end
    end

    :ok
  end

  defp mark(nil) do
    Process.delete(@owner_key)
    :ok
  end

  ## Capture (runs in the test's on_exit, before its browser context is closed)

  defp capture(dir, name, test_pid, key, session, collector) do
    artifacts = %{
      console_errors: collect(collector),
      dom_snapshot: session && snapshot(Path.join(dir, name <> ".html"), session.frame_id),
      server_logs: take_logs(test_pid)
    }

    :ets.insert(@table, {{:result, key}, artifacts})
    :ets.delete(@table, {:test, test_pid})
    :ok
  catch
    _kind, _reason -> :ok
  end

  defp snapshot(file, frame_id) do
    case PlaywrightEx.Frame.content(frame_id, timeout: @snapshot_timeout_ms) do
      {:ok, html} when is_binary(html) ->
        File.write!(file, html)
        file

      _other ->
        nil
    end
  catch
    _kind, _reason -> nil
  end

  defp take_logs(test_pid) do
    spec = [{{{:log, test_pid, :_}, :"$1"}, [], [:"$1"]}]
    lines = :ets.select(@table, spec)
    :ets.select_delete(@table, [{{{:log, test_pid, :_}, :_}, [], [true]}])
    Enum.take(lines, -@max_lines)
  end

  defp session(%{context_id: context_id, frame_id: frame_id})
       when is_binary(context_id) and is_binary(frame_id) do
    if Code.ensure_loaded?(PlaywrightEx.Frame),
      do: %{context_id: context_id, frame_id: frame_id},
      else: nil
  end

  defp session(_conn), do: nil

  ## Console collector: one small process per tracked test

  defp start_collector(context_id, test_pid) do
    collector =
      spawn(fn ->
        Process.monitor(test_pid)
        collect_loop([])
      end)

    PlaywrightEx.subscribe(context_id, pid: collector)
    collector
  catch
    _kind, _reason -> nil
  end

  defp collect_loop(errors) do
    receive do
      {:playwright_msg, %{method: :console, params: %{type: "error"} = params}} ->
        collect_loop([truncate(to_string(params[:text])) | errors])

      {:playwright_msg, %{method: :page_error, params: params}} ->
        collect_loop([truncate("uncaught: " <> error_text(params)) | errors])

      {:collect, from, ref} ->
        send(from, {ref, errors |> Enum.reverse() |> Enum.take(@max_lines)})

      {:DOWN, _ref, :process, _pid, _reason} ->
        # The test is over; its on_exit collects within moments.
        Process.send_after(self(), :stop, 30_000)
        collect_loop(errors)

      :stop ->
        :ok

      _other ->
        collect_loop(errors)
    end
  end

  defp error_text(%{error: %{error: %{message: message}}}) when is_binary(message), do: message
  defp error_text(%{error: %{value: value}}), do: inspect(value)
  defp error_text(params), do: inspect(Map.get(params, :error, params))

  defp collect(nil), do: []

  defp collect(collector) do
    ref = make_ref()
    send(collector, {:collect, self(), ref})

    receive do
      {^ref, errors} -> errors
    after
      @collect_timeout_ms -> []
    end
  end

  defp run_dir do
    if :ets.whereis(@table) != :undefined do
      case :ets.lookup(@table, :run) do
        [{:run, dir}] -> dir
        [] -> nil
      end
    end
  end

  defp truncate(text) when byte_size(text) > @max_line_bytes do
    String.slice(text, 0, @max_line_bytes) <> "…"
  end

  defp truncate(text), do: text
end
