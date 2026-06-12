import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Layer } from "./index.ts";
import { Context } from "./context.ts";

// Test services
class TestService extends Context.Tag("test/TestService")<TestService, { value: string }>() {}
class AnotherService extends Context.Tag("test/AnotherService")<AnotherService, { count: number }>() {}

const TestServiceLive = Layer.succeed(TestService, { value: "hello" });
const AnotherServiceLive = Layer.succeed(AnotherService, { count: 42 });
const AllLive = Layer.mergeAll(TestServiceLive, AnotherServiceLive);

describe("Effect.succeed / runPromise", () => {
  it("resolves to the value", async () => {
    const result = await Effect.runPromise(Effect.succeed(42));
    assert.equal(result, 42);
  });
});

describe("Effect.fail", () => {
  it("rejects via runPromise", async () => {
    await assert.rejects(
      Effect.runPromise(Effect.fail(new Error("boom"))),
      /boom/,
    );
  });
});

describe("Effect.sync", () => {
  it("wraps a sync computation", async () => {
    const result = await Effect.runPromise(Effect.sync(() => 7));
    assert.equal(result, 7);
  });

  it("catches thrown errors", async () => {
    await assert.rejects(
      Effect.runPromise(
        Effect.sync(() => {
          throw new Error("sync boom");
        }),
      ),
      /sync boom/,
    );
  });
});

describe("Effect.try", () => {
  it("wraps a throwing computation", async () => {
    const result = await Effect.runPromise(
      Effect.try({ try: () => "ok", catch: () => new Error("nope") }),
    );
    assert.equal(result, "ok");
  });

  it("catches and wraps the error", async () => {
    await assert.rejects(
      Effect.runPromise(
        Effect.try({
          try: () => { throw "raw"; },
          catch: (e) => new Error(String(e)),
        }),
      ),
      /raw/,
    );
  });
});

describe("Effect.tryPromise", () => {
  it("resolves", async () => {
    const e = Effect.tryPromise({ try: async () => 99, catch: () => new Error("nope") });
    assert.equal(await Effect.runPromise(e), 99);
  });

  it("catches rejections", async () => {
    await assert.rejects(
      Effect.runPromise(
        Effect.tryPromise({
          try: async () => { throw new Error("async fail"); },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),
      ),
      /async fail/,
    );
  });
});

describe("Effect.map", () => {
  it("maps the success value", async () => {
    const e = Effect.map(Effect.succeed(3), (x) => x * 2);
    assert.equal(await Effect.runPromise(e), 6);
  });

  it("curried form", async () => {
    const e = Effect.succeed(3).pipe(Effect.map((x: number) => x * 3));
    assert.equal(await Effect.runPromise(e), 9);
  });

  it("extracts a service from a Tag class", async () => {
    const e = Effect.map(TestService, (svc) => svc.value.toUpperCase());
    const program = Effect.provide(e, TestServiceLive);
    assert.equal(await Effect.runPromise(program), "HELLO");
  });
});

describe("Effect.tap", () => {
  it("runs side effect, returns original value", async () => {
    let side = "";
    const e = Effect.tap(Effect.succeed("a"), (v) =>
      Effect.sync(() => { side = v; }),
    );
    const result = await Effect.runPromise(e);
    assert.equal(result, "a");
    assert.equal(side, "a");
  });

  it("curried form", async () => {
    let side = "";
    const e = Effect.succeed("x").pipe(
      Effect.tap((v: string) => Effect.sync(() => { side = v; })),
    );
    const result = await Effect.runPromise(e);
    assert.equal(result, "x");
    assert.equal(side, "x");
  });
});

describe("Effect.either", () => {
  it("returns Right on success", async () => {
    const e = Effect.either(Effect.succeed("win"));
    const result = await Effect.runPromise(e);
    assert.deepEqual(result, { _tag: "Right", right: "win" });
  });

  it("returns Left on failure", async () => {
    const e = Effect.either(Effect.fail("lose"));
    const result = await Effect.runPromise(e);
    assert.deepEqual(result, { _tag: "Left", left: "lose" });
  });
});

describe("Effect.gen", () => {
  it("runs a generator effect", async () => {
    const program = Effect.gen(function* (): Generator<any, number, any> {
      const a = yield* Effect.succeed(1);
      const b = yield* Effect.succeed(2);
      return a + b;
    });
    assert.equal(await Effect.runPromise(program), 3);
  });

  it("accesses services via yield*", async () => {
    const program = Effect.gen(function* (): Generator<any, string, any> {
      const svc = yield* TestService;
      return svc.value;
    });
    const provided = Effect.provide(program, TestServiceLive);
    assert.equal(await Effect.runPromise(provided), "hello");
  });

  it("propagates failures", async () => {
    const program = Effect.gen(function* (): Generator<any, number, any> {
      const a = yield* Effect.succeed(1);
      yield* Effect.fail(new Error("gen fail"));
      return a;
    });
    await assert.rejects(Effect.runPromise(program), /gen fail/);
  });

  it("handles either inside gen", async () => {
    const program = Effect.gen(function* (): Generator<any, string, any> {
      const result = yield* Effect.either(Effect.fail("oops"));
      if (result._tag === "Left") return `caught: ${result.left}`;
      return result.right;
    });
    assert.equal(await Effect.runPromise(program), "caught: oops");
  });
});

describe("Effect.catchAll", () => {
  it("catches errors", async () => {
    const e = Effect.catchAll(
      Effect.fail("boom"),
      (e: unknown) => Effect.succeed(`recovered: ${e}`),
    );
    assert.equal(await Effect.runPromise(e), "recovered: boom");
  });

  it("curried form", async () => {
    const e = Effect.fail("crash").pipe(
      Effect.catchAll((e: unknown) => Effect.succeed(`safe: ${e}`)),
    );
    assert.equal(await Effect.runPromise(e), "safe: crash");
  });
});

describe("Effect.acquireUseRelease", () => {
  it("acquires, uses, and releases", async () => {
    let released = false;
    const program = Effect.acquireUseRelease(
      Effect.succeed("resource"),
      (r) => Effect.succeed(`used ${r}`),
      () => Effect.sync(() => { released = true; }),
    );
    const result = await Effect.runPromise(program);
    assert.equal(result, "used resource");
    assert.equal(released, true);
  });
});

describe("Effect.all", () => {
  it("runs effects in parallel", async () => {
    const results = await Effect.runPromise(
      Effect.all([Effect.succeed(1), Effect.succeed(2), Effect.succeed(3)]),
    );
    assert.deepEqual(results, [1, 2, 3]);
  });
});

describe("Effect.provide / Layer", () => {
  it("provides a single service", async () => {
    const program = Effect.gen(function* (): Generator<any, string, any> {
      const svc = yield* TestService;
      return svc.value;
    });
    const result = await Effect.runPromise(Effect.provide(program, TestServiceLive));
    assert.equal(result, "hello");
  });

  it("provides merged layers", async () => {
    const program = Effect.gen(function* (): Generator<any, string, any> {
      const a = yield* TestService;
      const b = yield* AnotherService;
      return `${a.value}-${b.count}`;
    });
    const result = await Effect.runPromise(Effect.provide(program, AllLive));
    assert.equal(result, "hello-42");
  });

  it("Layer.provide resolves dependencies", async () => {
    class DerivedService extends Context.Tag("test/Derived")<DerivedService, { combined: string }>() {}
    const DerivedLive = Layer.effect(
      DerivedService,
      Effect.gen(function* (): Generator<any, { combined: string }, any> {
        const t = yield* TestService;
        const a = yield* AnotherService;
        return { combined: `${t.value}-${a.count}` };
      }),
    ).pipe(Layer.provide(AllLive));

    const program = Effect.gen(function* (): Generator<any, string, any> {
      const d = yield* DerivedService;
      return d.combined;
    });
    const result = await Effect.runPromise(Effect.provide(program, DerivedLive));
    assert.equal(result, "hello-42");
  });
});

describe("Effect.iterate", () => {
  it("iterates until condition is false", async () => {
    const result = await Effect.runPromise(
      Effect.iterate({ value: 0 }, {
        while: (s) => s.value < 3,
        body: (s) => Effect.succeed({ value: s.value + 1 }),
      }),
    );
    assert.deepEqual(result, { value: 3 });
  });
});
