// zod schema for LLM decision output. See spec §4.1.
// Malformed or invalid → caller treats as HOLD_ALL (never throw inside the loop).
import { z } from 'zod';
import { SAFETY } from '../config.js';

export const DecisionSchema = z.object({
  action: z.enum(['HOLD_ALL', 'EXIT', 'OPEN', 'ADD']),
  token: z.string().optional(),
  size_usdc: z.number().optional(),
  thesis: z.string().min(1),
  invalidation: z.string().min(1),
  expected_move_pct: z.number(),
  confidence: z.number().int().min(1).max(10),
}).superRefine((data, ctx) => {
  // token required for all non-HOLD_ALL actions
  if (data.action !== 'HOLD_ALL' && !data.token) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'token is required for non-HOLD_ALL actions',
      path: ['token'],
    });
  }

  if (data.action === 'OPEN' || data.action === 'ADD') {
    // size_usdc required for entry actions
    if (data.size_usdc == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'size_usdc is required for OPEN/ADD',
        path: ['size_usdc'],
      });
    } else if (data.size_usdc > SAFETY.MAX_POSITION_SIZE_USDC) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `size_usdc ${data.size_usdc} exceeds maximum ${SAFETY.MAX_POSITION_SIZE_USDC} USDC (§1)`,
        path: ['size_usdc'],
      });
    }
    // §1: minimum expected move to justify fees
    if (data.expected_move_pct < 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expected_move_pct must be >= 5 for OPEN/ADD — below this, fee drag dominates (§1)',
        path: ['expected_move_pct'],
      });
    }
  }
});

export type Decision = z.infer<typeof DecisionSchema>;
