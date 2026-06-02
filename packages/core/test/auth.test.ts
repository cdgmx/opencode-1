import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { Auth } from "@opencode-ai/core/auth"
import { EventV2 } from "@opencode-ai/core/event"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const withAuth = <A, E>(dir: string, effect: Effect.Effect<A, E, Auth.Service>) =>
  effect.pipe(
    Effect.provide(Auth.layer),
    Effect.provide(EventV2.defaultLayer),
    Effect.provide(AppFileSystem.defaultLayer),
    Effect.provide(Global.layerWith({ data: dir })),
  )

describe("Auth", () => {
  it.live("stores api credentials", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      const account = yield* withAuth(
        tmp.path,
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          return yield* auth.create({
            serviceID: Auth.ServiceID.make("anthropic"),
            credential: new Auth.ApiKeyCredential({ type: "api", key: "sk-test" }),
          })
        }),
      )
      if (!account) return yield* Effect.die("expected created account")

      const active = yield* withAuth(
        tmp.path,
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          return yield* auth.active(Auth.ServiceID.make("anthropic"))
        }),
      )

      expect(active?.id).toBe(account.id)
      expect(active?.credential).toEqual({ type: "api", key: "sk-test" })
    }),
  )
})
