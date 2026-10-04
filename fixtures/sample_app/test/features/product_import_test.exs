defmodule SampleAppWeb.Features.ProductImportTest do
  use SampleAppWeb.FeatureCase, async: true

  setup :register_and_log_in_user

  # SLOW on purpose (about 2.5 s): the import itself takes 1.75 s on the server.
  @tag :slow
  test "a bulk import adds every listed product", %{conn: conn} do
    tag = unique_tag()

    rows = """
    Imported Mug #{tag},500,3
    Imported Bowl #{tag},700,0
    """

    conn
    |> visit_live(~p"/products/import")
    |> fill_in("Product rows", with: rows)
    |> click_button("Import products")
    |> assert_has("#import-result", text: "Imported 2 products.", timeout: 6_000)
    |> click_link("Back to products")
    |> assert_has("h1", text: "Products")
    |> wait_for_live()
    |> fill_in("Search products", with: "Imported Mug #{tag}")
    |> assert_has("#products li", text: "Imported Mug #{tag}")
    |> assert_has("#products li", text: "$5.00")
  end

  test "an empty import is refused straight away", %{conn: conn} do
    conn
    |> visit_live(~p"/products/import")
    |> click_button("Import products")
    |> assert_has("#import-error", text: "Nothing to import")
  end
end
