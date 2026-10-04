defmodule Cook.Pool.OsProcess do
  @moduledoc """
  Opens OS processes as Ports through `priv/pool/port_wrapper.sh`.

  The wrapper kills the program (and its process group) when the Port closes,
  which happens when the owning process dies or the Cook VM goes away. Without
  it, Node and BEAM children would outlive their GenServer.
  """

  @line_bytes 16_384

  @doc """
  Starts `executable` with `args` and returns the Port.

  Options: `:cd` (working directory), `:env` (a map of name to value, where a
  `nil` value unsets the variable) and `:signal` (`"TERM"`, the default, gives
  the program a second to clean up before it is killed; `"KILL"` does not).
  Output arrives as
  `{port, {:data, {:eol | :noeol, binary}}}` and the exit as
  `{port, {:exit_status, status}}`.
  """
  def open(executable, args, opts \\ []) do
    Port.open({:spawn_executable, wrapper_path()}, port_options(executable, args, opts))
  end

  @doc """
  The Port options used by `open/3`.
  """
  def port_options(executable, args, opts \\ []) do
    base = [
      :binary,
      :exit_status,
      :stderr_to_stdout,
      {:line, @line_bytes},
      {:args, [Keyword.get(opts, :signal, "TERM"), executable | args]},
      {:env, port_env(Keyword.get(opts, :env, %{}))}
    ]

    case Keyword.get(opts, :cd) do
      nil -> base
      dir -> [{:cd, dir} | base]
    end
  end

  @doc """
  Path of the wrapper script.
  """
  def wrapper_path do
    Application.app_dir(:cook, "priv/pool/port_wrapper.sh")
  end

  @doc """
  Appends a line of program output to a bounded log (newest last).
  """
  def remember(log, line, max \\ 60) do
    Enum.take([line | Enum.reverse(log)], max) |> Enum.reverse()
  end

  defp port_env(env) do
    for {name, value} <- env do
      {String.to_charlist(name), if(value, do: String.to_charlist(value), else: false)}
    end
  end
end
