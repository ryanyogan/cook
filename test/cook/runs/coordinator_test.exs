defmodule Cook.Runs.CoordinatorTest do
  use ExUnit.Case, async: true

  alias Cook.Runs.Coordinator

  setup do
    test_pid = self()

    runner = fn request ->
      send(test_pid, {:started, request.tests, self()})

      receive do
        :finish -> %{status: "pass", tests: request.tests}
        :crash -> exit(:boom)
      end
    end

    supervisor =
      start_supervised!({Task.Supervisor, name: :"tasks_#{System.unique_integer([:positive])}"})

    coordinator =
      start_supervised!({Coordinator, name: nil, runner: runner, task_supervisor: supervisor})

    %{coordinator: coordinator}
  end

  defp request(path, tests) do
    %{path: path, tests: tests, opts: [], received_at: System.monotonic_time(:millisecond)}
  end

  test "runs of one app go one at a time, in arrival order", %{coordinator: coordinator} do
    first = Task.async(fn -> Coordinator.run(coordinator, request("/a", ["1"])) end)
    assert_receive {:started, ["1"], first_runner}
    second = Task.async(fn -> Coordinator.run(coordinator, request("/a", ["2"])) end)
    refute_receive {:started, ["2"], _pid}, 50
    assert Coordinator.info(coordinator) == %{running: ["/a"], queued: 1}

    send(first_runner, :finish)
    assert Task.await(first) == %{status: "pass", tests: ["1"]}
    assert_receive {:started, ["2"], second_runner}
    send(second_runner, :finish)
    assert Task.await(second) == %{status: "pass", tests: ["2"]}
    assert Coordinator.info(coordinator) == %{running: [], queued: 0}
  end

  test "different apps run at the same time", %{coordinator: coordinator} do
    first = Task.async(fn -> Coordinator.run(coordinator, request("/a", ["1"])) end)
    second = Task.async(fn -> Coordinator.run(coordinator, request("/b", ["2"])) end)
    assert_receive {:started, ["1"], first_runner}
    assert_receive {:started, ["2"], second_runner}
    send(first_runner, :finish)
    send(second_runner, :finish)
    assert [%{status: "pass"}, %{status: "pass"}] = Task.await_many([first, second])
  end

  @tag :capture_log
  test "a crashing run gives its caller an error verdict and the queue moves on", %{
    coordinator: coordinator
  } do
    first = Task.async(fn -> Coordinator.run(coordinator, request("/a", ["1"])) end)
    assert_receive {:started, ["1"], first_runner}
    second = Task.async(fn -> Coordinator.run(coordinator, request("/a", ["2"])) end)
    send(first_runner, :crash)

    verdict = Task.await(first)
    assert verdict.status == "error"
    assert verdict.error.reason == "runner_crashed"

    assert_receive {:started, ["2"], second_runner}
    send(second_runner, :finish)
    assert Task.await(second).status == "pass"
  end
end
