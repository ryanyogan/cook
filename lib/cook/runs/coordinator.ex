defmodule Cook.Runs.Coordinator do
  @moduledoc """
  Lets one run at a time through per app; other callers queue in arrival order.

  Each run executes in its own task (`Cook.Runs.Runner.run/1` unless a `:runner`
  function is given). If that task crashes, its caller still gets a verdict, an
  `error` one, and the queue moves on.
  """

  use GenServer

  alias Cook.Verdict

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Runs `request` (`%{path, tests, opts, received_at}`) when it is its turn and
  returns the verdict. Blocks for as long as that takes.
  """
  def run(server \\ __MODULE__, request) do
    GenServer.call(server, {:run, request}, :infinity)
  end

  @doc """
  What is running and queued: `%{running: [path], queued: integer}`.
  """
  def info(server \\ __MODULE__) do
    GenServer.call(server, :info)
  end

  @impl true
  def init(opts) do
    {:ok,
     %{
       runner: Keyword.get(opts, :runner, &Cook.Runs.Runner.run/1),
       task_supervisor: Keyword.get(opts, :task_supervisor, Cook.Runs.TaskSupervisor),
       running: %{},
       queues: %{}
     }}
  end

  @impl true
  def handle_call({:run, request}, from, state) do
    if busy?(state, request.path) do
      queue =
        state.queues
        |> Map.get(request.path, :queue.new())
        |> then(&:queue.in({from, request}, &1))

      {:noreply, %{state | queues: Map.put(state.queues, request.path, queue)}}
    else
      {:noreply, start(state, from, request)}
    end
  end

  def handle_call(:info, _from, state) do
    info = %{
      running: for({_ref, {_from, request}} <- state.running, do: request.path),
      queued: state.queues |> Map.values() |> Enum.map(&:queue.len/1) |> Enum.sum()
    }

    {:reply, info, state}
  end

  @impl true
  def handle_info({ref, verdict}, state) when is_map_key(state.running, ref) do
    Process.demonitor(ref, [:flush])
    {:noreply, finish(state, ref, verdict)}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, state)
      when is_map_key(state.running, ref) do
    {_from, request} = Map.fetch!(state.running, ref)
    {:noreply, finish(state, ref, crash_verdict(request, reason))}
  end

  def handle_info(_message, state), do: {:noreply, state}

  defp busy?(state, path) do
    Enum.any?(state.running, fn {_ref, {_from, request}} -> request.path == path end)
  end

  defp start(state, from, request) do
    runner = state.runner
    task = Task.Supervisor.async_nolink(state.task_supervisor, fn -> runner.(request) end)
    %{state | running: Map.put(state.running, task.ref, {from, request})}
  end

  defp finish(state, ref, verdict) do
    {{from, request}, running} = Map.pop!(state.running, ref)
    GenServer.reply(from, verdict)
    state = %{state | running: running}

    case :queue.out(Map.get(state.queues, request.path, :queue.new())) do
      {{:value, {next_from, next_request}}, queue} ->
        start(
          %{state | queues: Map.put(state.queues, request.path, queue)},
          next_from,
          next_request
        )

      {:empty, _queue} ->
        %{state | queues: Map.delete(state.queues, request.path)}
    end
  end

  defp crash_verdict(request, reason) do
    elapsed = System.monotonic_time(:millisecond) - request.received_at

    Verdict.build({:error, {:runner_crashed, Exception.format_exit(reason)}}, %{
      run_id: Cook.Runs.Runner.new_run_id(),
      path: request.path,
      tests: request.tests,
      cap_ms: 0,
      queue_ms: 0,
      wait_ms: 0,
      duration_ms: elapsed
    })
  end
end
