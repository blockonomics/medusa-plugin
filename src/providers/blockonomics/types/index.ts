export enum PaymentProviderKeys {
  BLOCKONOMICS = "blockonomics",
}

/**
 * Options accepted by the Blockonomics payment provider in `medusa-config.ts`.
 */
export interface BlockonomicsOptions {
  /**
   * API key of the Blockonomics merchant account.
   */
  apiKey: string

  /**
   * The secret set on the store's callback URL in the Blockonomics dashboard,
   * e.g. `https://example.com/hooks/blockonomics/blockonomics_blockonomics?secret=SECRET`.
   * Callbacks that don't carry this secret are ignored. Must start with
   * `MEDUSA_`; generate one with `npx medusa-payment-blockonomics`.
   */
  callbackSecret: string

  /**
   * Number of on-chain confirmations a callback has to report before the
   * payment is taken as settled: the amount is recorded, and the order is
   * placed and captured if it covers what was asked. `0` settles a payment as
   * soon as it is seen in the mempool, which is only safe for low-value or
   * reversible fulfilment.
   *
   * @defaultValue 2
   */
  confirmations?: 0 | 1 | 2

  /**
   * How long the quoted BTC amount stays valid, in seconds. Once it expires and
   * nothing has been received, the amount is re-quoted at the current rate.
   * Clamped to 300-1800 seconds.
   *
   * @defaultValue 600
   */
  priceLockSeconds?: number

  /**
   * Fraction of the expected amount that may be missing and still count as paid,
   * covering rounding and wallet fee deductions. `0.01` allows a 1% shortfall.
   *
   * @defaultValue 0
   */
  underpaymentTolerance?: number

  /**
   * Fraction of the expected amount that may be received in excess before the
   * payment is flagged for manual review. The payment is still authorized -
   * Bitcoin cannot be partially returned by the provider.
   *
   * @defaultValue 0.05
   */
  overpaymentTolerance?: number

  /**
   * Substring of the store's callback URL, used by Blockonomics to pick the
   * right store when the account has more than one.
   */
  matchCallback?: string

  /**
   * Base URL of the Blockonomics API. Only useful for testing against a stub.
   *
   * @defaultValue "https://www.blockonomics.co"
   */
  baseUrl?: string
}

/**
 * State of one address handed out for a payment session. Mirrors a row of the
 * Blockonomics WooCommerce plugin's payments table.
 */
export enum BlockonomicsPaymentStatus {
  /**
   * Address handed out, nothing seen yet. The amount can still be re-quoted.
   */
  NEW = 0,
  /**
   * A callback has reported a payment below the required confirmations. The
   * amount is frozen until it settles.
   */
  IN_PROGRESS = 1,
  /**
   * A callback reached the required confirmations. What it paid is recorded
   * in `paid_satoshis` and `paid_fiat`, and never changes again.
   */
  SETTLED = 2,
}

export interface BlockonomicsPayment {
  /**
   * The Bitcoin address this payment goes to.
   */
  address: string

  /**
   * Fiat this address was quoted for: the order total, less what earlier
   * addresses of the session settled.
   */
  expected_fiat: number

  /**
   * `expected_fiat` in satoshis at `btc_price`.
   */
  expected_satoshis: number

  /**
   * Price of 1 BTC in the session's currency at the time of the quote.
   */
  btc_price: number

  /**
   * Epoch milliseconds at which the quoted amount stops being valid.
   */
  price_locked_until: number

  payment_status: BlockonomicsPaymentStatus

  /**
   * Confirmations the latest callback reported, `0` to `2`.
   */
  confirmations: number

  /**
   * What the settling callback reported, in satoshis, and its worth in fiat at
   * the rate this address was quoted at. `0` until settled.
   */
  paid_satoshis: number
  paid_fiat: number

  /**
   * Transaction ID of the payment, once one has been seen.
   */
  txid: string | null
}

/**
 * Shape of the data stored on the payment session and payment.
 */
export interface BlockonomicsPaymentData extends Record<string, unknown> {
  /**
   * The Medusa payment session this data belongs to. Blockonomics has no
   * per-order metadata field, so the mapping is kept on our side.
   */
  session_id?: string

  /**
   * The order total and currency.
   */
  fiat_amount: number
  currency_code: string

  /**
   * Every address handed out for this session, oldest first. The last one is
   * the address the customer is asked to pay; earlier ones are settled
   * underpayments.
   */
  payments: BlockonomicsPayment[]

  /**
   * Fiat settled so far, summed over `payments`.
   */
  paid_fiat: number

  /**
   * The active address and its quote, mirrored from the last of `payments`
   * for storefronts.
   */
  address: string
  expected_fiat: number
  expected_satoshis: number
  btc_price: number
  price_locked_until: number
  payment_status: BlockonomicsPaymentStatus
  confirmations: number
  paid_satoshis: number
  txid: string | null

  /**
   * Set once a settled payment came in short. The storefront asks for the
   * remainder on the next address.
   */
  underpaid?: boolean

  /**
   * Set when more than `overpaymentTolerance` was received.
   */
  overpaid?: boolean

  captured_at?: number | null
  canceled_at?: number | null
}

/**
 * Query parameters Blockonomics sends to the callback URL.
 */
export interface BlockonomicsCallbackPayload {
  secret?: string
  addr?: string
  status?: string | number
  value?: string | number
  txid?: string
  crypto?: string
  /**
   * Only present on unconfirmed transactions that opted into Replace-By-Fee,
   * which the sender can still cancel.
   */
  rbf?: string | number
}
