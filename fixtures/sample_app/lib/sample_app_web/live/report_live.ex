defmodule SampleAppWeb.ReportLive do
  use SampleAppWeb, :live_view

  alias Phoenix.LiveView.AsyncResult
  alias SampleApp.Money
  alias SampleApp.Reports

  # Deliberately SLOW: stands in for crunching a lot of rows.
  @simulated_work_ms 1_000

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash} current_scope={@current_scope}>
      <.header>
        Reports
        <:subtitle>A summary of your own activity.</:subtitle>
        <:actions>
          <.button
            variant="primary"
            id="generate-report"
            phx-click="generate"
            disabled={@report && @report.loading}
          >
            Generate report
          </.button>
        </:actions>
      </.header>

      <p :if={!@report} id="report-idle">No report generated yet.</p>

      <div :if={@report} id="report-status">
        <p :if={@report.loading} id="report-running">Crunching the numbers...</p>
        <p :if={@report.failed} id="report-error" class="text-error">The report failed.</p>
        <dl :if={@report.ok?} id="report-result" class="grid grid-cols-2 gap-2">
          <dt>Orders placed</dt>
          <dd id="report-orders">{@report.result.orders}</dd>
          <dt>Units bought</dt>
          <dd id="report-units">{@report.result.units}</dd>
          <dt>Total spent</dt>
          <dd id="report-total">{Money.format(@report.result.total_cents)}</dd>
          <dt>Messages posted</dt>
          <dd id="report-messages">{@report.result.messages}</dd>
        </dl>
      </div>
    </Layouts.app>
    """
  end

  @impl true
  def mount(_params, _session, socket) do
    {:ok, socket |> assign(:page_title, "Reports") |> assign(:report, nil)}
  end

  @impl true
  def handle_event("generate", _params, socket) do
    scope = socket.assigns.current_scope

    {:noreply,
     socket
     |> assign(:report, AsyncResult.loading())
     |> start_async(:report, fn ->
       Process.sleep(@simulated_work_ms)
       Reports.activity_report(scope)
     end)}
  end

  @impl true
  def handle_async(:report, {:ok, report}, socket) do
    {:noreply, assign(socket, :report, AsyncResult.ok(socket.assigns.report, report))}
  end

  def handle_async(:report, {:exit, reason}, socket) do
    {:noreply, assign(socket, :report, AsyncResult.failed(socket.assigns.report, reason))}
  end
end
