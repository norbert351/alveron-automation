import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError, safeCode } from '../../src/integrations/alveron/errors.js';

test('canonical application errors never expose arbitrary exception messages', () => {
  assert.equal(safeCode(new AppError('VALIDATION_FAILED')), 'VALIDATION_FAILED');
  assert.equal(safeCode(new Error('private response')), 'INTERNAL_ERROR');
});
