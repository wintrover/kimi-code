import Ajv, { type Schema } from 'ajv';
import addFormats from 'ajv-formats';
import type { z } from 'zod';

export type MigrationTransformer<From = unknown, To = unknown> = (
  payload: From,
  fromVersion: string,
  toVersion: string,
) => To;

export interface ValidationSuccess<T> {
  readonly success: true;
  readonly data: T;
}

export interface ValidationFailure {
  readonly success: false;
  readonly error: string;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export interface SchemaValidator<T = unknown> {
  readonly version: string;
  /** Phantom property to help TypeScript infer the validated payload type. */
  readonly _type?: T;
  validate(payload: unknown): ValidationResult<T>;
}

export interface RegisteredSchema<T = unknown> {
  readonly version: string;
  readonly validator: SchemaValidator<T>;
  readonly migrations?: ReadonlyArray<MigrationTransformer<unknown, unknown>>;
}

export interface MigrationResult<T> {
  readonly success: true;
  readonly payload: T;
}

export interface MigrationFailure {
  readonly success: false;
  readonly error: string;
}

export type MigrationOutcome<T> = MigrationResult<T> | MigrationFailure;

export function createZodValidator<T>(schema: z.ZodType<T>, version: string): SchemaValidator<T> {
  return {
    version,
    _type: undefined as T,
    validate(payload: unknown): ValidationResult<T> {
      const result = schema.safeParse(payload);
      if (!result.success) {
        return { success: false, error: result.error.message };
      }
      return { success: true, data: result.data };
    },
  };
}

function createJsonSchemaValidator<T = unknown>(schema: Schema, version: string): SchemaValidator<T> {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  return {
    version,
    _type: undefined as T,
    validate(payload: unknown): ValidationResult<T> {
      const valid = validate(payload);
      if (!valid) {
        const message = ajv.errorsText(validate.errors, { dataVar: 'payload' });
        return { success: false, error: message };
      }
      return { success: true, data: payload as T };
    },
  };
}

export class ArtifactSchemaRegistry {
  private schemas = new Map<string, RegisteredSchema>();

  register<T>(profileName: string, schema: z.ZodType<T>, version = '1.0.0'): void {
    this.schemas.set(profileName, { version, validator: createZodValidator(schema, version) });
  }

  registerJsonSchema<T = unknown>(profileName: string, schema: Schema, version = '1.0.0'): void {
    this.schemas.set(profileName, {
      version,
      validator: createJsonSchemaValidator<T>(schema, version),
    });
  }

  registerMigration<From, To>(
    profileName: string,
    fromVersion: string,
    toVersion: string,
    transformer: MigrationTransformer<From, To>,
  ): void {
    const existing = this.schemas.get(profileName);
    if (existing === undefined) {
      throw new Error(`Cannot register migration for unknown profile "${profileName}"`);
    }
    const migrations: MigrationTransformer<unknown, unknown>[] = [
      ...(existing.migrations ?? []),
      transformer as MigrationTransformer<unknown, unknown>,
    ];
    this.schemas.set(profileName, { ...existing, migrations });
  }

  get(profileName: string): RegisteredSchema | undefined {
    return this.schemas.get(profileName);
  }

  has(profileName: string): boolean {
    return this.schemas.has(profileName);
  }

  migrate<T>(profileName: string, payload: unknown, fromVersion: string): MigrationOutcome<T> {
    const registered = this.schemas.get(profileName);
    if (registered === undefined) {
      return {
        success: false,
        error: `No schema registered for profile "${profileName}"`,
      };
    }

    if (fromVersion === registered.version) {
      const validation = registered.validator.validate(payload);
      if (!validation.success) {
        return { success: false, error: validation.error };
      }
      return { success: true, payload: validation.data as T };
    }

    if (registered.migrations === undefined || registered.migrations.length === 0) {
      return {
        success: false,
        error: `No migrations registered for profile "${profileName}" (from ${fromVersion} to ${registered.version})`,
      };
    }

    try {
      let current = payload;
      for (const migration of registered.migrations) {
        current = migration(current, fromVersion, registered.version);
      }
      const validation = registered.validator.validate(current);
      if (!validation.success) {
        return { success: false, error: validation.error };
      }
      return { success: true, payload: validation.data as T };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  static default(): ArtifactSchemaRegistry {
    return new ArtifactSchemaRegistry();
  }
}
