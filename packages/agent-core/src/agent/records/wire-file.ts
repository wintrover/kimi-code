import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { syncDir } from '../../utils/fs';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  type AgentRecord,
  type AgentRecordPersistence,
} from './types';

interface AgentWireMetadata {
  readonly type: 'metadata';
  readonly protocol_version: string;
  readonly created_at: number;
}

type WireFileRecord = AgentRecord | AgentWireMetadata;

export interface FileSystemAgentRecordPersistenceOptions {
  readonly onError?: ((error: unknown) => void) | undefined;
}

class AsyncSerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => {
      /* swallow so a rejected task does not poison the chain */
    });
    return next;
  }
}

// Single-writer per file: the "is file empty?" check before emitting the
// header is racy across processes, but multi-writer wire.jsonl is unsupported.
export class FileSystemAgentRecordPersistence implements AgentRecordPersistence {
  private readonly queue = new AsyncSerialQueue();
  private readonly pending: WireFileRecord[] = [];
  private closed = false;
  private closing = false;
  private directorySynced = false;
  private drainScheduled = false;
  private lastBackgroundError: Error | undefined;
  private headerPromise: Promise<void> | undefined;

  constructor(
    private readonly filePath: string,
    private readonly options: FileSystemAgentRecordPersistenceOptions = {},
  ) {}

  async *read(): AsyncIterable<AgentRecord> {
    await this.flush();

    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw error;
    }

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.length === 0) continue;

      let parsed: WireFileRecord;
      try {
        parsed = JSON.parse(line) as WireFileRecord;
      } catch (parseError) {
        // Tolerate a truncated trailing line — last write may have crashed
        // mid-flush; everything before is still well-formed.
        if (i === lines.length - 1) continue;
        throw new Error(
          `wire.jsonl: corrupted line ${i + 1} in ${this.filePath}: ${String(parseError)}`,
          { cause: parseError },
        );
      }
      if (parsed.type === 'metadata') continue;
      yield parsed;
    }
  }

  async append(input: AgentRecord): Promise<void> {
    if (this.closed || this.closing) {
      throw new Error('FileSystemAgentRecordPersistence: append on closed persistence');
    }
    await this.ensureHeader();
    if (this.closed || this.closing) {
      throw new Error('FileSystemAgentRecordPersistence: append on closed persistence');
    }
    this.pending.push(input);
    this.scheduleDrain();
  }

  async flush(): Promise<void> {
    await this.headerPromise;
    try {
      await this.queue.run(async () => {
        while (this.pending.length > 0 && !this.closed) {
          await this.drainBatch();
        }
      });
    } catch (error) {
      this.options.onError?.(error);
      throw error;
    }

    if (this.lastBackgroundError !== undefined) {
      const error = this.lastBackgroundError;
      this.lastBackgroundError = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    try {
      await this.flush();
      this.closed = true;
    } catch (error) {
      this.closing = false;
      throw error;
    }
  }

  private ensureHeader(): Promise<void> {
    this.headerPromise ??= this.writeHeaderIfNeeded();
    return this.headerPromise;
  }

  private async writeHeaderIfNeeded(): Promise<void> {
    let isEmpty = true;
    try {
      const stats = await stat(this.filePath);
      isEmpty = stats.size === 0;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
    if (!isEmpty) return;

    this.pending.unshift({
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
      created_at: Date.now(),
    });
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.closed) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      if (this.closed || this.pending.length === 0) return;
      this.queue
        .run(async () => {
          while (this.pending.length > 0 && !this.closed) {
            await this.drainBatch();
          }
        })
        .catch((error) => {
          this.lastBackgroundError = error as Error;
          this.options.onError?.(error);
        });
    });
  }

  private async drainBatch(): Promise<void> {
    if (this.pending.length === 0) return;

    const batch = this.pending.splice(0);
    const lines = batch.map((e) => JSON.stringify(e) + '\n');

    await mkdir(dirname(this.filePath), { recursive: true });

    const fh = await open(this.filePath, 'a');
    try {
      await fh.appendFile(lines.join(''), 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }

    if (!this.directorySynced) {
      await syncDir(dirname(this.filePath));
      this.directorySynced = true;
    }
  }
}
