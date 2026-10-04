defmodule Cook.Pool.CommandsTest do
  @moduledoc """
  The OS commands the pool builds. Nothing is started here.
  """
  use ExUnit.Case, async: true

  alias Cook.Pool.AppInstance
  alias Cook.Pool.BrowserServer
  alias Cook.Pool.Distribution
  alias Cook.Pool.OsProcess

  describe "BrowserServer" do
    test "ws_endpoint/1" do
      assert BrowserServer.ws_endpoint(port: 4041) == "ws://127.0.0.1:4041"
      assert BrowserServer.ws_endpoint(host: "localhost", port: 9) == "ws://localhost:9"
    end

    test "args/1 runs the Playwright server on the configured port" do
      assert BrowserServer.args(port: 4041, cli: "/x/cli.js") ==
               ["/x/cli.js", "run-server", "--port", "4041", "--host", "127.0.0.1"]
    end

    test "the default CLI lives in Cook's priv directory" do
      assert BrowserServer.cli_path([]) =~ "priv/playwright/node_modules/playwright/cli.js"
    end
  end

  describe "AppInstance" do
    test "short_name/2 is stable per path and unique per start" do
      assert AppInstance.short_name("/a", 1) == AppInstance.short_name("/a", 1)
      refute AppInstance.short_name("/a", 1) == AppInstance.short_name("/a", 2)
      refute AppInstance.short_name("/a", 1) == AppInstance.short_name("/b", 1)
      assert AppInstance.short_name("/a", 1) =~ ~r/^cook_app_[0-9a-f]{8}_1$/
    end

    test "elixir_args/3 boots a hidden named node, prepares, then serves" do
      args =
        AppInstance.elixir_args("cook_app_x", :secret, [
          ["ecto.create", "--quiet"],
          ["ecto.migrate", "--quiet"]
        ])

      assert args == [
               "--sname",
               "cook_app_x",
               "--cookie",
               "secret",
               "--hidden",
               "-S",
               "mix",
               "do",
               "ecto.create",
               "--quiet",
               "+",
               "ecto.migrate",
               "--quiet",
               "+",
               "run",
               "--no-halt",
               "-e",
               ~s|IO.puts("COOK_INSTANCE_READY")|
             ]
    end

    test "elixir_args/3 without prepare tasks" do
      assert ["--sname", "n", "--cookie", "c", "--hidden", "-S", "mix", "do", "run" | _rest] =
               AppInstance.elixir_args("n", :c, [])
    end

    test "env/3 runs the app in test mode against the warm browser" do
      assert AppInstance.env(4123, "ws://127.0.0.1:4041", %{"EXTRA" => "1"}) == %{
               "MIX_ENV" => "test",
               "PORT" => "4123",
               "PHX_SERVER" => "true",
               "PLAYWRIGHT_WS_ENDPOINT" => "ws://127.0.0.1:4041",
               "EXTRA" => "1"
             }
    end

    test "child_spec/1 is unique per app path" do
      assert AppInstance.child_spec(path: "/a").id == {AppInstance, "/a"}
    end
  end

  describe "OsProcess" do
    test "port_options/3 goes through the wrapper with a kill signal" do
      options =
        OsProcess.port_options("/bin/node", ["cli.js"],
          cd: "/app",
          env: %{"A" => "1", "B" => nil},
          signal: "KILL"
        )

      assert options[:args] == ["KILL", "/bin/node", "cli.js"]
      assert options[:cd] == "/app"
      assert Enum.sort(options[:env]) == [{~c"A", ~c"1"}, {~c"B", false}]
      assert :exit_status in options
    end

    test "port_options/3 defaults to TERM and the current directory" do
      options = OsProcess.port_options("/bin/node", [])
      assert options[:args] == ["TERM", "/bin/node"]
      refute Keyword.has_key?(options, :cd)
    end

    test "the wrapper script is executable" do
      assert %File.Stat{mode: mode} = File.stat!(OsProcess.wrapper_path())
      assert Bitwise.band(mode, 0o100) != 0
    end

    test "remember/3 keeps the newest lines" do
      assert OsProcess.remember(["a", "b"], "c", 2) == ["b", "c"]
      assert OsProcess.remember([], "a", 2) == ["a"]
    end
  end

  describe "Distribution" do
    test "names" do
      assert Distribution.default_name("123") == :cook_123
      assert Distribution.host(:cook_1@box) == "box"
      assert Distribution.sibling("cook_app_x", :cook_1@box) == :cook_app_x@box
    end
  end

  describe "Supervisor.instance_specs/2" do
    test "one instance per configured app, with the browser endpoint" do
      config = [apps: [[path: "/a", test_paths: ["test/features"]], [path: "/b"]]]

      assert [
               %{id: {AppInstance, "/a"}, start: {AppInstance, :start_link, [opts]}},
               %{id: {AppInstance, "/b"}}
             ] =
               Cook.Pool.Supervisor.instance_specs(config, "ws://127.0.0.1:4041")

      assert opts[:ws_endpoint] == "ws://127.0.0.1:4041"
      assert opts[:test_paths] == ["test/features"]
    end
  end
end
