import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'pathe';
import type { ZodType } from 'zod';

import { createZodValidator, type SchemaValidator } from './schema-registry';

export interface ArtifactRecord<Payload = unknown> {
  readonly agentId: string;
  readonly artifactId: string;
  readonly profileName: string;
  readonly schemaVersion: string;
  readonly createdAt: number;
  readonly checksum: string;
  readonly payload: Payload;
  readonly sequence: number;
  readonly parentSequence?: number;
}

export interface CommitOptions<T> {
  readonly artifactId?: string;
  readonly profileName: string;
  readonly schemaVersion: string;
  readonly payload: T;
  readonly parentSequence?: number;
}

export type ArtifactValidator<T> = ZodType<T> | SchemaValidator<T>;

export interface AgentLedger {
  readonly agentId: string;
  readonly artifactsDir: string;
  commit<T>(
    options: CommitOptions<T>,
    validator?: ArtifactValidator<T>,
  ): Promise<ArtifactRecord<T>>;
  read<T>(artifactId?: string, validator?: ArtifactValidator<T>): Promise<ArtifactRecord<T> | undefined>;
  readAll<T>(validator?: ArtifactValidator<T>): Promise<ArtifactRecord<T>[]>;
  readRecent<T>(n: number, validator?: ArtifactValidator<T>): Promise<ArtifactRecord<T>[]>;
  readCheckpoints<T>(n: number, validator?: ArtifactValidator<T>): Promise<ArtifactRecord<T>[]>;
  readDeltaChain<T>(fromSequence: number, validator?: ArtifactValidator<T>): Promise<ArtifactRecord<T>[]>;
}

interface RawArtifactRecord {
  readonly agentId: string;
  readonly artifactId: string;
  readonly profileName: string;
  readonly schemaVersion: string;
  readonly createdAt: number;
  readonly checksum: string;
  readonly payload: unknown;
  readonly sequence: number;
  readonly parentSequence?: number;
}

export class FileSystemAgentLedger implements AgentLedger {
  readonly agentId: string;
  readonly artifactsDir: string;
  private sequence = 0;

  constructor(options: { readonly agentId: string; readonly artifactsDir: string }) {
    this.agentId = options.agentId;
    this.artifactsDir = options.artifactsDir;
  }

  async commit<T>(
    options: CommitOptions<T>,
    validator?: ArtifactValidator<T>,
  ): Promise<ArtifactRecord<T>> {
    const normalizedValidator = validator !== undefined ? toSchemaValidator(validator) : undefined;
    if (normalizedValidator !== undefined) {
      const validation = normalizedValidator.validate(options.payload);
      if (!validation.success) {
        throw new ArtifactValidationError(
          `Artifact payload validation failed: ${validation.error}`,
        );
      }
    }

    this.sequence += 1;
    const artifactId = options.artifactId ?? 'final';
    const record: ArtifactRecord<T> = {
      agentId: this.agentId,
      artifactId,
      profileName: options.profileName,
      schemaVersion: options.schemaVersion,
      createdAt: Date.now(),
      checksum: '',
      payload: options.payload,
      sequence: this.sequence,
      parentSequence: options.parentSequence,
    };

    const recordWithChecksum: ArtifactRecord<T> = {
      ...record,
      checksum: computeChecksum(record),
    };

    await mkdir(this.artifactsDir, { recursive: true });
    await commitAtomic(this.artifactsDir, artifactId, recordWithChecksum);
    return recordWithChecksum;
  }

  async read<T>(
    artifactId = 'final',
    validator?: ArtifactValidator<T>,
  ): Promise<ArtifactRecord<T> | undefined> {
    const filePath = join(this.artifactsDir, `${artifactId}.json`);
    return readArtifactFile(filePath, validator);
  }

  async readAll<T>(validator?: ArtifactValidator<T>): Promise<ArtifactRecord<T>[]> {
    await mkdir(this.artifactsDir, { recursive: true });
    const entries = await readdir(this.artifactsDir, { withFileTypes: true });
    const filePaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => join(this.artifactsDir, entry.name));

    const records = await Promise.all(
      filePaths.map((filePath) => readArtifactFile(filePath, validator)),
    );
    return records
      .filter((record): record is ArtifactRecord<T> => record !== undefined)
      .toSorted((a, b) => a.sequence - b.sequence);
  }

  async readRecent<T>(n: number, validator?: ArtifactValidator<T>): Promise<ArtifactRecord<T>[]> {
    const all = await this.readAll<T>(validator);
    return all.slice(-Math.max(1, n));
  }

  async readCheckpoints<T>(n: number, validator?: ArtifactValidator<T>): Promise<ArtifactRecord<T>[]> {
    const all = await this.readAll<T>(validator);
    return all.filter((record) => record.artifactId !== 'final').slice(-Math.max(1, n));
  }

  async readDeltaChain<T>(
    fromSequence: number,
    validator?: ArtifactValidator<T>,
  ): Promise<ArtifactRecord<T>[]> {
    const all = await this.readAll<T>(validator);
    const chain: ArtifactRecord<T>[] = [];
    let expected = fromSequence;
    for (const record of all) {
      if (record.sequence < fromSequence) continue;
      if (record.sequence === expected || record.parentSequence === expected - 1) {
        chain.push(record);
        expected = record.sequence + 1;
      }
    }
    return chain;
  }
}

export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactValidationError';
  }
}

export class ArtifactCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactCorruptionError';
  }
}

function toSchemaValidator<T>(validator: ArtifactValidator<T>): SchemaValidator<T> {
  if ('safeParse' in validator) {
    return createZodValidator(validator as ZodType<T>, '1.0.0');
  }
  return validator;
}

async function commitAtomic<T>(
  dir: string,
  artifactId: string,
  record: ArtifactRecord<T>,
): Promise<void> {
  const tmpPath = join(dir, `${artifactId}.json.tmp-${randomUUID()}`);
  const finalPath = join(dir, `${artifactId}.json`);
  const canonical = canonicalJson(record);
  try {
    await writeFile(tmpPath, canonical, 'utf8');
    await rename(tmpPath, finalPath);
  } catch (error) {
    try {
      await removeFile(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

async function readArtifactFile<T>(
  filePath: string,
  validator?: ArtifactValidator<T>,
): Promise<ArtifactRecord<T> | undefined> {
  const normalizedValidator = validator !== undefined ? toSchemaValidator(validator) : undefined;
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content) as RawArtifactRecord;
    const expectedChecksum = computeChecksum(parsed);
    if (parsed.checksum !== expectedChecksum) {
      throw new ArtifactCorruptionError(
        `Checksum mismatch for artifact ${parsed.artifactId}: expected ${expectedChecksum}, got ${parsed.checksum}`,
      );
    }
    if (normalizedValidator !== undefined) {
      const validation = normalizedValidator.validate(parsed.payload);
      if (!validation.success) {
        throw new ArtifactValidationError(
          `Stored artifact payload validation failed: ${validation.error}`,
        );
      }
      return { ...parsed, payload: validation.data };
    }
    return parsed as ArtifactRecord<T>;
  } catch (error) {
    if (error instanceof ArtifactValidationError || error instanceof ArtifactCorruptionError) {
      throw error;
    }
    return undefined;
  }
}

function computeChecksum<T>(record: ArtifactRecord<T>): string {
  const recordWithoutChecksum: Omit<ArtifactRecord<T>, 'checksum'> = {
    agentId: record.agentId,
    artifactId: record.artifactId,
    profileName: record.profileName,
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt,
    payload: record.payload,
    sequence: record.sequence,
    parentSequence: record.parentSequence,
  };
  const canonical = canonicalJson(recordWithoutChecksum);
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).toSorted()) {
    sorted[key] = sortJsonValue(record[key]);
  }
  return sorted;
}

async function removeFile(path: string): Promise<void> {
  const { unlink } = await import('node:fs/promises');
  await unlink(path);
}
