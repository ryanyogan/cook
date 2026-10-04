import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { buildReportFn } from '../../lib/fns'
import { PRIORITIES, type Report } from '../../lib/types'

export const Route = createFileRoute('/_authed/reports')({ component: Reports })

function Reports() {
  const [report, setReport] = useState<Report | null>(null)
  const [pending, setPending] = useState(false)

  async function build() {
    setPending(true)
    setReport(await buildReportFn())
    setPending(false)
  }

  return (
    <>
      <h1>Reports</h1>
      <button type="button" onClick={build} disabled={pending}>
        Build report
      </button>
      {pending && <p role="status">Building report…</p>}
      {report && !pending && (
        <table aria-label="Task report">
          <tbody>
            <tr>
              <th scope="row">Total</th>
              <td data-testid="report-total">{report.total}</td>
            </tr>
            <tr>
              <th scope="row">Open</th>
              <td data-testid="report-open">{report.open}</td>
            </tr>
            <tr>
              <th scope="row">Done</th>
              <td data-testid="report-done">{report.done}</td>
            </tr>
            {PRIORITIES.map((p) => (
              <tr key={p}>
                <th scope="row">Priority {p}</th>
                <td data-testid={`report-${p}`}>{report.byPriority[p]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
