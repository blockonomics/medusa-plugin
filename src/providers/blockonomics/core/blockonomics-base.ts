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
  BlockonomicsPayment,
  BlockonomicsPaymentData,
  BlockonomicsPaymentStatus,
} from "../types"
import {
  BlockonomicsClient,
  fiatToSatoshis,
  isOverpaid,
  isUnderpaid,
} from "../utils"

const DEFAULT_CONFIRMATIONS = 2
const DEFAULT_PRICE_LOCK_SECONDS = 600
const MIN_PRICE_LOCK_SECONDS = 300
const MAX_PRICE_LOCK_SECONDS = 1800
const DEFAULT_UNDERPAYMENT_TOLERANCE = 0
const DEFAULT_OVERPAYMENT_TOLERANCE = 0.05

/** Marks callback secrets as coming from this plugin, like WHMCS_ for WHMCS. */
const CALLBACK_SECRET_PREFIX = "MEDUSA_"

/**
 * Decimal places fiat amounts are kept to, matching what the store shows.
 */
const FIAT_DECIMALS = 2

/**
 * Payment session statuses a callback can still move forward, used to narrow
 * the search when mapping a Bitcoin address back to a session.
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

/**
 * Follows the payment model of the Blockonomics WooCommerce plugin. Every
 * address handed out for a session is a payment row with its own fiat quote;
 * the callback that reaches the configured confirmations settles the row and
 * records what it paid, in satoshis and in fiat at the row's rate. When a
 * settled row came in short, the remainder is quoted on a fresh address at the
 * current rate, and the session is complete once the settled rows add up to
 * the order total.
 */
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
      !options.callbackSecret.startsWith(CALLBACK_SECRET_PREFIX) ||
      options.callbackSecret.length === CALLBACK_SECRET_PREFIX.length
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `The callbackSecret must start with "${CALLBACK_SECRET_PREFIX}". Generate one with \`npx blockonomics-callback-secret\`.`
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
    const fiatAmount = roundFiat(new BigNumber(amount).numeric)
    const payment = await this.newPayment_(fiatAmount, currency_code)

    const sessionData = this.withActivePayment_({
      session_id: data?.session_id as string | undefined,
      fiat_amount: fiatAmount,
      currency_code,
      payments: [payment],
    })

    return {
      // Blockonomics has no order object of its own - the address is what a
      // payment is identified by, in callbacks and in the dashboard alike.
      id: payment.address,
      data: sessionData,
      status: PaymentSessionStatus.PENDING,
    }
  }

  /**
   * Brings the active address' quote up to date, the way the WooCommerce plugin
   * does when its checkout page loads:
   *
   * - nothing seen yet: re-quote the outstanding fiat at the current rate once
   *   the price lock has expired or the order total changed. The address stays.
   * - payment in progress: leave it alone - the customer sent what was quoted.
   * - settled short: hand out a new address for the remainder at the current
   *   rate. The settled row stays as the record of the partial payment.
   */
  async updatePayment({
    amount,
    currency_code,
    data,
  }: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const sessionData = this.getSessionData_(data)
    const fiatAmount = roundFiat(new BigNumber(amount).numeric)
    const payments = [...sessionData.payments]
    const active = payments[payments.length - 1]

    const totalChanged =
      fiatAmount !== sessionData.fiat_amount ||
      currency_code !== sessionData.currency_code
    const outstanding = roundFiat(fiatAmount - sumPaidFiat(payments))

    let updated: BlockonomicsPaymentData

    if (active.payment_status === BlockonomicsPaymentStatus.NEW) {
      const quoteExpired = active.price_locked_until <= Date.now()

      if (totalChanged || quoteExpired) {
        payments[payments.length - 1] = await this.quotePayment_(
          active,
          outstanding,
          currency_code
        )
      }

      updated = this.withActivePayment_({
        ...sessionData,
        fiat_amount: fiatAmount,
        currency_code,
        payments,
      })
    } else if (
      active.payment_status === BlockonomicsPaymentStatus.SETTLED &&
      this.isShort_(active) &&
      outstanding > 0
    ) {
      payments.push(await this.newPayment_(outstanding, currency_code))

      updated = this.withActivePayment_({
        ...sessionData,
        fiat_amount: fiatAmount,
        currency_code,
        payments,
      })
    } else {
      updated = this.withActivePayment_({
        ...sessionData,
        fiat_amount: fiatAmount,
        currency_code,
        payments,
      })
    }

    return {
      data: updated,
      status: this.getStatusFor_(updated),
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
    const sessionData = this.withActivePayment_(this.getSessionData_(data))

    return {
      data: sessionData,
      status: this.getStatusFor_(sessionData),
    }
  }

  async retrievePayment({
    data,
  }: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    return { data: this.withActivePayment_(this.getSessionData_(data)) }
  }

  /**
   * Bitcoin arrives in the merchant's wallet directly, so there is nothing to
   * settle with the provider. Capturing records that the settled payments
   * cover the order.
   */
  async capturePayment({
    data,
  }: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const sessionData = this.withActivePayment_(this.getSessionData_(data))

    if (!this.isPaid_(sessionData)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Cannot capture ${sessionData.address}: ${sessionData.paid_fiat} of ${sessionData.fiat_amount} ${sessionData.currency_code} settled`
      )
    }

    return {
      data: {
        ...sessionData,
        captured_at: sessionData.captured_at ?? Date.now(),
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

  /**
   * Processes a callback the way the WooCommerce plugin does: an unconfirmed
   * Replace-By-Fee transaction only has its id recorded, since the sender can
   * still cancel it; anything below the required confirmations marks the
   * address as paid-in-progress; reaching them settles the address with what
   * the callback reported. A settled address ignores further callbacks.
   */
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
    const payments = sessionData.payments.map((payment) =>
      payment.address === address
        ? this.applyCallback_(payment, payload)
        : payment
    )

    const updated = this.withActivePayment_({ ...sessionData, payments })

    // Only the action and the session id travel back to the payment module, so
    // what the callback reported is written to the session here. Without it, the
    // authorization that follows would re-read a session that has no record of
    // this payment.
    await this.persistSessionData_(session.id, updated)

    const webhookData = {
      session_id: session.id,
      amount: updated.fiat_amount,
    }

    switch (this.getStatusFor_(updated)) {
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

  protected applyCallback_(
    payment: BlockonomicsPayment,
    payload: BlockonomicsCallbackPayload
  ): BlockonomicsPayment {
    const txid = payload.txid ?? payment.txid

    if (payment.payment_status === BlockonomicsPaymentStatus.SETTLED) {
      return payment
    }

    // Only sent on unconfirmed transactions that opted into Replace-By-Fee.
    if (payload.rbf !== undefined) {
      return { ...payment, txid }
    }

    const status = this.parseNumber_(payload.status) ?? 0
    const satoshis = this.parseNumber_(payload.value) ?? 0

    if (status < this.requiredConfirmations) {
      return {
        ...payment,
        txid,
        confirmations: status,
        payment_status: BlockonomicsPaymentStatus.IN_PROGRESS,
      }
    }

    return {
      ...payment,
      txid,
      confirmations: status,
      payment_status: BlockonomicsPaymentStatus.SETTLED,
      paid_satoshis: satoshis,
      // What the customer sent is worth what it was quoted at, whatever the
      // rate has done since.
      paid_fiat: roundFiat(
        (payment.expected_fiat * satoshis) / payment.expected_satoshis
      ),
    }
  }

  protected async newPayment_(
    fiatAmount: number,
    currencyCode: string
  ): Promise<BlockonomicsPayment> {
    const address = await this.client_.newAddress({
      matchCallback: this.options_.matchCallback,
    })

    return await this.quotePayment_(
      {
        address,
        expected_fiat: fiatAmount,
        expected_satoshis: 0,
        btc_price: 0,
        price_locked_until: 0,
        payment_status: BlockonomicsPaymentStatus.NEW,
        confirmations: 0,
        paid_satoshis: 0,
        paid_fiat: 0,
        txid: null,
      },
      fiatAmount,
      currencyCode
    )
  }

  protected async quotePayment_(
    payment: BlockonomicsPayment,
    fiatAmount: number,
    currencyCode: string
  ): Promise<BlockonomicsPayment> {
    const btcPrice = await this.client_.getPrice(currencyCode)

    return {
      ...payment,
      expected_fiat: fiatAmount,
      expected_satoshis: fiatToSatoshis(fiatAmount, btcPrice),
      btc_price: btcPrice,
      price_locked_until: Date.now() + this.priceLockSeconds * 1000,
    }
  }

  /**
   * Mirrors the active payment onto the session data, so storefronts read the
   * address and quote from the top level.
   */
  protected withActivePayment_(
    sessionData: Pick<
      BlockonomicsPaymentData,
      "fiat_amount" | "currency_code" | "payments"
    > &
      Partial<BlockonomicsPaymentData>
  ): BlockonomicsPaymentData {
    const payments = sessionData.payments
    const active = payments[payments.length - 1]
    const settled = payments.filter(
      (payment) => payment.payment_status === BlockonomicsPaymentStatus.SETTLED
    )

    return {
      ...sessionData,
      payments,
      paid_fiat: sumPaidFiat(payments),
      address: active.address,
      expected_fiat: active.expected_fiat,
      expected_satoshis: active.expected_satoshis,
      btc_price: active.btc_price,
      price_locked_until: active.price_locked_until,
      payment_status: active.payment_status,
      confirmations: active.confirmations,
      paid_satoshis: active.paid_satoshis,
      txid: active.txid,
      underpaid: settled.some((payment) => this.isShort_(payment)),
      overpaid: settled.some((payment) =>
        isOverpaid(
          payment.paid_satoshis,
          payment.expected_satoshis,
          this.overpaymentTolerance
        )
      ),
    }
  }

  /**
   * Whether a settled payment came in below what its address was quoted for,
   * after the merchant's tolerance.
   */
  protected isShort_(payment: BlockonomicsPayment): boolean {
    return isUnderpaid(
      payment.paid_satoshis,
      payment.expected_satoshis,
      this.underpaymentTolerance
    )
  }

  /**
   * The order is paid once the last address settled in full: each address is
   * quoted for whatever the earlier ones left outstanding.
   */
  protected isPaid_(sessionData: BlockonomicsPaymentData): boolean {
    const active = sessionData.payments[sessionData.payments.length - 1]

    return (
      active.payment_status === BlockonomicsPaymentStatus.SETTLED &&
      !this.isShort_(active)
    )
  }

  /**
   * Maps the session onto a payment session status. Anything short of a settled
   * payment stays in `pending_authorization`: the customer may still send the
   * remainder, and a settled shortfall gets a new address for it.
   */
  protected getStatusFor_(
    sessionData: BlockonomicsPaymentData
  ): PaymentSessionStatus {
    if (sessionData.canceled_at) {
      return PaymentSessionStatus.CANCELED
    }

    if (this.isPaid_(sessionData)) {
      return PaymentSessionStatus.CAPTURED
    }

    const active = sessionData.payments[sessionData.payments.length - 1]

    if (
      active.payment_status === BlockonomicsPaymentStatus.NEW &&
      sessionData.payments.length === 1
    ) {
      return PaymentSessionStatus.PENDING
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
   * the Medusa session id back to us, so the session is looked up by the
   * address stored on it when the callback arrives. Only the active address is
   * indexed; a settled address ignores callbacks anyway.
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

    if (!sessionData?.payments?.length) {
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

function roundFiat(amount: number): number {
  return Number(amount.toFixed(FIAT_DECIMALS))
}

function sumPaidFiat(payments: BlockonomicsPayment[]): number {
  return roundFiat(
    payments.reduce((total, payment) => total + payment.paid_fiat, 0)
  )
}

export default BlockonomicsBase
