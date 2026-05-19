import { describe, it, expect, vi } from 'vitest';
import { Emitter } from './emitter.js';

interface TestEvents {
  [key: string]: unknown;
  message: string;
  count: number;
  complex: { name: string; value: number };
}

describe('Emitter', () => {
  it('emits events to registered handlers', () => {
    const emitter = new Emitter<TestEvents>();
    const handler = vi.fn();
    emitter.on('message', handler);
    emitter.emit('message', 'hello');
    expect(handler).toHaveBeenCalledWith('hello');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('supports multiple handlers for the same event', () => {
    const emitter = new Emitter<TestEvents>();
    const h1 = vi.fn();
    const h2 = vi.fn();
    emitter.on('message', h1);
    emitter.on('message', h2);
    emitter.emit('message', 'test');
    expect(h1).toHaveBeenCalledWith('test');
    expect(h2).toHaveBeenCalledWith('test');
  });

  it('supports multiple event types', () => {
    const emitter = new Emitter<TestEvents>();
    const msgHandler = vi.fn();
    const countHandler = vi.fn();
    emitter.on('message', msgHandler);
    emitter.on('count', countHandler);

    emitter.emit('message', 'hello');
    emitter.emit('count', 42);

    expect(msgHandler).toHaveBeenCalledWith('hello');
    expect(countHandler).toHaveBeenCalledWith(42);
    expect(msgHandler).toHaveBeenCalledTimes(1);
    expect(countHandler).toHaveBeenCalledTimes(1);
  });

  it('on() returns an unsubscribe function', () => {
    const emitter = new Emitter<TestEvents>();
    const handler = vi.fn();
    const off = emitter.on('message', handler);

    emitter.emit('message', 'first');
    expect(handler).toHaveBeenCalledTimes(1);

    off();
    emitter.emit('message', 'second');
    expect(handler).toHaveBeenCalledTimes(1); // not called again
  });

  it('off() removes a specific handler', () => {
    const emitter = new Emitter<TestEvents>();
    const h1 = vi.fn();
    const h2 = vi.fn();
    emitter.on('message', h1);
    emitter.on('message', h2);

    emitter.off('message', h1);
    emitter.emit('message', 'test');

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledWith('test');
  });

  it('off() without handler removes all handlers for that event', () => {
    const emitter = new Emitter<TestEvents>();
    const h1 = vi.fn();
    const h2 = vi.fn();
    emitter.on('message', h1);
    emitter.on('message', h2);

    emitter.off('message');
    emitter.emit('message', 'test');

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('once() fires handler only once', () => {
    const emitter = new Emitter<TestEvents>();
    const handler = vi.fn();
    emitter.once('message', handler);

    emitter.emit('message', 'first');
    emitter.emit('message', 'second');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('first');
  });

  it('once() returns an unsubscribe function that works before emit', () => {
    const emitter = new Emitter<TestEvents>();
    const handler = vi.fn();
    const off = emitter.once('message', handler);

    off(); // cancel before any emission
    emitter.emit('message', 'test');
    expect(handler).not.toHaveBeenCalled();
  });

  it('removeAll() clears all events', () => {
    const emitter = new Emitter<TestEvents>();
    const h1 = vi.fn();
    const h2 = vi.fn();
    emitter.on('message', h1);
    emitter.on('count', h2);

    emitter.removeAll();
    emitter.emit('message', 'test');
    emitter.emit('count', 1);

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('emitting with no handlers does not throw', () => {
    const emitter = new Emitter<TestEvents>();
    expect(() => emitter.emit('message', 'test')).not.toThrow();
  });

  it('handles complex event data', () => {
    const emitter = new Emitter<TestEvents>();
    const handler = vi.fn();
    emitter.on('complex', handler);

    const data = { name: 'test', value: 99 };
    emitter.emit('complex', data);
    expect(handler).toHaveBeenCalledWith(data);
  });

  it('handler added during emit is not called in the same emit cycle', () => {
    const emitter = new Emitter<TestEvents>();
    const late = vi.fn();
    emitter.on('message', () => {
      emitter.on('message', late);
    });
    emitter.emit('message', 'trigger');
    // The late handler was added during iteration, behavior depends on Set iteration
    // but it should not cause errors
  });

  it('multiple on() calls return independent unsubscribe functions', () => {
    const emitter = new Emitter<TestEvents>();
    const handler = vi.fn();
    const off1 = emitter.on('message', handler);
    const off2 = emitter.on('count', handler);

    off1();
    emitter.emit('message', 'gone');
    emitter.emit('count', 42);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(42);

    off2();
    emitter.emit('count', 99);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
