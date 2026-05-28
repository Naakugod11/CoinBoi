// Helius parseSwap tests — wallet identification by public key, not index.
import { describe, it, expect, vi } from 'vitest';
import { parseSwap } from '../src/signals/helius.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const OUR_WALLET = 'OurWalletPubkey111111111111111111111111111111';
const OTHER_WALLET = 'OtherProgramOrFeePayerXXXXXXXXXXXXXXXXXXXXXX';

// Build a fake getTransaction RPC response.
// walletAtIndex controls where OUR_WALLET appears in accountKeys.
function makeGetTxResponse(opts: {
  walletAtIndex: number;  // index of OUR_WALLET in accountKeys
  preUsdcAmount: number;
  postUsdcAmount: number;
  preBonkAmount: number;
  postBonkAmount: number;
  fee?: number;
}) {
  const accountKeys = ['program111', OTHER_WALLET, OUR_WALLET, 'anotherProgram'];
  // Override: put OUR_WALLET at the requested index
  const keys = [...accountKeys];
  if (opts.walletAtIndex !== 2) {
    // Swap OUR_WALLET to the specified position
    keys[opts.walletAtIndex] = OUR_WALLET;
    keys[2] = 'replacedSlot';
  }

  return {
    result: {
      meta: {
        err: null,
        preBalances: [1_000_000_000, 0, 500_000_000, 0],
        postBalances: [999_800_000, 0, 500_000_000, 0],
        fee: opts.fee ?? 5000,
        preTokenBalances: [
          { accountIndex: opts.walletAtIndex, mint: USDC_MINT,  uiTokenAmount: { uiAmount: opts.preUsdcAmount } },
          { accountIndex: opts.walletAtIndex, mint: BONK_MINT, uiTokenAmount: { uiAmount: opts.preBonkAmount } },
        ],
        postTokenBalances: [
          { accountIndex: opts.walletAtIndex, mint: USDC_MINT,  uiTokenAmount: { uiAmount: opts.postUsdcAmount } },
          { accountIndex: opts.walletAtIndex, mint: BONK_MINT, uiTokenAmount: { uiAmount: opts.postBonkAmount } },
        ],
      },
      transaction: {
        message: { accountKeys: keys },
      },
    },
  };
}

function makeFetch(response: object): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(response))) as unknown as typeof fetch;
}

describe('helius.parseSwap', () => {
  const baseOpts = {
    rpcUrl: 'https://fake-helius.example.com/',
    walletPublicKey: OUR_WALLET,
  };

  it('correctly attributes amounts when wallet is at index 0 (fee payer)', async () => {
    // Old assumption was index 0 — verify it still works when it IS at 0
    const txResp = makeGetTxResponse({
      walletAtIndex: 0,
      preUsdcAmount: 10.0, postUsdcAmount: 4.975,  // spent 5.025 USDC
      preBonkAmount: 0,    postBonkAmount: 990_000, // received 990000 BONK
    });
    // For index 0 to work, accountKeys[0] must be OUR_WALLET
    txResp.result.transaction.message.accountKeys[0] = OUR_WALLET;

    const result = await parseSwap('sig1', {
      ...baseOpts,
      fetchFn: makeFetch(txResp),
    });

    expect(result.usdcAmount).toBeCloseTo(5.025, 3);
    expect(result.tokenAmount).toBe(990_000);
  });

  it('correctly attributes amounts when wallet is NOT at index 0 (fee payer is different)', async () => {
    // Critical test: fee payer (index 0) is a Jupiter program, not our wallet.
    // Our wallet is at index 3. Old code would have read index 0 (wrong).
    const txResp = makeGetTxResponse({
      walletAtIndex: 3,
      preUsdcAmount: 10.0, postUsdcAmount: 4.975,  // spent 5.025 USDC
      preBonkAmount: 0,    postBonkAmount: 990_000,
    });
    txResp.result.transaction.message.accountKeys[3] = OUR_WALLET;
    txResp.result.transaction.message.accountKeys[0] = 'JupiterFeePayerXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

    const result = await parseSwap('sig2', {
      ...baseOpts,
      fetchFn: makeFetch(txResp),
    });

    expect(result.usdcAmount).toBeCloseTo(5.025, 3);
    expect(result.tokenAmount).toBe(990_000);
  });

  it('correctly attributes a sell (USDC increases, token decreases)', async () => {
    const txResp = makeGetTxResponse({
      walletAtIndex: 1,
      preUsdcAmount: 4.975, postUsdcAmount: 10.0,  // received 5.025 USDC
      preBonkAmount: 990_000, postBonkAmount: 0,   // sold 990000 BONK
    });
    txResp.result.transaction.message.accountKeys[1] = OUR_WALLET;

    const result = await parseSwap('sig3', {
      ...baseOpts,
      fetchFn: makeFetch(txResp),
    });

    // Absolute values: usdcAmount = 5.025, tokenAmount = 990000
    expect(result.usdcAmount).toBeCloseTo(5.025, 3);
    expect(result.tokenAmount).toBe(990_000);
  });

  it('throws when wallet public key is not in transaction account keys', async () => {
    const txResp = makeGetTxResponse({
      walletAtIndex: 0,
      preUsdcAmount: 10, postUsdcAmount: 5,
      preBonkAmount: 0, postBonkAmount: 1000,
    });
    // None of the keys match OUR_WALLET
    txResp.result.transaction.message.accountKeys.forEach((_, i, arr) => {
      arr[i] = 'SomeProgramXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    });

    await expect(parseSwap('sig4', {
      ...baseOpts,
      fetchFn: makeFetch(txResp),
    })).rejects.toThrow(/not found in transaction account keys/);
  });

  it('throws when WALLET_PUBLIC_KEY is not provided', async () => {
    const txResp = makeGetTxResponse({
      walletAtIndex: 0,
      preUsdcAmount: 10, postUsdcAmount: 5,
      preBonkAmount: 0, postBonkAmount: 1000,
    });

    await expect(parseSwap('sig5', {
      rpcUrl: 'https://fake-helius.example.com/',
      fetchFn: makeFetch(txResp),
      // walletPublicKey omitted, and WALLET_PUBLIC_KEY env is not set in test
    })).rejects.toThrow(/WALLET_PUBLIC_KEY not set/);
  });

  it('fee converts from lamports to USDC estimate', async () => {
    const txResp = makeGetTxResponse({
      walletAtIndex: 0,
      preUsdcAmount: 10, postUsdcAmount: 5,
      preBonkAmount: 0, postBonkAmount: 1000,
      fee: 5000, // 5000 lamports = 0.000005 SOL × 150 USD/SOL = 0.00075 USDC
    });
    txResp.result.transaction.message.accountKeys[0] = OUR_WALLET;

    const result = await parseSwap('sig6', {
      ...baseOpts,
      fetchFn: makeFetch(txResp),
    });

    expect(result.feeUsdc).toBeCloseTo(0.00075, 5);
  });
});
