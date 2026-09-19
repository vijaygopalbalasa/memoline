export const FEE = {
  minMaxFeePerGasWei: 20_000_000_000n, // 20 Gwei floor; below it the mempool drops the tx silently
  txGasCap: 16_777_216n, // EIP-7825
  defaultPriorityFeeWei: 1_000_000_000n, // 1 Gwei tip (0 accepted)
} as const;

export function clampMaxFeePerGas(estimate: bigint): bigint {
  return estimate < FEE.minMaxFeePerGasWei ? FEE.minMaxFeePerGasWei : estimate;
}

/** Fee in native (18 dp) units, from the receipt. Gas emits no Transfer log. */
export function computeFeeNative18(gasUsed: bigint, effectiveGasPrice: bigint): bigint {
  return gasUsed * effectiveGasPrice;
}
