import { type Svc, isTagInstance, isTagClass, tagKey } from "./context.ts";
import type { Tag } from "./context.ts";

type Deps = Record<string, unknown>;
type Yielded<T, E> = EffectType<T, E> | Tag<any, T>;

export type Effect<A, E = Error, R extends Record<string, unknown> = never> = EffectType<A, E, R>;

const scopeKey = "codewarper.scope";

type Scope = { finalizers: (() => Promise<void>)[] };

class EffectType<A, E = Error, R extends Record<string, unknown> = never> {
  readonly disc = "Effect" as const;
  readonly _run: (deps: Deps) => Promise<A>;
  constructor(_run: (deps: Deps) => Promise<A>) { this._run = _run; }

  [Symbol.iterator](): Iterator<Yielded<A, E>> {
    let done = false;
    return { next: (value?: unknown): IteratorResult<Yielded<A, E>> => {
      if (done) return { done: true, value: value as A };
      done = true;
      return { done: false, value: this };
    }};
  }

  pipe<T1>(f1: (self: this) => T1): T1;
  pipe<T1, T2>(f1: (self: this) => T1, f2: (self: T1) => T2): T2;
  pipe<T1, T2, T3>(f1: (self: this) => T1, f2: (self: T1) => T2, f3: (self: T2) => T3): T3;
  pipe(...fs: any[]): any { let r: any = this; for (const f of fs) r = f(r); return r; }

  static succeed<A>(value: A): Effect<A, never, never> { return new EffectType(() => Promise.resolve(value)); }
  static fail<E>(error: E): Effect<never, E, never> { return new EffectType(() => Promise.reject(error)); }
  static sync<A>(thunk: () => A): Effect<A, never, never> {
    return new EffectType(() => { try { return Promise.resolve(thunk()); } catch (e) { return Promise.reject(e); } });
  }
  static try<A>(opts: { try: () => A; catch: (e: unknown) => Error }): Effect<A, Error, never> {
    return new EffectType(() => { try { return Promise.resolve(opts.try()); } catch (e) { return Promise.reject(opts.catch(e)); } });
  }
  static tryPromise<A>(opts: { try: () => Promise<A>; catch: (e: unknown) => Error }): Effect<A, Error, never> {
    return new EffectType(async () => { try { return await opts.try(); } catch (e) { throw opts.catch(e); } });
  }
  static promise<A>(thunk: () => Promise<A>): Effect<A, Error, never> {
    return EffectType.tryPromise({ try: thunk, catch: (e) => e instanceof Error ? e : new Error(String(e)) });
  }
  static all(effects: readonly Effect<any, any, any>[]): Effect<any[], Error, never> {
    return new EffectType(async (deps) => Promise.all(effects.map((e) => e._run(deps))));
  }

  static map<A, B>(f: (a: A) => B): (effect: Effect<A, any, any>) => Effect<B, any, any>;
  static map<A, B>(effect: Effect<A, any, any>, f: (a: A) => B): Effect<B, any, any>;
  static map<C extends (new () => Tag<any, any, any>) | Tag<any, any, any>, B>(src: C, f: (a: Svc<C>) => B): Effect<B, never, any>;
  static map(a: any, b?: any): any {
    if (b === undefined && typeof a === "function") { const f = a; return (e: Effect<any, any, any>) => new EffectType(async (d) => f(await e._run(d))); }
    if (isTagInstance(a) || isTagClass(a)) { const k = tagKey(a); return new EffectType(async (d) => { const s = d[k]; if (!s) throw new Error(`Service "${k}" not provided.`); return b(s); }); }
    return new EffectType(async (d) => b(await a._run(d)));
  }

  static tap<A, E, R extends Record<string, unknown>>(f: (a: A) => Effect<any, any, any>): (effect: Effect<A, E, R>) => Effect<A, E, R>;
  static tap<A, E, R extends Record<string, unknown>>(effect: Effect<A, E, R>, f: (a: A) => Effect<any, any, any>): Effect<A, E, R>;
  static tap(a: any, b?: any): any {
    if (b === undefined) { const f = a; return (e: Effect<any, any, any>) => new EffectType(async (d) => { const v = await e._run(d); await f(v)._run(d); return v; }); }
    return new EffectType(async (d) => { const v = await a._run(d); await b(v)._run(d); return v; });
  }

  static catchAll<E2>(fn: (e: unknown) => Effect<any, E2, any>): (effect: Effect<any, any, any>) => Effect<any, E2, any>;
  static catchAll<A, E, E2>(effect: Effect<A, E, any>, fn: (e: unknown) => Effect<A, E2, any>): Effect<A, E2, any>;
  static catchAll(a: any, b?: any): any {
    if (b === undefined) { const h = a; return (e: Effect<any, any, any>) => new EffectType(async (d) => { try { return await e._run(d); } catch (x) { return h(x)._run(d); } }); }
    return new EffectType(async (d) => { try { return await a._run(d); } catch (x) { return b(x)._run(d); } });
  }

  static gen<A, E>(factory: () => Generator<Yielded<any, E>, A, any>): Effect<A, E, never> {
    return new EffectType(async (d) => {
      const it = factory();
      async function step(last: unknown): Promise<A> {
        const r = it.next(last);
        if (r.done) return r.value as A;
        const y = r.value;
        if (typeof y === "object" && y !== null && "disc" in y) {
          if (y.disc === "Effect") return step(await y._run(d));
          if (y.disc === "TagInstance") {
            const svc = d[y.key];
            if (svc === undefined) throw new Error(`Service "${y.key}" not provided.`);
            return step(svc);
          }
        }
        throw new Error("Unexpected value yielded in Effect.gen");
      }
      return step(undefined);
    });
  }

  static either<A, E, R extends Record<string, unknown>>(effect: Effect<A, E, R>): Effect<{ _tag: "Right"; right: A } | { _tag: "Left"; left: E }, never, R> {
    return new EffectType(async (d) => { try { return { _tag: "Right" as const, right: await effect._run(d) }; } catch (e) { return { _tag: "Left" as const, left: e as E }; } });
  }

  static scoped<A, E>(effect: Effect<A, E, any>): Effect<A, E, any> {
    return new EffectType(async (d) => {
      const scope: Scope = { finalizers: [] };
      const scopedDeps = { ...d, [scopeKey]: scope };
      try {
        return await effect._run(scopedDeps);
      } finally {
        for (const f of scope.finalizers.reverse()) {
          try { await f(); } catch {}
        }
      }
    });
  }

  static acquireRelease<A>(acq: Effect<A, Error, any>, rel: (a: A) => Effect<void, never, any>): Effect<A, Error, any> {
    return EffectType.acquireUseRelease(acq, (a) => Effect.succeed(a), rel);
  }

  static acquireUseRelease<A, B>(acq: Effect<A, Error, any>, use: (a: A) => Effect<B, Error, any>, rel: (a: A) => Effect<void, never, any>): Effect<B, Error, any> {
    return new EffectType(async (d) => {
      const a = await acq._run(d);
      const scope = d[scopeKey] as Scope | undefined;
      if (scope) {
        scope.finalizers.push(() => rel(a)._run(d).catch(() => {}));
        return use(a)._run(d);
      }
      try { return await use(a)._run(d); }
      finally { await rel(a)._run(d); }
    });
  }

  static provide<A, E, R extends Record<string, unknown>>(
    effect: Effect<A, E, R>,
    layer: Layer,
  ): Effect<A, E, any> {
    return new EffectType(async () => { const deps = await buildDeps(layer, {}); return effect._run(deps); });
  }

  static runPromise<A>(effect: Effect<A, Error, never>): Promise<A> { return effect._run({}); }

  static iterate<S, A, E>(initial: S, opts: { while: (s: S) => boolean; body: (s: S) => Effect<S, E, any> }): Effect<S, E, never> {
    return new EffectType(async (d) => { let s = initial; while (opts.while(s)) s = await opts.body(s)._run(d); return s; });
  }
}

const Effect = EffectType as typeof EffectType;
export { Effect };

// -- Layer ---------------------------------------------------------------

export type Layer<A = {}, E = never, R extends Record<string, unknown> = {}> = LeafLayer<A, E, R> | MergedLayer | ProvidedLayer;

type LayerBuild<A, E> = (deps: Deps) => Effect<A, E>;

class LeafLayer<A = {}, E = never, R extends Record<string, unknown> = {}> {
  readonly disc = "Leaf" as const;
  readonly key: string;
  readonly _build: LayerBuild<A, E>;
  constructor(key: string, _build: LayerBuild<A, E>) { this.key = key; this._build = _build; }
  pipe<T1>(f1: (self: Layer) => T1): T1;
  pipe<T1, T2>(f1: (self: Layer) => T1, f2: (self: T1) => T2): T2;
  pipe(...fs: any[]): any { let r: any = this; for (const f of fs) r = f(r); return r; }
}

class MergedLayer {
  readonly disc = "Merged" as const;
  readonly layers: readonly Layer[];
  constructor(layers: readonly Layer[]) { this.layers = layers; }
  pipe<T1>(f1: (self: Layer) => T1): T1;
  pipe<T1, T2>(f1: (self: Layer) => T1, f2: (self: T1) => T2): T2;
  pipe(...fs: any[]): any { let r: any = this; for (const f of fs) r = f(r); return r; }
}

class ProvidedLayer {
  readonly disc = "Provided" as const;
  readonly dependency: Layer;
  readonly inner: Layer;
  constructor(dependency: Layer, inner: Layer) { this.dependency = dependency; this.inner = inner; }
  pipe<T1>(f1: (self: Layer) => T1): T1;
  pipe<T1, T2>(f1: (self: Layer) => T1, f2: (self: T1) => T2): T2;
  pipe(...fs: any[]): any { let r: any = this; for (const f of fs) r = f(r); return r; }
}

function succeedLayer<C extends new () => Tag<any, any, any>>(tagClass: C, value: Svc<C>): Layer {
  return new LeafLayer(tagKey(tagClass), () => Effect.succeed(value));
}
function syncLayer<C extends new () => Tag<any, any, any>>(tagClass: C, factory: () => Svc<C>): Layer {
  return new LeafLayer(tagKey(tagClass), () => Effect.sync(factory));
}
function effectLayer<C extends new () => Tag<any, any, any>>(tagClass: C, effect: Effect<any, any, any>): Layer {
  return new LeafLayer(tagKey(tagClass), () => effect);
}
function mergeAllLayers(...layers: Layer[]): MergedLayer { return new MergedLayer(layers); }
function provideLayer(dep: Layer): (self: Layer) => Layer { return (self) => new ProvidedLayer(dep, self); }

const Layer = {
  succeed: succeedLayer,
  sync: syncLayer,
  effect: effectLayer,
  mergeAll: mergeAllLayers,
  provide: provideLayer,
};

export { Layer };

async function buildDeps(layer: Layer, parentDeps: Deps): Promise<Deps> {
  const deps = { ...parentDeps };
  if (layer.disc === "Merged") { for (const inner of layer.layers) Object.assign(deps, await buildDeps(inner, deps)); return deps; }
  if (layer.disc === "Provided") { Object.assign(deps, await buildDeps(layer.dependency, deps)); return buildDeps(layer.inner, deps); }
  deps[layer.key] = await layer._build(deps)._run(deps);
  return deps;
}
