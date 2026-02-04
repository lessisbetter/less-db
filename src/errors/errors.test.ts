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
  });

  describe('InvalidStateError', () => {
    it('has correct name and default message', () => {
      const error = new InvalidStateError();
      expect(error.name).toBe('InvalidStateError');
      expect(error.message).toBe('Invalid state');
    });
  });

  describe('InvalidTableError', () => {
    it('has correct name and default message', () => {
      const error = new InvalidTableError();
      expect(error.name).toBe('InvalidTableError');
      expect(error.message).toBe('Invalid table');
    });
  });

  describe('DataError', () => {
    it('has correct name and default message', () => {
      const error = new DataError();
      expect(error.name).toBe('DataError');
      expect(error.message).toBe('Invalid data');
    });
  });

  describe('AbortError', () => {
    it('has correct name and default message', () => {
      const error = new AbortError();
      expect(error.name).toBe('AbortError');
      expect(error.message).toBe('Transaction aborted');
    });
  });

  describe('MissingAPIError', () => {
    it('has correct name and default message', () => {
      const error = new MissingAPIError();
      expect(error.name).toBe('MissingAPIError');
      expect(error.message).toBe('Required API not available');
    });
  });

  describe('SchemaError', () => {
    it('has correct name and default message', () => {
      const error = new SchemaError();
      expect(error.name).toBe('SchemaError');
      expect(error.message).toBe('Schema error');
    });
  });

  describe('BlockedError', () => {
    it('has correct name and default message', () => {
      const error = new BlockedError();
      expect(error.name).toBe('BlockedError');
      expect(error.message).toBe('Database blocked');
    });
  });

  describe('VersionChangeError', () => {
    it('has correct name and default message', () => {
      const error = new VersionChangeError();
      expect(error.name).toBe('VersionChangeError');
      expect(error.message).toBe('Version change detected');
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
  });
});
