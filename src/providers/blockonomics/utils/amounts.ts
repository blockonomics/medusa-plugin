export const SATOSHIS_PER_BTC = 100_000_000

/**
 * Converts a fiat amount to satoshis using the price of 1 BTC in that currency.
 */
export function fiatToSatoshis(fiatAmount: number, btcPrice: number): number {
  if (!btcPrice || btcPrice <= 0) {
    throw new Error("A positive BTC price is required to quote an amount")
  }

  return Math.ceil((fiatAmount / btcPrice) * SATOSHIS_PER_BTC)
}

export function satoshisToBtc(satoshis: number): number {
  return satoshis / SATOSHIS_PER_BTC
}

/**
 * The amount that has to arrive for the payment to count as settled, after the
 * merchant's tolerance for a shortfall is applied.
 */
export function minimumAcceptedSatoshis(
  expectedSatoshis: number,
  underpaymentTolerance: number
): number {
  return Math.floor(expectedSatoshis * (1 - underpaymentTolerance))
}

export function isUnderpaid(
  receivedSatoshis: number,
  expectedSatoshis: number,
  underpaymentTolerance: number
): boolean {
  return (
    receivedSatoshis <
    minimumAcceptedSatoshis(expectedSatoshis, underpaymentTolerance)
  )
}

export function isOverpaid(
  receivedSatoshis: number,
  expectedSatoshis: number,
  overpaymentTolerance: number
): boolean {
  return receivedSatoshis > expectedSatoshis * (1 + overpaymentTolerance)
}
