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
   * Callbacks that don't carry this secret are ignored.
   */
  callbackSecret: string

  /**
   * Number of on-chain confirmations required before the payment is authorized
   * and the order is placed. `0` accepts a payment as soon as it is seen in the
   * mempool, which is only safe for low-value or reversible fulfilment.
   *
   * Capture always happens at `2` confirmations, which Blockonomics treats as final.
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
 * Shape of the data stored on the payment session and payment.
 */
export interface BlockonomicsPaymentData extends Record<string, unknown> {
  /**
   * The Bitcoin address generated for this payment session.
   */
  address: string

  /**
   * The Medusa payment session this address belongs to. Blockonomics has no
   * per-order metadata field, so the mapping is kept on our side.
   */
  session_id?: string

  /**
   * The fiat amount and currency the quote was derived from.
   */
  fiat_amount: number
  currency_code: string

  /**
   * Price of 1 BTC in `currency_code` at the time of the quote.
   */
  btc_price: number

  /**
   * Amount the customer has to send, in satoshis.
   */
  expected_satoshis: number

  /**
   * Amount received so far, in satoshis, confirmed and unconfirmed.
   */
  received_satoshis: number

  /**
   * Confirmations the payment has as a whole: the highest count at which the
   * transactions with at least that many confirmations add up to the expected
   * amount. `0` while the amount is only reached in the mempool.
   */
  confirmations: number

  /**
   * Set when the expected amount is only reached by counting unconfirmed
   * Replace-By-Fee transactions, which the sender can still replace.
   */
  replaceable?: boolean

  /**
   * Epoch milliseconds at which the quoted amount stops being valid.
   */
  price_locked_until: number

  /**
   * Transaction ID of the payment, once one has been seen.
   */
  txid?: string | null

  /**
   * Transactions paying the address, keyed by transaction ID. Rebuilt from
   * on-chain history on every check when the address is observable, so replaced
   * or double-spent transactions drop out. Addresses handed out in test mode are
   * placeholders that the history endpoint rejects, so for those this is the
   * record of what the callbacks reported.
   */
  transactions?: Record<string, BlockonomicsReportedTransaction>

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

export interface BlockonomicsReportedTransaction {
  satoshis: number
  /**
   * Confirmations, capped at `2`, which Blockonomics treats as final.
   */
  status: number
  /**
   * Whether the transaction opted into Replace-By-Fee. Unknown until checked.
   */
  rbf?: boolean
}

export interface BlockonomicsTransaction {
  txid: string
  value: number
  status?: number
  time?: number
  /**
   * Replace-By-Fee flag on unconfirmed transactions, when the indexer knows it:
   * `0` none, `1` opted in, `2` inherited from an unconfirmed parent.
   */
  rbf?: number | string | null
}
