// Tiny dependency-free concurrency limiter.
export function pLimit(concurrency: number) {
  const n = Math.max(1, Math.floor(concurrency || 1));
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    const run = queue.shift();
    if (run) run();
  };
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(
          (v) => {
            resolve(v);
            next();
          },
          (e) => {
            reject(e);
            next();
          },
        );
      };
      if (active < n) run();
      else queue.push(run);
    });
  };
}

export async function runWithLimit<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const limit = pLimit(concurrency);
  return Promise.all(items.map((item) => limit(() => worker(item))));
}