// Playwright reporter that records when the run began, when the first test started and when the
// run ended, as epoch milliseconds, in the JSON file named by COOK_EVENTS_FILE. Plain CommonJS so
// any Playwright version can load it from outside the target project. It prints nothing.
//
// When COOK_ORDER_FILE names a JSON file of recorded durations ({ "<test id>": ms }), the
// `preprocess` hook (Playwright calls it before it cuts the suite into worker groups) puts the
// slowest work first; see order.cjs. A Playwright without that hook never calls it, and the run
// is then in the project's own order.
const fs = require("node:fs")
const { applyOrder } = require("./order.cjs")

class CookTimingReporter {
  constructor() {
    this.file = process.env.COOK_EVENTS_FILE
    this.events = { beginAt: null, firstTestAt: null, endAt: null, tests: null, workers: null, order: null }
  }
  write() {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.events))
  }
  printsToStdio() {
    return false
  }
  async preprocess({ config, suite }) {
    const file = process.env.COOK_ORDER_FILE
    if (!file) return
    try {
      this.events.order = applyOrder(config, suite, JSON.parse(fs.readFileSync(file, "utf8")))
    } catch (error) {
      // Ordering is an optimisation: a failure here must never fail the project's run.
      this.events.order = {
        applied: false,
        reason: `ordering failed: ${error?.message ?? error}`,
        estimated: 0,
        unknown: 0,
        moved: 0,
      }
    }
    this.write()
  }
  onBegin(config, suite) {
    this.events.beginAt = Date.now()
    this.events.tests = suite.allTests().length
    this.events.workers = config.workers
    this.write()
  }
  onTestBegin() {
    if (this.events.firstTestAt !== null) return
    this.events.firstTestAt = Date.now()
    this.write()
  }
  onEnd() {
    this.events.endAt = Date.now()
    this.write()
  }
}

module.exports = CookTimingReporter
