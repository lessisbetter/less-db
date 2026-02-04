import { describe, it, expect } from 'vitest';
import {
  LessDBError,
  ConstraintError,
  NotFoundError,
  InvalidStateError,
  InvalidTableError,
  DataError,
  AbortError,
  MissingAPIError,
  SchemaError,
  BlockedError,
  VersionChangeError,
  mapError,
} from './errors.js';

describe('errors', () => {
  describe('LessDBError', () => {
    it('creates error with message', () => {
      const error = new LessDBError('test message');
      expect(error.message).toBe('test message');
      expect(error.name).toBe('LessDBError');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(LessDBError);
    });

    it('stores inner error', () => {
      const inner = new Error('inner error');
      const error = new LessDBError('outer', inner);
      expect(error.inner).toBe(inner);
    });

    it('has proper stack trace', () => {
      const error = new LessDBError('test');
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('LessDBError');
    });
  });

  describe('ConstraintError', () => {
    it('has default message', () => {
      const error = new ConstraintError();
      expect(error.message).toBe('Constraint violation');
      expect(error.name).toBe('ConstraintError');
    });

    it('accepts custom message', () => {
      const error = new ConstraintError('Duplicate key: id=123');
      expect(error.message).toBe('Duplicate key: id=123');
    });

    it('is instance of LessDBError', () => {
      const error = new ConstraintError();
      expect(error).toBeInstanceOf(LessDBError);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('NotFoundError', () => {
    it('has correct name and default message', () => {
      const error = new NotFoundError();
      expect(error.name).toBe('NotFoundError');
      expect(error.message).toBe('Item not found');
    });

    it('accepts custom message', () => {
      const error = new NotFoundError('User with id=42 not found');
      expect(error.message).toBe('User with id=42 not found');
    });

    it('stores inner error', () => {
      const inner = new Error('original');
      const error = new NotFoundError('wrapped', inner);
      expect(error.inner).toBe(inner);
    });

    it('is instance of LessDBError', () => {
      expect(new NotFoundError()).toBeInstanceOf(LessDBError);
    });
  });

  describe('InvalidStateError', () => {
    it('has correct name and default message', () => {
      const error = new InvalidStateError();
      expect(error.name).toBe('InvalidStateError');
      expect(error.message).toBe('Invalid state');
    });

    it('accepts custom message', () => {
      const error = new InvalidStateError('Database not open');
      expect(error.message).toBe('Database not open');
    });

    it('stores inner error', () => {
      const inner = new Error('original');
      const error = new InvalidStateError('wrapped', inner);
      expect(error.inner).toBe(inner);
    });

    it('is instance of LessDBError', () => {
      expect(new InvalidStateError()).toBeInstanceOf(LessDBError);
    });
  });

  describe('InvalidTableError', () => {
    it('has correct name and default message', () => {
      const error = new InvalidTableError();
      expect(error.name).toBe('InvalidTableError');
      expect(error.message).toBe('Invalid table');
    });

    it('accepts custom message', () => {
      const error = new InvalidTableError('Table "users" not found');
      expect(error.message).toBe('Table "users" not found');
    });

    it('stores inner error', () => {
      const inner = new Error('original');
      const error = new InvalidTableError('wrapped', inner);
      expect(error.inner).toBe(inner);
    });

    it('is instance of LessDBError', () => {
      expect(new InvalidTableError()).toBeInstanceOf(LessDBError);
    });
  });

  describe('DataError', () => {
    it('has correct name and default message', () => {
      const error = new DataError();
      expect(error.name).toBe('DataError');
      expect(error.message).toBe('Invalid data');
    });

    it('accepts custom message', () => {
      const error = new DataError('Invalid key type');
      expect(error.message).toBe('Invalid key type');
    });

    it('stores inner error', () => {
      const inner = new Error('original');
      const error = new DataError('wrapped', inner);
      expect(error.inner).toBe(inner);
    });

    it('is instance of LessDBError', () => {
      expect(new DataError()).toBeInstanceOf(LessDBError);
    });
  });

  describe('AbortError', () => {
    it('has correct name and default message', () => {
      const error = new AbortError();
      expect(error.name).toBe('AbortError');
      expect(error.message).toBe('Transaction aborted');
    });

    it('accepts custom message', () => {
      const error = new AbortError('Transaction manually aborted');
      expect(error.message).toBe('Transaction manually aborted');
    });

    it('stores inner error', () => {
      const inner = new Error('original');
      const error = new AbortError('wrapped', inner);
      expect(error.inner).toBe(inner);
    });

    it('is instance of LessDBError', () => {
      expect(new AbortError()).toBeInstanceOf(LessDBError);
    });
  });

  describe('MissingAPIError', () => {
    it('has correct name and default message', () => {
      const error = new MissingAPIError();
      expect(error.name).toBe('MissingAPIError');
      expect(error.message).toBe('Required API not available');
    });

    it('accepts custom message', () => {
      const error = new MissingAPIError('IndexedDB not available');
      expect(error.message).toBe('IndexedDB not available');
    });

    it('stores inner error', () => {
      const inner = new Error('original');
      const error = new MissingAPIError('wrapped', inner);
      expect(error.inner).toBe(inner);
    });

    it('is instance of LessDBError', () => {
      expect(new MissingAPIError()).toBeInstanceOf(LessDBError);
    });
  });

  describe('SchemaError', () => {
    it('has correct name and default message', () => {
      const error = new SchemaError();
      expect(error.name).toBe('SchemaError');
      expect(error.message).toBe('Schema error');
    });

    it('accepts custom message', () => {
      const error = new SchemaError('Invalid primary key definition');
      expect(error.message).toBe('Invalid primary key definition');
    });

    it('stores inner error', () => {
      const inner = new Error('original');
      const error = new SchemaError('wrapped', inner);
      expect(error.inner).toBe(inner);
    });

    it('is instance of LessDBError', () => {
      expect(new SchemaError()).toBeInstanceOf(LessDBError);
    });
  });

  describe('BlockedError', () => {
    it('has correct name and default message', () => {
      const error = new BlockedError();
      expect(error.name).toBe('BlockedError');
      expect(error.message).toBe('Database blocked');
    });

    it('accepts custom message', () => {
      const error = new BlockedError('Another connection is blocking upgrade');
      expect(error.message).toBe('Another connection is blocking upgrade');
    });

    it('stores inner error', () => {
      const inner = new Error('original');
      const error = new BlockedError('wrapped', inner);
      expect(error.inner).toBe(inner);
    });

    it('is instance of LessDBError', () => {
      expect(new BlockedError()).toBeInstanceOf(LessDBError);
    });
  });

  describe('VersionChangeError', () => {
    it('has correct name and default message', () => {
      const error = new VersionChangeError();
      expect(error.name).toBe('VersionChangeError');
      expect(error.message).toBe('Version change detected');
    });

    it('accepts custom message', () => {
      const error = new VersionChangeError('Database version changed externally');
      expect(error.message).toBe('Database version changed externally');
    });

    it('stores inner error', () => {
      const inner = new Error('original');
      const error = new VersionChangeError('wrapped', inner);
      expect(error.inner).toBe(inner);
    });

    it('is instance of LessDBError', () => {
      expect(new VersionChangeError()).toBeInstanceOf(LessDBError);
    });
  });

  describe('mapError', () => {
    it('returns LessDBError unchanged', () => {
      const original = new ConstraintError('test');
      const mapped = mapError(original);
      expect(mapped).toBe(original);
    });

    it('maps ConstraintError', () => {
      const native = new Error('native constraint');
      native.name = 'ConstraintError';
      const mapped = mapError(native);
      expect(mapped).toBeInstanceOf(ConstraintError);
      expect(mapped.message).toBe('native constraint');
      expect(mapped.inner).toBe(native);
    });

    it('maps NotFoundError', () => {
      const native = new Error('not found');
      native.name = 'NotFoundError';
      const mapped = mapError(native);
      expect(mapped).toBeInstanceOf(NotFoundError);
    });

    it('maps InvalidStateError', () => {
      const native = new Error('invalid state');
      native.name = 'InvalidStateError';
      const mapped = mapError(native);
      expect(mapped).toBeInstanceOf(InvalidStateError);
    });

    it('maps DataError', () => {
      const native = new Error('bad data');
      native.name = 'DataError';
      const mapped = mapError(native);
      expect(mapped).toBeInstanceOf(DataError);
    });

    it('maps AbortError', () => {
      const native = new Error('aborted');
      native.name = 'AbortError';
      const mapped = mapError(native);
      expect(mapped).toBeInstanceOf(AbortError);
    });

    it('maps unknown Error to LessDBError', () => {
      const native = new Error('something went wrong');
      native.name = 'SomeOtherError';
      const mapped = mapError(native);
      expect(mapped).toBeInstanceOf(LessDBError);
      expect(mapped.message).toBe('something went wrong');
      expect(mapped.inner).toBe(native);
    });

    it('handles non-Error values', () => {
      const mapped = mapError('string error');
      expect(mapped).toBeInstanceOf(LessDBError);
      expect(mapped.message).toBe('string error');
    });

    it('handles null/undefined', () => {
      expect(mapError(null).message).toBe('null');
      expect(mapError(undefined).message).toBe('undefined');
    });

    it('handles numeric error values', () => {
      const mapped = mapError(42);
      expect(mapped).toBeInstanceOf(LessDBError);
      expect(mapped.message).toBe('42');
    });

    it('handles object with custom toString', () => {
      const mapped = mapError({ toString: () => 'custom object error' });
      expect(mapped).toBeInstanceOf(LessDBError);
      // String() uses the custom toString method
      expect(mapped.message).toBe('custom object error');
    });

    it('handles boolean values', () => {
      expect(mapError(true).message).toBe('true');
      expect(mapError(false).message).toBe('false');
    });
  });
});
