defmodule CookWeb.PageController do
  use CookWeb, :controller

  def home(conn, _params) do
    render(conn, :home)
  end
end
