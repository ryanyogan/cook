defmodule SampleAppWeb.SupportHTML do
  @moduledoc """
  Pages rendered by `SampleAppWeb.SupportController`.
  """
  use SampleAppWeb, :html

  embed_templates "support_html/*"
end
