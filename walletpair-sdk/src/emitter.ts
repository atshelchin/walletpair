/**
 * Minimal typed event emitter — no external dependencies.
 */

type Handler<T> = (data: T) => void

export class Emitter<Events extends Record<string, unknown>> {
  // biome-ignore lint/suspicious/noExplicitAny: generic handler storage requires any
  private handlers = new Map<keyof Events, Set<Handler<any>>>()

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
    }
  }

  once<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    const off = this.on(event, (data) => {
      off()
      handler(data)
    })
    return off
  }

  emit<K extends keyof Events>(event: K, data: Events[K]): void {
    const set = this.handlers.get(event)
    if (set) for (const h of set) h(data)
  }

  off<K extends keyof Events>(event: K, handler?: Handler<Events[K]>): void {
    if (handler) {
      this.handlers.get(event)?.delete(handler)
    } else {
      this.handlers.delete(event)
    }
  }

  removeAll(): void {
    this.handlers.clear()
  }
}
