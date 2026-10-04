defmodule Cook.CLITest do
  use ExUnit.Case, async: true

  @cook Path.expand("../../bin/cook", __DIR__)
  # Nothing listens here, so the CLI gets no answer and never starts a run.
  @env [{"COOK_URL", "http://127.0.0.1:9"}]

  test "run and status exit with 2 and say so on stderr when the daemon is unreachable" do
    for args <- [["run", "--json"], ["run", "test/a_test.exs:3"], ["status"]] do
      assert {output, 2} = System.cmd(@cook, args, env: @env, stderr_to_stdout: true)
      assert output =~ "no answer from the daemon"
      # Nothing but a verdict may ever be on stdout.
      assert {"", 2} =
               System.cmd("sh", ["-c", ~s("$0" "$@" 2>/dev/null), @cook | args], env: @env)
    end
  end

  test "unknown commands and options are usage errors" do
    assert {_usage, 2} = System.cmd(@cook, ["bogus"], stderr_to_stdout: true)
    assert {output, 2} = System.cmd(@cook, ["run", "--nope"], env: @env, stderr_to_stdout: true)
    assert output =~ "unknown option --nope"
    assert {usage, 0} = System.cmd(@cook, ["--help"])
    assert usage =~ "bin/cook run [PATH] [TEST...] [--json]"
  end
end
