defmodule CookWeb.RunControllerTest do
  use CookWeb.ConnCase, async: false

  alias Cook.PoolStub

  test "POST /api/runs answers with the verdict JSON and exit code 0 on pass", %{conn: conn} do
    PoolStub.put(fn _path, opts ->
      assert opts[:tests] == ["test/a_test.exs:3"]
      {:ok, PoolStub.raw([{"test/a_test.exs:3", :passed, 40}])}
    end)

    conn = post(conn, ~p"/api/runs", %{"tests" => ["test/a_test.exs:3"]})

    assert get_resp_header(conn, "x-cook-exit-code") == ["0"]

    assert %{
             "schema" => "cook.verdict/1",
             "status" => "pass",
             "selected" => 1,
             "selection_reason" => "explicit"
           } = json_response(conn, 200)
  end

  test "a failing run has exit code 1 and format=text gives the summary", %{conn: conn} do
    PoolStub.put(fn _path, _opts -> {:ok, PoolStub.raw([{"test/a_test.exs:3", :failed, 40}])} end)

    conn = post(conn, ~p"/api/runs", %{"format" => "text"})

    assert get_resp_header(conn, "x-cook-exit-code") == ["1"]
    assert response(conn, 200) =~ "FAIL   1 of 1 tests failed"
  end

  test "a run that could not complete has exit code 2 and an error verdict", %{conn: conn} do
    PoolStub.put(fn _path, _opts -> {:error, {:instance_down, :noconnection}} end)

    conn = post(conn, ~p"/api/runs", %{})

    assert get_resp_header(conn, "x-cook-exit-code") == ["2"]

    assert %{"status" => "error", "error" => %{"reason" => "app_instance_down"}} =
             json_response(conn, 200)
  end

  test "GET /api/status reports readiness", %{conn: conn} do
    conn = get(conn, ~p"/api/status")

    assert get_resp_header(conn, "x-cook-exit-code") == ["0"]

    assert %{"ready" => true, "schema" => "cook.verdict/1", "runs" => %{"queued" => 0}} =
             json_response(conn, 200)

    assert conn |> recycle() |> get(~p"/api/status?format=text") |> response(200) =~
             "cook daemon: ready"
  end
end
