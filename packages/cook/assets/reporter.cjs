// Playwright reporter that records when the run began, when the first test started and when the
// run ended, as epoch milliseconds, in the JSON file named by COOK_EVENTS_FILE. Plain CommonJS so
// any Playwright version can load it from outside the target project. It prints nothing.
const fs = require("node:fs")

class CookTimingReporter {
  constructor() {
    this.file = process.env.COOK_EVENTS_FILE
    this.events = { beginAt: null, firstTestAt: null, endAt: null, tests: null, workers: null }
  }
  write() {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.events))
  }
  printsToStdio() {
    return false
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
