// Decision schema tests — spec §4.1. Schema is the first gate before any trade fires.
import { describe, it, expect } from 'vitest';
import { DecisionSchema } from '../src/agent/schemas.js';
import { SAFETY } from '../src/config.js';

function validOpen(overrides: Record<string, unknown> = {}) {
  return {
    action: 'OPEN' as const,
    token: 'BONK',
    size_usdc: 5.0,
    thesis: 'Strong momentum with volume surge into resistance',
    invalidation: 'Price drops below 30-day moving average on 4h close',
    expected_move_pct: 10,
    confidence: 7,
    ...overrides,
  };
}

describe('DecisionSchema §4.1', () => {

  // ── Valid decisions ────────────────────────────────────────────────────────

  it('valid OPEN parses successfully', () => {
    expect(DecisionSchema.safeParse(validOpen()).success).toBe(true);
  });

  it('valid ADD parses successfully', () => {
    const d = { ...validOpen(), action: 'ADD' as const };
    expect(DecisionSchema.safeParse(d).success).toBe(true);
  });

  it('valid EXIT parses successfully (no size_usdc required)', () => {
    const d = {
      action: 'EXIT' as const,
      token: 'BONK',
      thesis: 'Thesis invalidated: price rejected at key resistance',
      invalidation: 'Price reclaims the resistance level',
      expected_move_pct: 0,
      confidence: 8,
    };
    expect(DecisionSchema.safeParse(d).success).toBe(true);
  });

  it('HOLD_ALL with no token passes', () => {
    const d = {
      action: 'HOLD_ALL' as const,
      thesis: 'No clear setups in the current universe',
      invalidation: 'Any token shows a breakout above recent consolidation',
      expected_move_pct: 0,
      confidence: 5,
    };
    expect(DecisionSchema.safeParse(d).success).toBe(true);
  });

  it('HOLD_ALL with extra fields (token present) still parses', () => {
    const d = {
      action: 'HOLD_ALL' as const,
      token: 'BONK',  // allowed — just ignored
      thesis: 'Waiting',
      invalidation: 'If volume spikes',
      expected_move_pct: 0,
      confidence: 3,
    };
    expect(DecisionSchema.safeParse(d).success).toBe(true);
  });

  // ── token required for non-HOLD_ALL ──────────────────────────────────────

  it('OPEN missing token fails', () => {
    const { token: _t, ...rest } = validOpen();
    const r = DecisionSchema.safeParse(rest);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some(i => i.path.includes('token'))).toBe(true);
  });

  it('EXIT missing token fails', () => {
    const d = {
      action: 'EXIT' as const,
      thesis: 'Exit', invalidation: 'n/a',
      expected_move_pct: 0, confidence: 8,
    };
    expect(DecisionSchema.safeParse(d).success).toBe(false);
  });

  // ── expected_move_pct >= 5 for OPEN/ADD ──────────────────────────────────

  it('OPEN with expected_move_pct = 4.9 fails (below §1 minimum)', () => {
    const r = DecisionSchema.safeParse(validOpen({ expected_move_pct: 4.9 }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some(i => i.path.includes('expected_move_pct'))).toBe(true);
  });

  it('OPEN with expected_move_pct = 5 exactly passes', () => {
    expect(DecisionSchema.safeParse(validOpen({ expected_move_pct: 5 })).success).toBe(true);
  });

  it('ADD with expected_move_pct < 5 fails', () => {
    const d = { ...validOpen(), action: 'ADD' as const, expected_move_pct: 3 };
    expect(DecisionSchema.safeParse(d).success).toBe(false);
  });

  it('EXIT with expected_move_pct < 5 passes (no minimum on EXIT)', () => {
    const d = {
      action: 'EXIT' as const, token: 'BONK',
      thesis: 'exit', invalidation: 'n/a',
      expected_move_pct: 0, confidence: 8,
    };
    expect(DecisionSchema.safeParse(d).success).toBe(true);
  });

  // ── size_usdc constraints for OPEN/ADD ────────────────────────────────────

  it('OPEN missing size_usdc fails', () => {
    const { size_usdc: _s, ...rest } = validOpen();
    const r = DecisionSchema.safeParse(rest);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some(i => i.path.includes('size_usdc'))).toBe(true);
  });

  it(`OPEN size_usdc > ${SAFETY.MAX_POSITION_SIZE_USDC} fails`, () => {
    const r = DecisionSchema.safeParse(validOpen({ size_usdc: SAFETY.MAX_POSITION_SIZE_USDC + 0.01 }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some(i => i.path.includes('size_usdc'))).toBe(true);
  });

  it(`OPEN size_usdc exactly ${SAFETY.MAX_POSITION_SIZE_USDC} passes`, () => {
    expect(DecisionSchema.safeParse(validOpen({ size_usdc: SAFETY.MAX_POSITION_SIZE_USDC })).success).toBe(true);
  });

  // ── confidence range ──────────────────────────────────────────────────────

  it('confidence 0 fails', () => {
    expect(DecisionSchema.safeParse(validOpen({ confidence: 0 })).success).toBe(false);
  });

  it('confidence 11 fails', () => {
    expect(DecisionSchema.safeParse(validOpen({ confidence: 11 })).success).toBe(false);
  });

  it('confidence 1 and 10 both pass', () => {
    expect(DecisionSchema.safeParse(validOpen({ confidence: 1 })).success).toBe(true);
    expect(DecisionSchema.safeParse(validOpen({ confidence: 10 })).success).toBe(true);
  });

  it('non-integer confidence fails', () => {
    expect(DecisionSchema.safeParse(validOpen({ confidence: 7.5 })).success).toBe(false);
  });

  // ── required text fields ──────────────────────────────────────────────────

  it('empty thesis fails', () => {
    expect(DecisionSchema.safeParse(validOpen({ thesis: '' })).success).toBe(false);
  });

  it('empty invalidation fails', () => {
    expect(DecisionSchema.safeParse(validOpen({ invalidation: '' })).success).toBe(false);
  });

  // ── unknown action fails ──────────────────────────────────────────────────

  it('unknown action fails', () => {
    expect(DecisionSchema.safeParse(validOpen({ action: 'BUY' })).success).toBe(false);
  });
});
