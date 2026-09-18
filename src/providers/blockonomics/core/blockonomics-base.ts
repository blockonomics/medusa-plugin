import { timingSafeEqual } from "crypto"

import {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"

import {
  BlockonomicsCallbackPayload,
  BlockonomicsOptions,
  BlockonomicsPaymentData,
  BlockonomicsReportedTransaction,
} from "../types"
import {
  BlockonomicsClient,
  fiatToSatoshis,
  isOverpaid,
  isUnderpaid,
} from "../utils"

/**
 * Confirmation count Blockonomics treats as final. A payment is captured at
 * this point regardless of the merchant's authorization threshold.
 */
const FINAL_CONFIRMATIONS = 2

const DEFAULT_CONFIRMATIONS = 2
const DEFAULT_PRICE_LOCK_SECONDS = 600
const MIN_PRICE_LOCK_SECONDS = 300
const MAX_PRICE_LOCK_SECONDS = 1800
const DEFAULT_UNDERPAYMENT_TOLERANCE = 0
const DEFAULT_OVERPAYMENT_TOLERANCE = 0.05

/**
 * Payment session statuses a callback can still move forward, used to narrow
 * the search when mapping a Bitcoin address back to a session. An authorized
 * session is included: with a threshold below final, the callback that reaches
 * final confirmations is what captures it.
 */
const OPEN_SESSION_STATUSES = [
  PaymentSessionStatus.PENDING,
  PaymentSessionStatus.PENDING_AUTHORIZATION,
  PaymentSessionStatus.REQUIRES_MORE,
  PaymentSessionStatus.AUTHORIZED,
]

type InjectedDependencies = {
  logger: Logger
}

abstract class BlockonomicsBase extends AbstractPaymentProvider<BlockonomicsOptions> {
  protected readonly options_: BlockonomicsOptions
  protected readonly logger_: Logger
  protected readonly client_: BlockonomicsClient

  static validateOptions(options: BlockonomicsOptions): void {
    if (!options.apiKey) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "An apiKey is required in the Blockonomics provider's options"
      )
    }

    if (!options.callbackSecret) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "A callbackSecret is required in the Blockonomics provider's options. It must match the secret on the store's callback URL in the Blockonomics dashboard."
      )
    }

    if (
      options.confirmations !== undefined &&
      ![0, 1, 2].includes(options.confirmations)
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "The Blockonomics provider's confirmations option must be 0, 1, or 2"
      )
    }

    for (const key of [
      "underpaymentTolerance",
      "overpaymentTolerance",
    ] as const) {
      const value = options[key]

      if (value !== undefined && (value < 0 || value > 1)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `The Blockonomics provider's ${key} option must be a fraction between 0 and 1`
        )
      }
    }
  }

  protected constructor(
    container: InjectedDependencies,
    options: BlockonomicsOptions
  ) {
    super(container, options)

    this.options_ = options
    this.logger_ = container.logger
    this.client_ = new BlockonomicsClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
    })
  }

  get requiredConfirmations(): number {
    return this.options_.confirmations ?? DEFAULT_CONFIRMATIONS
  }

  get priceLockSeconds(): number {
    const configured =
      this.options_.priceLockSeconds ?? DEFAULT_PRICE_LOCK_SECONDS

    return Math.min(
      MAX_PRICE_LOCK_SECONDS,
      Math.max(MIN_PRICE_LOCK_SECONDS, configured)
    )
  }

  get underpaymentTolerance(): number {
    return this.options_.underpaymentTolerance ?? DEFAULT_UNDERPAYMENT_TOLERANCE
  }

  get overpaymentTolerance(): number {
    return this.options_.overpaymentTolerance ?? DEFAULT_OVERPAYMENT_TOLERANCE
  }

  async initiatePayment({
    amount,
    currency_code,
    data,
  }: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const fiatAmount = new BigNumber(amount).numeric
    const address = await this.client_.newAddress({
      matchCallback: this.options_.matchCallback,
    })
    const btcPrice = await this.client_.getPrice(currency_code)

    const sessionData: BlockonomicsPaymentData = {
      address,
      session_id: data?.session_id as string | undefined,
      fiat_amount: fiatAmount,
      currency_code,
      btc_price: btcPrice,
      expected_satoshis: fiatToSatoshis(fiatAmount, btcPrice),
      received_satoshis: 0,
      confirmations: 0,
      price_locked_until: Date.now() + this.priceLockSeconds * 1000,
      txid: null,
    }

    return {
      // Blockonomics has no order object of its own - the address is what a
      // payment is identified by, in callbacks and in the dashboard alike.
      id: address,
      data: sessionData,
      status: PaymentSessionStatus.PENDING,
    }
  }

  /**
   * Re-quotes the BTC amount when the fiat amount or currency changed, or once
   * the price lock has expired and nothing has been received yet. The address is
   * kept: Blockonomics addresses never expire, and a customer who pays late must
   * not end up paying an address we dropped.
   */
  async updatePayment({
    amount,
    currency_code,
    data,
  }: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const sessionData = this.getSessionData_(data)
    const fiatAmount = new BigNumber(amount).numeric
    const reconciled = await this.reconcile_(sessionData)

    const amountChanged =
      fiatAmount !== sessionData.fiat_amount ||
      currency_code !== sessionData.currency_code
    const quoteExpired = reconciled.price_locked_until <= Date.now()

    // An expired lock alone doesn't re-quote a payment in progress - the customer
    // sent what they were quoted. A changed amount always does, or the order
    // would settle at the old total.
    const requote =
      amountChanged || (quoteExpired && reconciled.received_satoshis === 0)

    if (!requote) {
      return {
        data: reconciled,
        status: this.getStatusFor_(reconciled),
      }
    }

    const btcPrice = await this.client_.getPrice(currency_code)

    const expectedSatoshis = fiatToSatoshis(fiatAmount, btcPrice)
    const requoted: BlockonomicsPaymentData = {
      ...reconciled,
      ...this.settle_(
        Object.values(reconciled.transactions ?? {}),
        expectedSatoshis
      ),
      fiat_amount: fiatAmount,
      currency_code,
      btc_price: btcPrice,
      expected_satoshis: expectedSatoshis,
      price_locked_until: Date.now() + this.priceLockSeconds * 1000,
    }

    return {
      data: requoted,
      status: this.getStatusFor_(requoted),
    }
  }

  async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    return await this.getPaymentStatus(input)
  }

  async getPaymentStatus({
    data,
  }: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const sessionData = this.getSessionData_(data)
    const reconciled = await this.reconcile_(sessionData)

    return {
      data: reconciled,
      status: this.getStatusFor_(reconciled),
    }
  }

  async retrievePayment({
    data,
  }: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const sessionData = this.getSessionData_(data)

    return { data: await this.reconcile_(sessionData) }
  }

  /**
   * Bitcoin arrives in the merchant's wallet directly, so there is nothing to
   * settle with the provider. Capturing records that the payment reached the
   * confirmation count Blockonomics considers final.
   */
  async capturePayment({
    data,
  }: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const sessionData = this.getSessionData_(data)
    const reconciled = await this.reconcile_(sessionData)

    if (
      isUnderpaid(
        reconciled.received_satoshis,
        reconciled.expected_satoshis,
        this.underpaymentTolerance
      )
    ) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Cannot capture ${reconciled.address}: ${reconciled.received_satoshis} of ${reconciled.expected_satoshis} satoshis received`
      )
    }

    return {
      data: {
        ...reconciled,
        captured_at: reconciled.captured_at ?? Date.now(),
      },
    }
  }

  /**
   * Bitcoin payments are irreversible and the provider holds no funds - refunds
   * are a transfer the merchant makes from their own wallet.
   */
  async refundPayment(_: RefundPaymentInput): Promise<RefundPaymentOutput> {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Bitcoin payments cannot be refunded through Blockonomics. Send the refund from the wallet that received the payment and record it outside of Medusa."
    )
  }

  /**
   * Stops tracking the payment. The address stays valid on-chain, so a payment
   * that arrives afterwards is still picked up by the callback and can be
   * reconciled manually.
   */
  async cancelPayment({
    data,
  }: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const sessionData = this.getSessionData_(data, { optional: true })

    if (!sessionData) {
      return { data }
    }

    return {
      data: {
        ...sessionData,
        canceled_at: sessionData.canceled_at ?? Date.now(),
      },
    }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return await this.cancelPayment(input)
  }

  async getWebhookActionAndData({
    data,
  }: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
    const payload = (data ?? {}) as BlockonomicsCallbackPayload

    if (!this.isAuthenticCallback_(payload.secret)) {
      this.logger_.warn(
        "Received a Blockonomics callback with a missing or invalid secret. Ignoring it."
      )
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    // The same callback URL serves every cryptocurrency enabled on the store.
    if (payload.crypto && `${payload.crypto}`.toUpperCase() !== "BTC") {
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    const address = payload.addr

    if (!address) {
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    const session = await this.findSessionByAddress_(address)

    if (!session) {
      this.logger_.warn(
        `Received a Blockonomics callback for ${address}, which does not belong to any open payment session.`
      )
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    const sessionData = this.getSessionData_(session.data)
    const satoshis = this.parseNumber_(payload.value)
    const reconciled = await this.reconcile_(
      sessionData,
      payload.txid && satoshis !== undefined
        ? {
            txid: payload.txid,
            satoshis,
            status: this.parseNumber_(payload.status) ?? 0,
            // Only sent on unconfirmed transactions that opted into
            // Replace-By-Fee, so its absence doesn't rule RBF out.
            rbf: payload.rbf !== undefined ? true : undefined,
          }
        : undefined
    )

    // Only the action and the session id travel back to the payment module, so
    // what the callback reported is written to the session here. Without it, the
    // authorization that follows would re-read a session that has no record of
    // this transaction - which is all there is to go on for an address that
    // isn't observable on-chain.
    await this.persistSessionData_(session.id, reconciled)

    const webhookData = {
      session_id: session.id,
      amount: reconciled.fiat_amount,
    }

    switch (this.getStatusFor_(reconciled)) {
      case PaymentSessionStatus.CAPTURED:
        return { action: PaymentActions.SUCCESSFUL, data: webhookData }
      case PaymentSessionStatus.AUTHORIZED:
        return { action: PaymentActions.AUTHORIZED, data: webhookData }
      default:
        return {
          action: PaymentActions.PENDING_AUTHORIZATION,
          data: webhookData,
        }
    }
  }

  /**
   * Works out which transactions pay the address and how settled they are.
   *
   * When the address is observable on-chain, its history is the source of truth
   * and the transaction list is rebuilt from it on every check, so a transaction
   * that was replaced or double-spent drops out rather than lingering. Only
   * incoming transactions count - the merchant's wallet spending the coins later
   * doesn't undo the payment. The transaction a callback reports is added if the
   * history doesn't list it yet, covering indexing lag.
   *
   * An address handed out in test mode is not on-chain at all, so what the
   * callbacks reported is all there is to go on.
   */
  protected async reconcile_(
    sessionData: BlockonomicsPaymentData,
    reported?: { txid: string } & BlockonomicsReportedTransaction
  ): Promise<BlockonomicsPaymentData> {
    const known = sessionData.transactions ?? {}
    const history = await this.client_.getHistory(sessionData.address)

    let transactions: Record<string, BlockonomicsReportedTransaction>

    if (history) {
      transactions = {}

      for (const [tx, status] of [
        ...history.pending.map((tx) => [tx, tx.status ?? 0] as const),
        ...history.history.map((tx) => [tx, FINAL_CONFIRMATIONS] as const),
      ]) {
        if (tx.value > 0) {
          transactions[tx.txid] = {
            satoshis: tx.value,
            status: Math.min(status, FINAL_CONFIRMATIONS),
            rbf:
              tx.rbf === undefined || tx.rbf === null
                ? known[tx.txid]?.rbf
                : Number(tx.rbf) > 0,
          }
        }
      }
    } else {
      transactions = { ...known }
    }

    if (reported) {
      const existing = transactions[reported.txid]

      transactions[reported.txid] = {
        // The chain's value wins; the callback's is only used until it shows up.
        satoshis: existing?.satoshis ?? reported.satoshis,
        status: Math.min(
          Math.max(existing?.status ?? 0, reported.status),
          FINAL_CONFIRMATIONS
        ),
        rbf: reported.rbf ?? existing?.rbf,
      }
    }

    // RBF only matters for a transaction accepted at 0 confirmations, so the
    // extra lookup is limited to merchants who accept those, and to transactions
    // the history didn't already flag.
    if (history && this.requiredConfirmations === 0) {
      await Promise.all(
        Object.entries(transactions)
          .filter(([, tx]) => tx.status === 0 && tx.rbf === undefined)
          .map(async ([txid, tx]) => {
            tx.rbf = await this.client_.isReplaceable(txid)
          })
      )
    }

    const txid =
      reported?.txid ??
      history?.pending[0]?.txid ??
      history?.history[0]?.txid ??
      Object.keys(transactions)[0] ??
      sessionData.txid ??
      null

    return {
      ...sessionData,
      ...this.settle_(
        Object.values(transactions),
        sessionData.expected_satoshis
      ),
      transactions,
      txid,
    }
  }

  /**
   * Totals the transactions and works out how many confirmations the payment
   * has as a whole. That is not the most-confirmed transaction: a small
   * confirmed transaction alongside a large unconfirmed one is not a confirmed
   * payment. It is the highest count at which the transactions with at least that
   * many confirmations still cover the expected amount. Unconfirmed
   * Replace-By-Fee transactions never count towards it.
   */
  protected settle_(
    transactions: BlockonomicsReportedTransaction[],
    expectedSatoshis: number
  ): Pick<
    BlockonomicsPaymentData,
    "received_satoshis" | "confirmations" | "replaceable" | "overpaid"
  > {
    const sum = (txs: BlockonomicsReportedTransaction[]) =>
      txs.reduce((total, tx) => total + tx.satoshis, 0)
    const covers = (satoshis: number) =>
      !isUnderpaid(satoshis, expectedSatoshis, this.underpaymentTolerance)

    const receivedSatoshis = sum(transactions)

    let confirmations: number | undefined

    for (let count = FINAL_CONFIRMATIONS; count >= 0; count--) {
      const counted = transactions.filter(
        (tx) => tx.status >= count && !(tx.status === 0 && tx.rbf)
      )

      if (covers(sum(counted))) {
        confirmations = count
        break
      }
    }

    return {
      received_satoshis: receivedSatoshis,
      confirmations: confirmations ?? 0,
      replaceable: confirmations === undefined && covers(receivedSatoshis),
      overpaid: isOverpaid(
        receivedSatoshis,
        expectedSatoshis,
        this.overpaymentTolerance
      ),
    }
  }

  /**
   * Maps the state of the address onto a payment session status. Anything short
   * of a settled payment stays in `pending_authorization`: the customer may
   * still send the remainder, and the address keeps accepting it.
   */
  protected getStatusFor_(
    sessionData: BlockonomicsPaymentData
  ): PaymentSessionStatus {
    if (sessionData.canceled_at) {
      return PaymentSessionStatus.CANCELED
    }

    // Nothing has arrived: the session is waiting for the customer, not for
    // the network, so a re-quote keeps it where `initiatePayment` left it.
    if (!sessionData.received_satoshis) {
      return PaymentSessionStatus.PENDING
    }

    if (
      isUnderpaid(
        sessionData.received_satoshis,
        sessionData.expected_satoshis,
        this.underpaymentTolerance
      )
    ) {
      return PaymentSessionStatus.PENDING_AUTHORIZATION
    }

    // The sender can still replace the transactions that make up the amount.
    if (sessionData.replaceable) {
      return PaymentSessionStatus.PENDING_AUTHORIZATION
    }

    if (sessionData.confirmations >= FINAL_CONFIRMATIONS) {
      return PaymentSessionStatus.CAPTURED
    }

    if (sessionData.confirmations >= this.requiredConfirmations) {
      return PaymentSessionStatus.AUTHORIZED
    }

    return PaymentSessionStatus.PENDING_AUTHORIZATION
  }

  protected isAuthenticCallback_(secret?: string): boolean {
    if (!secret) {
      return false
    }

    const provided = Buffer.from(secret)
    const expected = Buffer.from(this.options_.callbackSecret)

    if (provided.length !== expected.length) {
      return false
    }

    return timingSafeEqual(provided, expected)
  }

  /**
   * Blockonomics identifies a payment by its address and has no field to carry
   * the Medusa session id back to us, so the session is looked up by the address
   * stored on it when the callback arrives.
   */
  protected async findSessionByAddress_(
    address: string
  ): Promise<{ id: string; data: Record<string, unknown> } | undefined> {
    const paymentSessionService = (this.container as Record<string, any>)
      .paymentSessionService

    if (!paymentSessionService) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Could not resolve payment sessions to match the Blockonomics callback against"
      )
    }

    // Filtering on the JSON column keeps this to the matching row instead of
    // loading every open session in the store.
    const sessions: { id: string; data: Record<string, unknown> }[] =
      await paymentSessionService.list(
        { status: OPEN_SESSION_STATUSES, data: { address } },
        { select: ["id", "data"] }
      )

    return sessions.find(
      (session) =>
        (session.data as BlockonomicsPaymentData | undefined)?.address ===
        address
    )
  }

  protected async persistSessionData_(
    sessionId: string,
    data: BlockonomicsPaymentData
  ): Promise<void> {
    const paymentSessionService = (this.container as Record<string, any>)
      .paymentSessionService

    try {
      await paymentSessionService.update({ id: sessionId, data })
    } catch (error) {
      // The payment can still be settled from the address' history on the next
      // status check, so a failure to record the callback is not fatal.
      this.logger_.warn(
        `Could not record the Blockonomics callback on payment session ${sessionId}: ${error.message}`
      )
    }
  }

  protected getSessionData_(
    data: Record<string, unknown> | undefined,
    options: { optional?: boolean } = {}
  ): BlockonomicsPaymentData {
    const sessionData = data as BlockonomicsPaymentData | undefined

    if (!sessionData?.address) {
      if (options.optional) {
        return undefined as unknown as BlockonomicsPaymentData
      }

      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "The payment session is missing the Bitcoin address it was initiated with"
      )
    }

    return sessionData
  }

  protected parseNumber_(value: unknown): number | undefined {
    const parsed = Number(value)

    return Number.isFinite(parsed) ? parsed : undefined
  }
}

export default BlockonomicsBase
