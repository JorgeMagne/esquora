export const TW_FEE_BPS = 30

export function netAfterFees(amountCents: number, platformBps: number) {
  return Math.round(amountCents * (10_000 - platformBps - TW_FEE_BPS) / 10_000)
}
