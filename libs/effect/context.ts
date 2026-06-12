export interface Tag<I, S = I, K extends string = string> {
  readonly disc: "TagInstance";
  readonly key: K;
  readonly _tag: I;
  readonly _service: S;
}

export abstract class TagImpl<I = unknown, S = I, const Key extends string = string> implements Tag<I, S, Key> {
  readonly disc = "TagInstance" as const;
  readonly key: Key;
  readonly _tag!: I;
  readonly _service!: S;
  constructor(key: Key) { this.key = key; }

  [Symbol.iterator](): Iterator<Tag<I, S, Key>> {
    let done = false;
    const self: Tag<I, S, Key> = this;
    return {
      next: (value?: unknown): IteratorResult<Tag<I, S, Key>> => {
        if (done) return { done: true, value: value as Tag<I, S, Key> };
        done = true;
        return { done: false, value: self };
      },
    };
  }
}

const discTagClass = "TagClass";

function hasProp<K extends string>(v: unknown, key: K): v is { [P in K]: unknown } {
  return (typeof v === "object" && v !== null || typeof v === "function") && key in v;
}

export function isTagInstance(v: unknown): v is Tag<any, any> {
  return hasProp(v, "disc") && v.disc === "TagInstance";
}

export function isTagClass(v: unknown): v is (new () => Tag<any, any>) & { key: string } {
  return typeof v === "function" && hasProp(v, "disc") && v.disc === discTagClass;
}

export function tagKey(tag: Tag<any, any> | (new () => Tag<any, any>)): string {
  if (isTagInstance(tag)) return tag.key;
  if (isTagClass(tag)) return tag.key;
  throw new Error("Not a tag");
}

// -- Object-keyed R helpers -------------------------------------------------

/** Extract the service type from a tag instance or constructor. */
export type Svc<T> = T extends Tag<any, infer S, any> ? S : T extends new () => Tag<any, infer S, any> ? S : never;

/** Convert a single tag (instance or constructor) to its R entry. */
type _RE<T> = T extends Tag<any, infer S, infer K> ? { [P in K]: S }
  : T extends new () => Tag<any, infer S, infer K> ? { [P in K]: S }
  : never;

type _Intersect<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/** Convert a union of tag instances or constructors to an R object. */
export type Req<C extends (Tag<any, any, any> | (new () => Tag<any, any, any>))> = _Intersect<_RE<C>>;

function tagBuilder<K extends string>(key: K) {
  return <I, S = I>(): { new(): Tag<I, S, K>; readonly key: K; [Symbol.iterator](): Iterator<Tag<I, S, K>> } => {
    class cls extends TagImpl<I, S, K> {
      override readonly key: K = key;

      constructor() { super(key); }

      static readonly disc = discTagClass;
      static readonly key = key;

      static [Symbol.iterator](): Iterator<Tag<I, S, K>> {
        let done = false;
        const instance = new cls();
        return {
          next: (value?: unknown): IteratorResult<Tag<I, S, K>> => {
            if (done) return { done: true, value: value as Tag<I, S, K> };
            done = true;
            return { done: false, value: instance };
          },
        };
      }
    }
    return cls;
  };
}

export const Context = { Tag: tagBuilder };
export { tagBuilder as Tag };
