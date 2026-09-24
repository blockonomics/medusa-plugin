import { PaymentActions, PaymentSessionStatus } from "@medusajs/framework/utils"

import BlockonomicsProviderService from "../../services/blockonomics-provider"
import {
  BlockonomicsOptions,
  BlockonomicsPayment,
  BlockonomicsPaymentData,
  BlockonomicsPaymentStatus,
} from "../../types"

const ADDRESS = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
const NEXT_ADDRESS = "bc1qnext0000000000000000000000000000000000"
const CALLBACK_SECRET = "MEDUSA_callback-secret"
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

const buildClient = ({ price = BTC_PRICE } = {}) => ({
  newAddress: jest
    .fn()
    .mockResolvedValueOnce(ADDRESS)
    .mockResolvedValue(NEXT_ADDRESS),
  getPrice: jest.fn().mockResolvedValue(price),
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

const payment = (
  overrides: Partial<BlockonomicsPayment> = {}
): BlockonomicsPayment => ({
  address: ADDRESS,
  expected_fiat: 100,
  expected_satoshis: 100_000,
  btc_price: BTC_PRICE,
  price_locked_until: Date.now() + 600_000,
  payment_status: BlockonomicsPaymentStatus.NEW,
  confirmations: 0,
  paid_satoshis: 0,
  paid_fiat: 0,
  txid: null,
  ...overrides,
})

/**
 * Session data as the provider stores it: the payments, with the active one
 * mirrored on top.
 */
const sessionData = (
  payments: BlockonomicsPayment[] = [payment()],
  overrides: Partial<BlockonomicsPaymentData> = {}
): BlockonomicsPaymentData => {
  const active = payments[payments.length - 1]

  return {
    session_id: "payses_1",
    fiat_amount: 100,
    currency_code: "usd",
    payments,
    paid_fiat: payments.reduce((sum, p) => sum + p.paid_fiat, 0),
    address: active.address,
    expected_fiat: active.expected_fiat,
    expected_satoshis: active.expected_satoshis,
    btc_price: active.btc_price,
    price_locked_until: active.price_locked_until,
    payment_status: active.payment_status,
    confirmations: active.confirmations,
    paid_satoshis: active.paid_satoshis,
    txid: active.txid,
    ...overrides,
  }
}

const settled = (overrides: Partial<BlockonomicsPayment> = {}) =>
  payment({
    payment_status: BlockonomicsPaymentStatus.SETTLED,
    confirmations: 2,
    paid_satoshis: 100_000,
    paid_fiat: 100,
    txid: "tx",
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

    it("requires the callback secret to carry the MEDUSA_ prefix", () => {
      expect(() =>
        BlockonomicsProviderService.validateOptions({
          ...baseOptions,
          callbackSecret: "callback-secret",
        })
      ).toThrow(/must start with "MEDUSA_"/)

      expect(() =>
        BlockonomicsProviderService.validateOptions({
          ...baseOptions,
          callbackSecret: "MEDUSA_",
        })
      ).toThrow(/must start with "MEDUSA_"/)

      expect(() =>
        BlockonomicsProviderService.validateOptions(baseOptions)
      ).not.toThrow()
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
    it("quotes the order total on a fresh address and keys the session by it", async () => {
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
          fiat_amount: 100,
          expected_fiat: 100,
          btc_price: BTC_PRICE,
          // 100 USD at 100,000 USD/BTC is 0.001 BTC
          expected_satoshis: 100_000,
          paid_fiat: 0,
          payment_status: BlockonomicsPaymentStatus.NEW,
        })
      )
      expect((result.data as BlockonomicsPaymentData).payments).toHaveLength(1)
    })
  })

  describe("getPaymentStatus", () => {
    it("stays pending while nothing has arrived", async () => {
      const { provider } = buildProvider()

      const result = await provider.getPaymentStatus({ data: sessionData() })

      expect(result.status).toEqual(PaymentSessionStatus.PENDING)
    })

    it("waits while a payment is below the required confirmations", async () => {
      const { provider } = buildProvider()

      const result = await provider.getPaymentStatus({
        data: sessionData([
          payment({
            payment_status: BlockonomicsPaymentStatus.IN_PROGRESS,
            confirmations: 1,
            txid: "tx",
          }),
        ]),
      })

      expect(result.status).toEqual(PaymentSessionStatus.PENDING_AUTHORIZATION)
    })

    it("is captured once the active address settled in full", async () => {
      const { provider } = buildProvider()

      const result = await provider.getPaymentStatus({
        data: sessionData([settled()]),
      })

      expect(result.status).toEqual(PaymentSessionStatus.CAPTURED)
      expect(result.data).toEqual(
        expect.objectContaining({ paid_fiat: 100, underpaid: false })
      )
    })

    it("waits for the remainder of a settled underpayment", async () => {
      const { provider } = buildProvider()

      const result = await provider.getPaymentStatus({
        data: sessionData([settled({ paid_satoshis: 40_000, paid_fiat: 40 })]),
      })

      expect(result.status).toEqual(PaymentSessionStatus.PENDING_AUTHORIZATION)
      expect(result.data).toEqual(
        expect.objectContaining({ paid_fiat: 40, underpaid: true })
      )
    })

    it("accepts a shortfall within the merchant's tolerance", async () => {
      const { provider } = buildProvider({ underpaymentTolerance: 0.02 })

      const result = await provider.getPaymentStatus({
        data: sessionData([settled({ paid_satoshis: 98_500, paid_fiat: 98.5 })]),
      })

      expect(result.status).toEqual(PaymentSessionStatus.CAPTURED)
    })

    it("flags a payment that exceeds the overpayment tolerance", async () => {
      const { provider } = buildProvider()

      const result = await provider.getPaymentStatus({
        data: sessionData([settled({ paid_satoshis: 120_000, paid_fiat: 120 })]),
      })

      expect(result.status).toEqual(PaymentSessionStatus.CAPTURED)
      expect(result.data).toEqual(expect.objectContaining({ overpaid: true }))
    })

    it("is paid once the follow-up address for the remainder settles", async () => {
      const { provider } = buildProvider()

      const result = await provider.getPaymentStatus({
        data: sessionData([
          settled({ paid_satoshis: 40_000, paid_fiat: 40 }),
          settled({
            address: NEXT_ADDRESS,
            expected_fiat: 60,
            expected_satoshis: 50_000,
            btc_price: 120_000,
            paid_satoshis: 50_000,
            paid_fiat: 60,
            txid: "tx2",
          }),
        ]),
      })

      expect(result.status).toEqual(PaymentSessionStatus.CAPTURED)
      expect(result.data).toEqual(
        expect.objectContaining({ paid_fiat: 100, address: NEXT_ADDRESS })
      )
    })
  })

  describe("updatePayment", () => {
    it("re-quotes an expired price lock when nothing has been received", async () => {
      const { provider, client } = buildProvider({}, buildClient({ price: 125_000 }))

      const result = await provider.updatePayment({
        amount: 100,
        currency_code: "usd",
        data: sessionData([payment({ price_locked_until: Date.now() - 1 })]),
      })

      expect(client.newAddress).not.toHaveBeenCalled()
      expect(result.status).toEqual(PaymentSessionStatus.PENDING)
      expect(result.data).toEqual(
        expect.objectContaining({
          address: ADDRESS,
          btc_price: 125_000,
          expected_satoshis: 80_000,
        })
      )
      expect(
        (result.data as BlockonomicsPaymentData).price_locked_until
      ).toBeGreaterThan(Date.now())
    })

    it("keeps a valid quote as it is", async () => {
      const { provider, client } = buildProvider({}, buildClient({ price: 125_000 }))
      const data = sessionData()

      const result = await provider.updatePayment({
        amount: 100,
        currency_code: "usd",
        data,
      })

      expect(client.getPrice).not.toHaveBeenCalled()
      expect(result.data).toEqual(
        expect.objectContaining({
          expected_satoshis: 100_000,
          price_locked_until: data.price_locked_until,
        })
      )
    })

    it("re-quotes a changed total on the same address", async () => {
      const { provider } = buildProvider()

      const result = await provider.updatePayment({
        amount: 150,
        currency_code: "usd",
        data: sessionData(),
      })

      expect(result.data).toEqual(
        expect.objectContaining({
          address: ADDRESS,
          fiat_amount: 150,
          expected_fiat: 150,
          expected_satoshis: 150_000,
        })
      )
    })

    it("leaves a payment in progress alone, even once the lock expired", async () => {
      const { provider, client } = buildProvider({}, buildClient({ price: 125_000 }))
      const data = sessionData([
        payment({
          payment_status: BlockonomicsPaymentStatus.IN_PROGRESS,
          txid: "tx",
          price_locked_until: Date.now() - 1,
        }),
      ])

      const result = await provider.updatePayment({
        amount: 100,
        currency_code: "usd",
        data,
      })

      expect(client.getPrice).not.toHaveBeenCalled()
      expect(result.status).toEqual(PaymentSessionStatus.PENDING_AUTHORIZATION)
      expect(result.data).toEqual(
        expect.objectContaining({ expected_satoshis: 100_000 })
      )
    })

    it("quotes the remainder of a settled underpayment on a new address at the current rate", async () => {
      const { provider, client } = buildProvider({}, buildClient({ price: 120_000 }))
      client.newAddress.mockReset().mockResolvedValue(NEXT_ADDRESS)

      const result = await provider.updatePayment({
        amount: 100,
        currency_code: "usd",
        data: sessionData([settled({ paid_satoshis: 40_000, paid_fiat: 40 })]),
      })

      expect(client.newAddress).toHaveBeenCalledTimes(1)
      expect(result.status).toEqual(PaymentSessionStatus.PENDING_AUTHORIZATION)
      expect(result.data).toEqual(
        expect.objectContaining({
          address: NEXT_ADDRESS,
          paid_fiat: 40,
          expected_fiat: 60,
          btc_price: 120_000,
          expected_satoshis: 50_000,
          payment_status: BlockonomicsPaymentStatus.NEW,
          underpaid: true,
        })
      )
      const { payments } = result.data as BlockonomicsPaymentData
      expect(payments).toHaveLength(2)
      expect(payments[0]).toEqual(
        expect.objectContaining({ address: ADDRESS, paid_fiat: 40 })
      )
    })

    it("does not hand out another address while the remainder is unpaid", async () => {
      const { provider, client } = buildProvider()

      const result = await provider.updatePayment({
        amount: 100,
        currency_code: "usd",
        data: sessionData([
          settled({ paid_satoshis: 40_000, paid_fiat: 40 }),
          payment({
            address: NEXT_ADDRESS,
            expected_fiat: 60,
            expected_satoshis: 60_000,
          }),
        ]),
      })

      expect(client.newAddress).not.toHaveBeenCalled()
      expect((result.data as BlockonomicsPaymentData).payments).toHaveLength(2)
    })

    it("does not touch a paid session", async () => {
      const { provider, client } = buildProvider()

      const result = await provider.updatePayment({
        amount: 100,
        currency_code: "usd",
        data: sessionData([settled()]),
      })

      expect(client.newAddress).not.toHaveBeenCalled()
      expect(client.getPrice).not.toHaveBeenCalled()
      expect(result.status).toEqual(PaymentSessionStatus.CAPTURED)
    })
  })

  describe("refundPayment", () => {
    it("refuses to refund on-chain", async () => {
      const { provider } = buildProvider()

      await expect(
        provider.refundPayment({ amount: 100, data: sessionData() })
      ).rejects.toThrow(/cannot be refunded/)
    })
  })

  describe("capturePayment", () => {
    it("refuses to capture an underpaid session", async () => {
      const { provider } = buildProvider()

      await expect(
        provider.capturePayment({
          data: sessionData([settled({ paid_satoshis: 40_000, paid_fiat: 40 })]),
        })
      ).rejects.toThrow(/Cannot capture/)
    })

    it("records the capture of a paid session", async () => {
      const { provider } = buildProvider()

      const result = await provider.capturePayment({
        data: sessionData([settled()]),
      })

      expect((result.data as BlockonomicsPaymentData).captured_at).toEqual(
        expect.any(Number)
      )
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

    const openSession = (data = sessionData()) => {
      container.paymentSessionService.list.mockResolvedValue([
        { id: "payses_1", data },
      ])
    }

    const persisted = (): BlockonomicsPaymentData =>
      container.paymentSessionService.update.mock.calls.at(-1)[0].data

    beforeEach(() => {
      openSession()
    })

    it("ignores a callback carrying the wrong secret", async () => {
      const { provider } = buildProvider()

      const result = await provider.getWebhookActionAndData(
        callback({ secret: "wrong" })
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
      const { provider } = buildProvider()
      container.paymentSessionService.list.mockResolvedValue([])

      const result = await provider.getWebhookActionAndData(callback())

      expect(result.action).toEqual(PaymentActions.NOT_SUPPORTED)
    })

    it("marks the address paid-in-progress below the required confirmations", async () => {
      const { provider } = buildProvider()

      const result = await provider.getWebhookActionAndData(
        callback({ status: 0 })
      )

      expect(result.action).toEqual(PaymentActions.PENDING_AUTHORIZATION)
      expect(persisted()).toEqual(
        expect.objectContaining({
          payment_status: BlockonomicsPaymentStatus.IN_PROGRESS,
          confirmations: 0,
          txid: "tx",
          paid_fiat: 0,
        })
      )
    })

    it("settles the address at the required confirmations and completes the payment", async () => {
      const { provider } = buildProvider()

      const result = await provider.getWebhookActionAndData(callback())

      expect(result).toEqual({
        action: PaymentActions.SUCCESSFUL,
        data: { session_id: "payses_1", amount: 100 },
      })
      expect(persisted()).toEqual(
        expect.objectContaining({
          payment_status: BlockonomicsPaymentStatus.SETTLED,
          paid_satoshis: 100_000,
          paid_fiat: 100,
        })
      )
    })

    it("settles at a lower threshold when the merchant accepts one", async () => {
      const { provider } = buildProvider({ confirmations: 0 })

      const result = await provider.getWebhookActionAndData(
        callback({ status: 0 })
      )

      expect(result.action).toEqual(PaymentActions.SUCCESSFUL)
    })

    it("only records the transaction id of an unconfirmed replace-by-fee payment", async () => {
      const { provider } = buildProvider({ confirmations: 0 })

      const result = await provider.getWebhookActionAndData(
        callback({ status: 0, rbf: 1 })
      )

      expect(result.action).toEqual(PaymentActions.PENDING_AUTHORIZATION)
      expect(persisted()).toEqual(
        expect.objectContaining({
          payment_status: BlockonomicsPaymentStatus.NEW,
          txid: "tx",
        })
      )
    })

    it("values a settled underpayment at the rate it was quoted at", async () => {
      const { provider } = buildProvider()

      const result = await provider.getWebhookActionAndData(
        callback({ value: 40_000 })
      )

      expect(result.action).toEqual(PaymentActions.PENDING_AUTHORIZATION)
      expect(persisted()).toEqual(
        expect.objectContaining({
          payment_status: BlockonomicsPaymentStatus.SETTLED,
          paid_satoshis: 40_000,
          paid_fiat: 40,
          underpaid: true,
        })
      )
    })

    it("ignores further callbacks for a settled address", async () => {
      const { provider } = buildProvider()
      openSession(sessionData([settled({ paid_satoshis: 40_000, paid_fiat: 40 })]))

      const result = await provider.getWebhookActionAndData(
        callback({ value: 100_000, txid: "tx-late" })
      )

      expect(result.action).toEqual(PaymentActions.PENDING_AUTHORIZATION)
      expect(persisted()).toEqual(
        expect.objectContaining({ paid_satoshis: 40_000, txid: "tx" })
      )
    })

    it("completes the payment once the follow-up address settles", async () => {
      const { provider } = buildProvider()
      openSession(
        sessionData([
          settled({ paid_satoshis: 40_000, paid_fiat: 40 }),
          payment({
            address: NEXT_ADDRESS,
            expected_fiat: 60,
            expected_satoshis: 50_000,
            btc_price: 120_000,
          }),
        ])
      )

      const result = await provider.getWebhookActionAndData(
        callback({ addr: NEXT_ADDRESS, value: 50_000, txid: "tx2" })
      )

      expect(result.action).toEqual(PaymentActions.SUCCESSFUL)
      expect(persisted()).toEqual(
        expect.objectContaining({ paid_fiat: 100, underpaid: true })
      )
      expect(persisted().payments[1]).toEqual(
        expect.objectContaining({ paid_satoshis: 50_000, paid_fiat: 60 })
      )
    })
  })
})
