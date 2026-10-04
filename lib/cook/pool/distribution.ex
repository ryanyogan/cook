defmodule Cook.Pool.Distribution do
  @moduledoc """
  Makes the Cook VM a distributed node so it can talk to app instance nodes.

  Short names only, everything stays on this machine. If the VM was already
  started with a node name, that name and cookie are used as they are.
  """

  require Logger

  @doc """
  Starts distribution if it is not running yet.
  """
  def ensure_started do
    if Node.alive?() do
      :ok
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

  defp start_epmd do
    epmd = System.find_executable("epmd") || Path.join([:code.root_dir(), "bin", "epmd"])

    case System.cmd(epmd, ["-daemon"], stderr_to_stdout: true) do
      {_out, 0} -> :ok
      {out, status} -> Logger.warning("epmd -daemon exited with #{status}: #{out}")
    end
  end

  defp random_cookie do
    18 |> :crypto.strong_rand_bytes() |> Base.url_encode64() |> String.to_atom()
  end
end
