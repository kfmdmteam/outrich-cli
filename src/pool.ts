// A fixed pool of worker threads. Each worker runs this same bundle and answers one job at a time.
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { Job, Result } from "./work.ts";
import type { WorkerOptions } from "./records.ts";

type Pending = { job: Job; resolve: (r: Result) => void; reject: (e: Error) => void };

export class Pool {
  private idle: Worker[] = [];
  private busy = new Map<Worker, Pending>();
  private queue: Pending[] = [];
  private workers: Worker[] = [];
  private failed: Error | null = null;
  /** Called with the bytes a hash job has read since its last report. */
  onProgress: (bytes: number) => void = () => {};

  constructor(readonly size: number, options: WorkerOptions) {
    for (let i = 0; i < size; i++) {
      // A small young generation keeps each worker near 30 MB: garbage from one block is collected before the next.
      // Without it V8 lets every worker grow past 150 MB. The old-generation figure is only a ceiling.
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { outrichWorker: true, options }, resourceLimits: { maxYoungGenerationSizeMb: 4, maxOldGenerationSizeMb: 512 } });
      w.on("message", (m: { progress?: number; result?: Result; error?: string }) => {
        if (m.progress !== undefined) return this.onProgress(m.progress);
        const p = this.busy.get(w)!;
        this.busy.delete(w);
        this.idle.push(w);
        if (m.error !== undefined) p.reject(new Error(m.error)); else p.resolve(m.result!);
        this.next();
      });
      w.on("error", (e) => this.fail(e));
      w.on("exit", (code) => { if (code !== 0 && !this.closed) this.fail(new Error(`A worker stopped with exit code ${code}.`)); });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  private closed = false;

  private fail(e: Error) {
    this.failed = e;
    for (const p of [...this.busy.values(), ...this.queue]) p.reject(e);
    this.busy.clear(); this.queue = [];
  }

  private next() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!, p = this.queue.shift()!;
      this.busy.set(w, p);
      // The input bytes move to the worker instead of being copied.
      w.postMessage(p.job, "bytes" in p.job ? [p.job.bytes.buffer as ArrayBuffer] : []);
    }
  }

  /** Callers bound how many jobs they have outstanding; the pool itself only queues. */
  run(job: Job): Promise<Result> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => { this.queue.push({ job, resolve, reject }); this.next(); });
  }

  async close() {
    this.closed = true;
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
