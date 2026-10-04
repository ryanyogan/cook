// Longest-first ordering for a Playwright run, applied from a reporter's `preprocess` hook.
// Plain CommonJS so any Playwright version can load it from outside the target project.
//
// Playwright (read in 1.63) builds its work queue from the suite tree: for each project, for each
// file, the tests in declaration order, cut into groups that a worker runs as a unit. This module
// only permutes siblings whose groups Playwright already treats as independent of each other:
//   - the files of a project, and
//   - the children of a suite in parallel mode that is not inside a serial/default-mode suite and
//     has no beforeAll/afterAll hook on its path (every test there is a group of its own).
// It never moves anything between suites, files or projects, and never changes the order of tests
// that run one after another in the same worker. Names, test ids and snapshot paths come from the
// file, the titles and the project, none of which are touched.
const path = require("node:path")

const isAllHook = (hook) => hook && (hook.type === "beforeAll" || hook.type === "afterAll")

/** Cook's test id, the same string `Report.ts` builds from the JSON report. */
const testId = (file, titles, project) => [file, ...titles].join(" › ") + (project ? ` [${project}]` : "")

/** Children of a suite, or null when this Playwright does not keep them the way 1.63 does. */
const entriesOf = (suite) => {
  const entries = suite._entries
  if (!Array.isArray(entries)) return null
  if (typeof suite._parallelMode !== "string" || !Array.isArray(suite._hooks)) return null
  if (!Array.isArray(suite.suites) || !Array.isArray(suite.tests)) return null
  if (entries.length !== suite.suites.length + suite.tests.length) return null
  const members = new Set([...suite.suites, ...suite.tests])
  return entries.every((entry) => members.has(entry)) ? entries : null
}

const isSuite = (entry) => Array.isArray(entry.suites) && Array.isArray(entry.tests)

/** Names of projects other projects depend on or tear down with: they are left exactly as they are. */
const supportProjects = (config) => {
  const names = new Set()
  for (const project of config.projects ?? []) {
    for (const name of project.dependencies ?? []) names.add(name)
    if (project.teardown) names.add(project.teardown)
  }
  return names
}

const stableByWeightDesc = (items) =>
  items.map((item, index) => ({ ...item, index })).sort((a, b) => b.weight - a.weight || a.index - b.index)

/**
 * Reorders `rootSuite` in place so that the slowest work is queued first.
 * `durations`: recorded milliseconds by Cook test id. Returns what was done, for the run's record.
 */
const applyOrder = (config, rootSuite, durations) => {
  const result = { applied: false, reason: null, estimated: 0, unknown: 0, moved: 0 }
  const skip = (reason) => ({ ...result, reason })
  const known = durations instanceof Map ? durations : new Map(Object.entries(durations ?? {}))
  if (known.size === 0) return skip("no recorded durations for this project yet")
  // With one worker the queue order is the order tests run in, and Playwright documents that files
  // then run alphabetically, so a project may rely on it.
  if (config.workers === 1) return skip("one worker: tests run in file order, which a project may rely on")
  const configDir = config.configFile ? path.dirname(config.configFile) : config.rootDir
  if (!configDir) return skip("the config has no directory to resolve test files against")

  // Pass 1: read only. Check the whole tree has the expected shape and collect the estimates.
  const support = supportProjects(config)
  const plans = []
  let largest = 0
  for (const projectSuite of rootSuite.suites ?? []) {
    const name = projectSuite.title ?? ""
    if (support.has(name)) continue
    const files = entriesOf(projectSuite)
    if (files === null || !files.every(isSuite))
      return skip("this Playwright version keeps its suites differently")
    const plan = { suite: projectSuite, name, nodes: [] }
    const walk = (suite, titles, file) => {
      const entries = entriesOf(suite)
      if (entries === null) return false
      plan.nodes.push({ suite, titles, file })
      for (const entry of entries) {
        if (isSuite(entry)) {
          if (!walk(entry, [...titles, entry.title ?? ""], file)) return false
        } else {
          const ms = known.get(testId(file, [...titles, entry.title ?? ""], name))
          if (typeof ms === "number") {
            result.estimated += 1
            largest = Math.max(largest, ms)
          } else result.unknown += 1
        }
      }
      return true
    }
    for (const fileSuite of files) {
      const location = fileSuite.location?.file
      if (typeof location !== "string") return skip("this Playwright version keeps its suites differently")
      const file = path.relative(configDir, location).split(path.sep).join("/")
      if (!walk(fileSuite, [], file)) return skip("this Playwright version keeps its suites differently")
    }
    plans.push(plan)
  }
  if (result.estimated === 0) return skip("no recorded durations for the selected tests")

  // A test never seen before may be the slowest one. Starting it early costs nothing if it is
  // quick; starting it last costs its whole duration with every other worker idle. So it is
  // assumed to be as slow as the slowest test known, and keeps its place among equals.
  const estimate = (file, titles, project) => known.get(testId(file, titles, project)) ?? largest

  // Pass 2: weigh and reorder. `chain` is time that runs in one worker together with the enclosing
  // group; `alone` is the largest group below that runs by itself.
  const reorder = (suite, entries, weights) => {
    const sorted = stableByWeightDesc(entries.map((entry, i) => ({ entry, weight: weights[i] })))
    sorted.forEach((item, position) => {
      if (item.index !== position) result.moved += 1
      entries[position] = item.entry
    })
    void suite
  }
  const weigh = (suite, context, titles, file, project) => {
    const mode = suite._parallelMode
    const parallel = context.parallel || mode === "parallel"
    const sequentialHere = mode === "serial" || mode === "default"
    const sequential = context.sequential || sequentialHere
    const hooks = context.hooks || suite._hooks.some(isAllHook)
    const free = parallel && !sequential && !hooks
    const entries = suite._entries
    let chain = 0
    let alone = 0
    const weights = entries.map((entry) => {
      if (isSuite(entry)) {
        const below = weigh(
          entry,
          { parallel, sequential, hooks },
          [...titles, entry.title ?? ""],
          file,
          project,
        )
        chain += below.chain
        alone = Math.max(alone, below.alone)
        return Math.max(below.chain, below.alone)
      }
      const ms = estimate(file, [...titles, entry.title ?? ""], project)
      if (free) alone = Math.max(alone, ms)
      else chain += ms
      return ms
    })
    if (free) reorder(suite, entries, weights)
    // The outermost serial/default suite inside a parallel one is one group of its own.
    if (parallel && sequentialHere && !context.sequential) return { chain: 0, alone: Math.max(chain, alone) }
    return { chain, alone }
  }
  for (const plan of plans) {
    const files = plan.suite._entries
    const top = { parallel: plan.suite._parallelMode === "parallel", sequential: false, hooks: false }
    const weights = files.map((fileSuite) => {
      const file = path.relative(configDir, fileSuite.location.file).split(path.sep).join("/")
      const weight = weigh(fileSuite, top, [], file, plan.name)
      return Math.max(weight.chain, weight.alone)
    })
    reorder(plan.suite, files, weights)
  }
  return { ...result, applied: true }
}

module.exports = { applyOrder, testId }
