defmodule CookWeb.StatusController do
  @moduledoc """
  `GET /api/status`: whether the pool can take a run right now, what is running
  and the last run. `format=text` answers with a short human summary.

  The `x-cook-exit-code` header is 0 when the pool is ready and 2 otherwise.
  """

  use CookWeb, :controller

  def show(conn, params) do
    status = Cook.Runs.status()

    {content_type, body} =
      case params["format"] do
        "text" -> {"text/plain", text(status)}
        _json -> {"application/json", Jason.encode_to_iodata!(status)}
      end

    conn
    |> put_resp_header("x-cook-exit-code", if(status.ready, do: "0", else: "2"))
    |> put_resp_content_type(content_type)
    |> send_resp(200, body)
  end

  defp text(status) do
    browser = status.pool.browser_server

    lines =
      [
        "cook daemon: #{if status.ready, do: "ready", else: "not ready"} (#{status.schema})",
        "  browser server: #{if browser, do: "#{browser.status} on port #{browser.port}", else: "down"}"
      ] ++
        for instance <- status.pool.instances do
          "  app instance:   #{instance.status}  #{instance.path}"
        end ++
        [
          "  runs:           #{length(status.runs.running)} running, #{status.runs.queued} queued",
          case status.last_run do
            nil -> "  last run:       none"
            run -> "  last run:       #{run.status} in #{run.duration_ms} ms (#{run.run_id})"
          end
        ]

    Enum.join(lines, "\n") <> "\n"
  end
end
