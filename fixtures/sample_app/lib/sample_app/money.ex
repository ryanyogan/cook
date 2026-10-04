defmodule SampleApp.Money do
  @moduledoc """
  Formatting for amounts stored as integer cents.
  """

  @doc """
  Formats cents as dollars.

      iex> SampleApp.Money.format(1999)
      "$19.99"
  """
  def format(cents) when is_integer(cents) do
    sign = if cents < 0, do: "-", else: ""
    cents = abs(cents)
    rem = cents |> rem(100) |> Integer.to_string() |> String.pad_leading(2, "0")
    "#{sign}$#{div(cents, 100)}.#{rem}"
  end
end
