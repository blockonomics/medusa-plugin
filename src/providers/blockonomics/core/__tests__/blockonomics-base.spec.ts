import { PaymentActions, PaymentSessionStatus } from "@medusajs/framework/utils"

import BlockonomicsProviderService from "../../services/blockonomics-provider"
import { BlockonomicsOptions, BlockonomicsPaymentData } from "../../types"

const ADDRESS = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
const CALLBACK_SECRET = "callback-secret"
const BTC_PRICE = 100_000

const baseOptions: BlockonomicsOptions = {
  apiKey: "api-key",
  callbackSecret: CALLBACK_SECRET,
}

const container = {
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
  paymentSessionService: {
    list: jest.fn(),
    update: jest.fn(),
  },
} as any

const buildClient = ({
  pending = [] as {
    txid: string
    value: number
    status?: number
    rbf?: number
  }[],
  history = [] as { txid: string; value: number }[],
  replaceable = false,
} = {}) => ({
  newAddress: jest.fn().mockResolvedValue(ADDRESS),
  getPrice: jest.fn().mockResolvedValue(BTC_PRICE),
  getHistory: jest.fn().mockResolvedValue({ pending, history }),
  isReplaceable: jest.fn().mockResolvedValue(replaceable),
})

/**
 * Test-mode addresses are placeholders that the history endpoint rejects, so
 * the client reports them as not observable.
 */
const buildUnobservableClient = () => ({
  newAddress: jest.fn().mockResolvedValue(ADDRESS),
  getPrice: jest.fn().mockResolvedValue(BTC_PRICE),
  getHistory: jest.fn().mockResolvedValue(undefined),
  isReplaceable: jest.fn().mockResolvedValue(false),
})

const buildProvider = (
  options: Partial<BlockonomicsOptions> = {},
  client = buildClient()
) => {
  const provider = new BlockonomicsProviderService(container, {
    ...baseOptions,
    ...options,
  })

  // The client is created in the constructor, so it is swapped out here rather
  // than mocking the module.
  ;(provider as any).client_ = client

  return { provider, client }
}

const sessionData = (
  overrides: Partial<BlockonomicsPaymentData> = {}
): BlockonomicsPaymentData => ({
  address: ADDRESS,
  session_id: "payses_1",
  fiat_amount: 100,
  currency_code: "usd",
  btc_price: BTC_PRICE,
  expected_satoshis: 100_000,
  received_satoshis: 0,
  confirmations: 0,
  price_locked_until: Date.now() + 600_000,
  txid: null,
  ...overrides,
})

describe("BlockonomicsProviderService", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("validateOptions", () => {
    it("requires an api key and a callback secret", () => {
      expect(() =>
        BlockonomicsProviderService.validateOptions({
          callbackSecret: CALLBACK_SECRET,
        } as BlockonomicsOptions)
      ).toThrow(/apiKey is required/)

      expect(() =>
        BlockonomicsProviderService.validateOptions({
          apiKey: "api-key",
        } as BlockonomicsOptions)
      ).toThrow(/callbackSecret is required/)
    })

    it("rejects a confirmation threshold above the final count", () => {
      expect(() =>
        BlockonomicsProviderService.validateOptions({
          ...baseOptions,
          confirmations: 3 as never,
        })
      ).toThrow(/must be 0, 1, or 2/)
    })

    it("rejects a tolerance outside of 0-1", () => {
      expect(() =>
        BlockonomicsProviderService.validateOptions({
          ...baseOptions,
          underpaymentTolerance: 1.5,
        })
      ).toThrow(/fraction between 0 and 1/)
    })
  })

  describe("initiatePayment", () => {
    it("quotes the fiat amount in satoshis and keys the session by address", async () => {
      const { provider, client } = buildProvider()

      const result = await provider.initiatePayment({
        amount: 100,
        currency_code: "usd",
        data: { session_id: "payses_1" },
      })

      expect(client.getPrice).toHaveBeenCalledWith("usd")
      expect(result.id).toEqual(ADDRESS)
      expect(result.status).toEqual(PaymentSessionStatus.PENDING)
      expect(result.data).toEqual(
        expect.objectContaining({
          address: ADDRESS,
          session_id: "payses_1",
          btc_price: BTC_PRICE,
          // 100 USD at 100,000 USD/BTC is 0.001 BTC
          expected_satoshis: 100_000,
          received_satoshis: 0,
        })
      )
    })
  })

  describe("getPaymentStatus", () => {
    it("stays pending while less than the expected amount has arrived", async () => {
      const { provider } = buildProvider(
        {},
        buildClient({
          pending: [{ txid: "tx", value: 40_000, status: 0 }],
        })
      )

      const result = await provider.getPaymentStatus({ data: sessionData() })

      expect(result.status).toEqual(PaymentSessionStatus.PENDING_AUTHORIZATION)
      expect(result.data).toEqual(
        expect.objectContaining({ received_satoshis: 40_000 })
      )
    })

    it("authorizes once the merchant's confirmation threshold is met", async () => {
      const { provider } = buildProvider(
        { confirmations: 1 },
        buildClient({
          pending: [{ txid: "tx", value: 100_000, status: 1 }],
        })
      )

      const result = await provider.getPaymentStatus({ data: sessionData() })

      expect(result.status).toEqual(PaymentSessionStatus.AUTHORIZED)
    })

    it("captures once the payment is final on-chain", async () => {
      const { provider } = buildProvider(
        { confirmations: 1 },
        buildClient({
          history: [{ txid: "tx", value: 100_000 }],
        })
      )

      const result = await provider.getPaymentStatus({ data: sessionData() })

      expect(result.status).toEqual(PaymentSessionStatus.CAPTURED)
      expect(result.data).toEqual(
        expect.objectContaining({ confirmations: 2, txid: "tx" })
      )
    })

    it("accepts a shortfall within the merchant's tolerance", async () => {
      const { provider } = buildProvider(
        { confirmations: 0, underpaymentTolerance: 0.01 },
        buildClient({
          pending: [{ txid: "tx", value: 99_500, status: 0 }],
        })
      )

      const result = await provider.getPaymentStatus({ data: sessionData() })

      expect(result.status).toEqual(PaymentSessionStatus.AUTHORIZED)
    })

    it("flags a payment that exceeds the overpayment tolerance", async () => {
      const { provider } = buildProvider(
        { confirmations: 0, overpaymentTolerance: 0.05 },
        buildClient({
          pending: [{ txid: "tx", value: 200_000, status: 0 }],
        })
      )

      const result = await provider.getPaymentStatus({ data: sessionData() })

      expect(result.status).toEqual(PaymentSessionStatus.AUTHORIZED)
      expect(result.data).toEqual(expect.objectContaining({ overpaid: true }))
    })

    it("does not treat a payment as confirmed because a small part of it is", async () => {
      const { provider } = buildProvider(
        {},
        buildClient({
          pending: [{ txid: "large", value: 90_000, status: 0 }],
          history: [{ txid: "small", value: 10_000 }],
        })
      )

      const result = await provider.getPaymentStatus({ data: sessionData() })

      expect(result.status).toEqual(PaymentSessionStatus.PENDING_AUTHORIZATION)
      expect(result.data).toEqual(
        expect.objectContaining({ received_satoshis: 100_000, confirmations: 0 })
      )
    })

    it("does not authorize an unconfirmed replace-by-fee payment at 0 confirmations", async () => {
      const { provider, client } = buildProvider(
        { confirmations: 0 },
        buildClient({
          pending: [{ txid: "tx", value: 100_000, status: 0 }],
          replaceable: true,
        })
      )

      const result = await provider.authorizePayment({ data: sessionData() })

      expect(client.isReplaceable).toHaveBeenCalledWith("tx")
      expect(result.status).toEqual(PaymentSessionStatus.PENDING_AUTHORIZATION)
      expect(result.data).toEqual(expect.objectContaining({ replaceable: true }))
    })

    it("takes the replace-by-fee flag from the history when it carries one", async () => {
      const { provider, client } = buildProvider(
        { confirmations: 0 },
        buildClient({
          pending: [
            { txid: "opt-in", value: 50_000, status: 0, rbf: 1 },
            { txid: "final", value: 50_000, status: 0, rbf: 0 },
          ],
        })
      )

      const result = await provider.getPaymentStatus({ data: sessionData() })

      expect(client.isReplaceable).not.toHaveBeenCalled()
      expect(result.status).toEqual(PaymentSessionStatus.PENDING_AUTHORIZATION)
      expect(result.data).toEqual(expect.objectContaining({ replaceable: true }))
    })

    it("skips the replace-by-fee lookup when 0 confirmations aren't accepted", async () => {
      const { provider, client } = buildProvider(
        { confirmations: 1 },
        buildClient({ pending: [{ txid: "tx", value: 100_000, status: 0 }] })
      )

      await provider.getPaymentStatus({ data: sessionData() })

      expect(client.isReplaceable).not.toHaveBeenCalled()
    })

    it("counts what was received, not what the address still holds", async () => {
      const { provider } = buildProvider(
        {},
        buildClient({
          history: [
            { txid: "spend", value: -100_000 },
            { txid: "tx", value: 100_000 },
          ],
        })
      )

      const result = await provider.capturePayment({ data: sessionData() })

      expect(result.data).toEqual(
        expect.objectContaining({ received_satoshis: 100_000 })
      )
    })

    it("drops a reported transaction the chain no longer has", async () => {
      const { provider } = buildProvider({}, buildClient())

      const result = await provider.getPaymentStatus({
        data: sessionData({
          transactions: { replaced: { satoshis: 100_000, status: 0 } },
        }),
      })

      expect(result.status).toEqual(PaymentSessionStatus.PENDING_AUTHORIZATION)
      expect(result.data).toEqual(
        expect.objectContaining({ received_satoshis: 0, transactions: {} })
      )
    })
  })

  describe("updatePayment", () => {
    it("re-quotes an expired price lock when nothing has been received", async () => {
      const client = buildClient()
      client.getPrice.mockResolvedValue(50_000)
      const { provider } = buildProvider({}, client)

      const result = await provider.updatePayment({
        amount: 100,
        currency_code: "usd",
        data: sessionData({ price_locked_until: Date.now() - 1_000 }),
      })

      expect(result.data).toEqual(
        expect.objectContaining({
          address: ADDRESS,
          btc_price: 50_000,
          expected_satoshis: 200_000,
        })
      )
    })

    it("keeps the original quote once the customer has started paying", async () => {
      const client = buildClient({
        pending: [{ txid: "tx", value: 50_000, status: 0 }],
      })
      const { provider } = buildProvider({}, client)

      const result = await provider.updatePayment({
        amount: 100,
        currency_code: "usd",
        data: sessionData({ price_locked_until: Date.now() - 1_000 }),
      })

      expect(client.getPrice).not.toHaveBeenCalled()
      expect(result.data).toEqual(
        expect.objectContaining({ expected_satoshis: 100_000 })
      )
    })

    it("re-quotes a changed total even once the customer has started paying", async () => {
      const client = buildClient({
        pending: [{ txid: "tx", value: 100_000, status: 0 }],
      })
      const { provider } = buildProvider({ confirmations: 0 }, client)

      const result = await provider.updatePayment({
        amount: 150,
        currency_code: "usd",
        data: sessionData(),
      })

      expect(client.getPrice).toHaveBeenCalledWith("usd")
      expect(result.status).toEqual(PaymentSessionStatus.PENDING_AUTHORIZATION)
      expect(result.data).toEqual(
        expect.objectContaining({
          fiat_amount: 150,
          expected_satoshis: 150_000,
          received_satoshis: 100_000,
        })
      )
    })
  })

  describe("refundPayment", () => {
    it("refuses to refund on-chain", async () => {
      const { provider } = buildProvider()

      await expect(
        provider.refundPayment({ amount: 100, data: sessionData() })
      ).rejects.toThrow(/cannot be refunded through Blockonomics/)
    })
  })

  describe("capturePayment", () => {
    it("refuses to capture an underpaid address", async () => {
      const { provider } = buildProvider(
        {},
        buildClient({
          pending: [{ txid: "tx", value: 10_000, status: 0 }],
        })
      )

      await expect(
        provider.capturePayment({ data: sessionData() })
      ).rejects.toThrow(/10000 of 100000 satoshis received/)
    })
  })

  describe("getWebhookActionAndData", () => {
    const callback = (overrides: Record<string, unknown> = {}) => ({
      data: {
        secret: CALLBACK_SECRET,
        addr: ADDRESS,
        status: 2,
        value: 100_000,
        txid: "tx",
        ...overrides,
      },
      rawData: Buffer.from(""),
      headers: {},
    })

    beforeEach(() => {
      container.paymentSessionService.list.mockResolvedValue([
        { id: "payses_1", data: sessionData() },
      ])
    })

    it("ignores a callback carrying the wrong secret", async () => {
      const { provider } = buildProvider()

      const result = await provider.getWebhookActionAndData(
        callback({ secret: "not-the-secret" })
      )

      expect(result.action).toEqual(PaymentActions.NOT_SUPPORTED)
      expect(container.paymentSessionService.list).not.toHaveBeenCalled()
    })

    it("ignores callbacks for other cryptocurrencies", async () => {
      const { provider } = buildProvider()

      const result = await provider.getWebhookActionAndData(
        callback({ crypto: "USDT" })
      )

      expect(result.action).toEqual(PaymentActions.NOT_SUPPORTED)
    })

    it("ignores an address that belongs to no open session", async () => {
      container.paymentSessionService.list.mockResolvedValue([])
      const { provider } = buildProvider()

      const result = await provider.getWebhookActionAndData(callback())

      expect(result.action).toEqual(PaymentActions.NOT_SUPPORTED)
    })

    it("captures a fully confirmed payment", async () => {
      const { provider } = buildProvider(
        {},
        buildClient({
          history: [{ txid: "tx", value: 100_000 }],
        })
      )

      const result = await provider.getWebhookActionAndData(callback())

      expect(result.action).toEqual(PaymentActions.SUCCESSFUL)
      expect(result.data).toEqual({ session_id: "payses_1", amount: 100 })
    })

    it("authorizes at the merchant's threshold before the payment is final", async () => {
      const { provider } = buildProvider(
        { confirmations: 1 },
        buildClient({
          pending: [{ txid: "tx", value: 100_000, status: 1 }],
        })
      )

      const result = await provider.getWebhookActionAndData(
        callback({ status: 1 })
      )

      expect(result.action).toEqual(PaymentActions.AUTHORIZED)
    })

    it("does not settle an unconfirmed replace-by-fee transaction", async () => {
      const { provider } = buildProvider(
        { confirmations: 0 },
        buildClient({
          pending: [{ txid: "tx", value: 100_000, status: 0 }],
        })
      )

      const result = await provider.getWebhookActionAndData(
        callback({ status: 0, rbf: 1 })
      )

      expect(result.action).toEqual(PaymentActions.PENDING_AUTHORIZATION)
    })

    it("settles a test-mode payment from the callback alone", async () => {
      const { provider } = buildProvider({}, buildUnobservableClient())

      const result = await provider.getWebhookActionAndData(callback())

      expect(result.action).toEqual(PaymentActions.SUCCESSFUL)
      expect(container.paymentSessionService.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "payses_1",
          data: expect.objectContaining({
            received_satoshis: 100_000,
            confirmations: 2,
          }),
        })
      )
    })

    it("adds up several callbacks against an address that is not observable", async () => {
      const { provider } = buildProvider({}, buildUnobservableClient())

      const first = await provider.getWebhookActionAndData(
        callback({ status: 2, value: 60_000, txid: "tx-a" })
      )
      expect(first.action).toEqual(PaymentActions.PENDING_AUTHORIZATION)

      // The session now carries what the first callback reported.
      const afterFirst =
        container.paymentSessionService.update.mock.calls.at(-1)[0].data
      container.paymentSessionService.list.mockResolvedValue([
        { id: "payses_1", data: afterFirst },
      ])

      const second = await provider.getWebhookActionAndData(
        callback({ status: 2, value: 40_000, txid: "tx-b" })
      )

      expect(second.action).toEqual(PaymentActions.SUCCESSFUL)
    })

    it("captures an authorized session once the payment is final", async () => {
      container.paymentSessionService.list.mockResolvedValue([
        { id: "payses_1", data: sessionData({ confirmations: 1 }) },
      ])
      const { provider } = buildProvider(
        { confirmations: 1 },
        buildClient({ history: [{ txid: "tx", value: 100_000 }] })
      )

      const result = await provider.getWebhookActionAndData(callback())

      expect(container.paymentSessionService.list).toHaveBeenCalledWith(
        {
          status: expect.arrayContaining([PaymentSessionStatus.AUTHORIZED]),
          data: { address: ADDRESS },
        },
        expect.anything()
      )
      expect(result.action).toEqual(PaymentActions.SUCCESSFUL)
    })

    it("does not count a fee-bumped transaction twice", async () => {
      container.paymentSessionService.list.mockResolvedValue([
        {
          id: "payses_1",
          data: sessionData({
            transactions: { original: { satoshis: 60_000, status: 0 } },
          }),
        },
      ])
      const { provider } = buildProvider(
        {},
        buildClient({
          history: [{ txid: "replacement", value: 60_000 }],
        })
      )

      const result = await provider.getWebhookActionAndData(
        callback({ txid: "replacement", value: 60_000 })
      )

      expect(result.action).toEqual(PaymentActions.PENDING_AUTHORIZATION)
      expect(container.paymentSessionService.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ received_satoshis: 60_000 }),
        })
      )
    })

    it("uses the callback's transaction until the history lists it", async () => {
      const { provider } = buildProvider({}, buildClient())

      const result = await provider.getWebhookActionAndData(callback())

      expect(result.action).toEqual(PaymentActions.SUCCESSFUL)
    })

    it("waits for the rest of a partial payment", async () => {
      const { provider } = buildProvider(
        { confirmations: 0 },
        buildClient({
          pending: [{ txid: "tx", value: 60_000, status: 0 }],
        })
      )

      const result = await provider.getWebhookActionAndData(
        callback({ status: 0, value: 60_000 })
      )

      expect(result.action).toEqual(PaymentActions.PENDING_AUTHORIZATION)
    })
  })
})
