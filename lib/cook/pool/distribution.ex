defmodule Cook.Pool.Distribution do
  @moduledoc """
  Makes the Cook VM a distributed node so it can talk to app instance nodes.

  Short names only, everything stays on this machine. If the VM was already
  started with a node name, that name and cookie are used as they are.

  The cookie is handed to every app instance as `elixir --cookie COOKIE`, and
  `erl` reads an argument that starts with `-` or `+` as a flag of its own. Such
  a cookie is dropped silently: the instance boots with the cookie from
  `~/.erlang.cookie`, rejects Cook's connection and never becomes ready. So Cook
  only generates cookies made of hex digits and refuses to start with any other
  cookie that `cookie_usable?/1` rejects.
  """

  require Logger

  @doc """
  Starts distribution if it is not running yet.
  """
  def ensure_started do
    if Node.alive?() do
      check_cookie(Node.get_cookie())
    else
      start_epmd()

      case :net_kernel.start(default_name(System.pid()), %{name_domain: :shortnames}) do
        {:ok, _pid} ->
          Node.set_cookie(random_cookie())
          :ok

        {:error, {:already_started, _pid}} ->
          :ok

        {:error, reason} ->
          {:error, {:distribution_failed, reason}}
      end
    end
  end

  @doc """
  The node name Cook gives itself when it was not started with one.
  """
  def default_name(os_pid), do: :"cook_#{os_pid}"

  @doc """
  Host part of a node name: `host(:"cook@box")` is `"box"`.
  """
  def host(node \\ node()) do
    [_name, host] = node |> Atom.to_string() |> String.split("@", parts: 2)
    host
  end

  @doc """
  Full node name for a short name on this machine.
  """
  def sibling(short_name, node \\ node()), do: :"#{short_name}@#{host(node)}"

  @doc """
  A new cookie for the Cook node and its instances: 32 hex digits.
  """
  def random_cookie do
    16 |> :crypto.strong_rand_bytes() |> Base.encode16(case: :lower) |> String.to_atom()
  end

  @doc """
  Whether `cookie` survives being passed to an instance as `elixir --cookie COOKIE`.
  """
  def cookie_usable?(cookie) when is_atom(cookie) do
    case Atom.to_string(cookie) do
      "" -> false
      "-" <> _rest -> false
      "+" <> _rest -> false
      _other -> true
    end
  end

  @doc """
  `:ok` for a usable cookie, otherwise `{:error, {:unusable_cookie, message}}`.
  """
  def check_cookie(cookie) do
    if cookie_usable?(cookie) do
      :ok
    else
      {:error,
       {:unusable_cookie,
        "the Erlang cookie of this node is empty or starts with \"-\" or \"+\"; erl would read it " <>
          "as a flag when it is passed to an app instance, and the instance could never be " <>
          "connected to. Start Cook with a different cookie, or without a node name."}}
    end
  end

  defp start_epmd do
    epmd = System.find_executable("epmd") || Path.join([:code.root_dir(), "bin", "epmd"])

    case System.cmd(epmd, ["-daemon"], stderr_to_stdout: true) do
      {_out, 0} -> :ok
      {out, status} -> Logger.warning("epmd -daemon exited with #{status}: #{out}")
    end
  end
end
