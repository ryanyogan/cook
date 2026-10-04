import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { cookHome } from "./os.ts"
import { openStore, type Store } from "./Store.ts"

export type { Store } from "./Store.ts"

/** The SQLite store at `$COOK_HOME/cook.sqlite`, closed with the scope. */
export class StoreService extends Context.Service<StoreService, Store>()("cook/Store") {
  static readonly layer = Layer.effect(
    StoreService,
    Effect.acquireRelease(
      Effect.sync(() => openStore(join(cookHome(), "cook.sqlite"))),
      (store) => Effect.sync(() => store.close()),
    ),
  )
}
