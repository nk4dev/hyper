/**
 * Tiny synchronous queue replacement for the `queue` package.
 *
 * Supports a subset of the queue API used in this repo:
 *   - default export is a factory: `const q = simpleQueue({ concurrency: 1 })`
 *   - returned object exposes `push(task)` and `start()` methods
 *   - tasks are called with a `done` callback which must be invoked when the
 *     task is finished. Tasks may also return a Promise.
 *
 * This is intentionally minimal and synchronous in the sense it uses simple
 * callback-based completion and does not rely on an external ESM package.
 */

type Task = (done?: () => void) => void | Promise<any>;

export interface SimpleQueueOptions {
  concurrency?: number;
}

export default function simpleQueue(opts?: SimpleQueueOptions) {
  const concurrency = Math.max(1, Math.floor(Number(opts?.concurrency ?? 1)));
  const tasks: Task[] = [];
  let running = 0;
  let started = false;

  const asap =
    typeof (globalThis as any).setImmediate === "function"
      ? (globalThis as any).setImmediate.bind(globalThis)
      : (fn: () => void) => setTimeout(fn, 0);

  function push(task: Task) {
    if (typeof task !== "function") {
      throw new TypeError("task must be a function");
    }
    tasks.push(task);
  }

  function _schedule() {
    // Fill available concurrency slots.
    while (running < concurrency && tasks.length > 0) {
      const task = tasks.shift()!;
      running++;
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        running--;
        // Schedule next work pass asynchronously to avoid deep recursion.
        asap(() => _schedule());
      };

      try {
        const result = task(finish);
        // If task returned a Promise, resolve it and call finish afterwards.
        if (result && typeof (result as Promise<any>).then === "function") {
          (result as Promise<any>).then(() => finish(), () => finish());
        }
        // If the task is synchronous and doesn't call finish, it is the
        // task's responsibility to call the provided callback. We don't force
        // auto-finishing here to preserve semantics similar to the original package.
      } catch (err) {
        // Ensure queue continues even if task throws.
        finish();
      }
    }
  }

  function start() {
    if (!started) started = true;
    // Kick the scheduler asynchronously.
    asap(() => _schedule());
  }

  return {
    push,
    start,
    // Helpful properties for small instrumentation or tests
    get length() {
      return tasks.length;
    },
    get running() {
      return running;
    },
    // Expose a tiny debug dump (not part of original API)
    _dump() {
      return { tasksLength: tasks.length, running };
    },
  };
}
