/**
 * Allocates monotonic non-zero handles for DAP entities (variables,
 * sources, frames, threads). Zero is reserved by the spec for
 * "no children", so we start at 1.
 *
 * The pool can be parameterized to namespace handles per-runtime if
 * needed; for v0.0 prototype a single pool is enough.
 */
export class HandlePool<T> {
  private next = 1;
  private readonly map = new Map<number, T>();

  create(value: T): number {
    const handle = this.next++;
    this.map.set(handle, value);
    return handle;
  }

  get(handle: number): T | undefined {
    return this.map.get(handle);
  }

  reset(): void {
    this.map.clear();
    this.next = 1;
  }
}
