import { createRequire } from "node:module"
import { expect, test } from "vitest"

const require = createRequire(import.meta.url)
const { applyOrder } = require("../assets/order.cjs") as {
  applyOrder: (
    config: unknown,
    root: unknown,
    durations: Record<string, number>,
  ) => { applied: boolean; reason: string | null; estimated: number; unknown: number; moved: number }
}

// Stand-ins for Playwright's Suite and TestCase, with the fields 1.63 has.
interface Node {
  title: string
  _entries?: Array<Node>
  _parallelMode?: string
  _hooks?: Array<{ type: string }>
  location?: { file: string }
  suites?: Array<Node>
  tests?: Array<Node>
}
const t = (title: string): Node => ({ title })
const suite = (
  title: string,
  entries: Array<Node>,
  over: { mode?: string; hooks?: Array<string>; file?: string } = {},
): Node => {
  const node: Node = {
    title,
    _entries: entries,
    _parallelMode: over.mode ?? "none",
    _hooks: (over.hooks ?? []).map((type) => ({ type })),
    ...(over.file !== undefined ? { location: { file: `/app/${over.file}` } } : {}),
  }
  Object.defineProperty(node, "suites", {
    configurable: true,
    get: () => (node._entries ?? []).filter((e) => e._entries),
  })
  Object.defineProperty(node, "tests", {
    configurable: true,
    get: () => (node._entries ?? []).filter((e) => !e._entries),
  })
  return node
}
const file = (name: string, entries: Array<Node>, over: { mode?: string; hooks?: Array<string> } = {}) =>
  suite(name, entries, { ...over, file: name })
const config = (over: Record<string, unknown> = {}) => ({
  configFile: "/app/.cook-playwright.config.mjs",
  rootDir: "/app/e2e",
  workers: 4,
  projects: [
    { name: "chromium", dependencies: ["setup"] },
    { name: "setup", dependencies: [] },
  ],
  ...over,
})
const shape = (node: Node): unknown =>
  node._entries ? { [node.title]: node._entries.map(shape) } : node.title

const tree = () =>
  suite("", [
    suite("setup", [file("e2e/z.setup.ts", [t("sign in")]), file("e2e/a.setup.ts", [t("seed")])]),
    suite(
      "chromium",
      [
        file("e2e/a.spec.ts", [t("quick"), t("medium")]),
        file("e2e/b.spec.ts", [t("new"), suite("group", [t("inner quick"), t("slow")])]),
        file("e2e/c.spec.ts", [t("first"), t("second")], { mode: "serial" }),
        file("e2e/d.spec.ts", [t("with hook 1"), t("with hook 2")], { hooks: ["beforeAll"] }),
      ],
      { mode: "parallel" },
    ),
  ])
const durations = {
  "e2e/a.spec.ts › quick [chromium]": 100,
  "e2e/a.spec.ts › medium [chromium]": 900,
  "e2e/b.spec.ts › group › inner quick [chromium]": 200,
  "e2e/b.spec.ts › group › slow [chromium]": 4000,
  "e2e/c.spec.ts › first [chromium]": 300,
  "e2e/c.spec.ts › second [chromium]": 800,
  "e2e/d.spec.ts › with hook 1 [chromium]": 50,
  "e2e/d.spec.ts › with hook 2 [chromium]": 5000,
  "e2e/a.setup.ts › seed [setup]": 9000,
}

test("slowest first among independent groups; unknown tests count as the slowest; chains keep their order", () => {
  const root = tree()
  const outcome = applyOrder(config(), root, durations)
  expect(outcome).toMatchObject({ applied: true, reason: null, estimated: 8, unknown: 1 })
  expect(outcome.moved).toBeGreaterThan(0)
  expect(shape(root)).toEqual({
    "": [
      // A project others depend on is left exactly as it was.
      { setup: [{ "e2e/z.setup.ts": ["sign in"] }, { "e2e/a.setup.ts": ["seed"] }] },
      {
        chromium: [
          // 5050 ms in one worker (beforeAll: not reordered inside), then the file whose slowest
          // single test is 5000 (the unknown one, assumed as slow as the slowest known), ...
          { "e2e/d.spec.ts": ["with hook 1", "with hook 2"] },
          { "e2e/b.spec.ts": ["new", { group: ["slow", "inner quick"] }] },
          // ... a serial file is one group of 1100 ms and keeps its order, ...
          { "e2e/c.spec.ts": ["first", "second"] },
          { "e2e/a.spec.ts": ["medium", "quick"] },
        ],
      },
    ],
  })
})

test("a project that is not fully parallel: files move, tests inside a file do not", () => {
  const root = suite("", [
    suite("", [
      file("a.spec.ts", [t("quick"), t("medium")]),
      file("b.spec.ts", [t("x"), suite("par", [t("p1"), t("p2")], { mode: "parallel" })]),
    ]),
  ])
  const outcome = applyOrder(
    config({ projects: [{ name: "" }], configFile: "/app/playwright.config.ts" }),
    root,
    {
      "a.spec.ts › quick": 10,
      "a.spec.ts › medium": 20,
      "b.spec.ts › x": 5,
      "b.spec.ts › par › p1": 40,
      "b.spec.ts › par › p2": 400,
    },
  )
  expect(outcome.applied).toBe(true)
  expect(shape(root)).toEqual({
    "": [{ "": [{ "b.spec.ts": ["x", { par: ["p2", "p1"] }] }, { "a.spec.ts": ["quick", "medium"] }] }],
  })
})

test("nothing is touched: one worker, no durations, none for the selected tests, an unknown tree shape", () => {
  const before = JSON.stringify(shape(tree()))
  const untouched = (cfg: unknown, root: Node, known: Record<string, number>) => {
    const outcome = applyOrder(cfg, root, known)
    expect(outcome.applied).toBe(false)
    expect(outcome.moved).toBe(0)
    expect(JSON.stringify(shape(root))).toBe(before)
    return outcome.reason
  }
  expect(untouched(config({ workers: 1 }), tree(), durations)).toMatch(/one worker/)
  expect(untouched(config(), tree(), {})).toMatch(/no recorded durations/)
  expect(untouched(config(), tree(), { "other.spec.ts › x [chromium]": 5 })).toMatch(/selected tests/)
  // A Playwright that keeps children elsewhere: `_entries` does not match suites + tests.
  const odd = tree()
  const chromium = odd._entries?.[1] as Node
  const fileB = chromium._entries?.[1] as Node
  Object.defineProperty(fileB, "tests", { get: () => [] })
  expect(untouched(config(), odd, durations)).toMatch(/keeps its suites differently/)
  const noMode = tree()
  const second = noMode._entries?.[1] as Node
  delete second._parallelMode
  expect(untouched(config(), noMode, durations)).toMatch(/keeps its suites differently/)
})

test("the same tests remain, each once, under the same parents", () => {
  const root = tree()
  const flat = (node: Node, path: string): Array<string> =>
    node._entries ? node._entries.flatMap((e) => flat(e, `${path}/${node.title}`)) : [`${path}/${node.title}`]
  const before = flat(root, "").sort()
  applyOrder(config(), root, durations)
  expect(flat(root, "").sort()).toEqual(before)
})
