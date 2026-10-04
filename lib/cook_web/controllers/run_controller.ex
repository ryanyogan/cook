defmodule CookWeb.RunController do
  @moduledoc """
  `POST /api/runs`: runs tests on the warm pool and answers with the verdict.

  Params: `path` (app directory; default app when absent), `tests` (list of
  `file`, `file:line` or directory), `format` (`"json"`, the default, answers
  with the verdict JSON; `"text"` with a short human summary).

  The request blocks until the verdict exists. The `x-cook-exit-code` response
  header carries the CLI exit code (0 pass, 1 fail, 2 error), so `bin/cook` needs
  no JSON parser.
  """

  use CookWeb, :controller

  alias Cook.Verdict

  def create(conn, params) do
    path = if is_binary(params["path"]) and params["path"] != "", do: params["path"]
    tests = for test <- List.wrap(params["tests"]), is_binary(test), do: test
    verdict = Cook.Runs.run(path, tests)

    {content_type, body} =
      case params["format"] do
        "text" -> {"text/plain", Verdict.summary(verdict)}
        _json -> {"application/json", Verdict.to_json(verdict)}
      end

    conn
    |> put_resp_header("x-cook-exit-code", Integer.to_string(Verdict.exit_code(verdict)))
    |> put_resp_content_type(content_type)
    |> send_resp(200, body)
  end
end
