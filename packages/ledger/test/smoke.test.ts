import { describe, expect, it } from 'vitest';
import { LEDGER_VERSION } from '../src/index.js';

describe('workspace', () => {
  it('resolves the ledger package', () => {
    expect(LEDGER_VERSION).toBe('0.1.0');
  });
});
