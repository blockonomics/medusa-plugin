import { Modules, PaymentActions } from "@medusajs/framework/utils"

import blockonomicsWebhookHandler from "../blockonomics-webhook"

jest.mock("@medusajs/medusa/core-flows", () => ({
  completeCartWorkflowId: "complete-cart",
  processPaymentWorkflowId: "process-payment-workflow",
}))

const buildContainer = ({
  action,
  sessionId = "payses_1",
  orders = [] as { order_id: string }[],
}: {
  action: PaymentActions
  sessionId?: string
  orders?: { order_id: string }[]
}) => {
  const paymentModule = {
    getWebhookActionAndData: jest.fn().mockResolvedValue({
      action,
      data: sessionId ? { session_id: sessionId, amount: 100 } : undefined,
    }),
  }
  const workflowEngine = { run: jest.fn() }
  const query = {
    graph: jest.fn(async ({ entity }: { entity: string }) => {
      switch (entity) {
        case "payment_session":
          return { data: [{ payment_collection_id: "paycol_1" }] }
        case "cart_payment_collection":
          return { data: [{ cart_id: "cart_1" }] }
        case "order_cart":
          return { data: orders }
        default:
          return { data: [] }
      }
    }),
  }

  const container = {
    resolve: (key: string) =>
      ({
        [Modules.PAYMENT]: paymentModule,
        [Modules.WORKFLOW_ENGINE]: workflowEngine,
        query,
      })[key],
  }

  return { container, paymentModule, workflowEngine }
}

const run = (container: unknown) =>
  blockonomicsWebhookHandler({
    event: { name: "blockonomics.webhook_received", data: {} },
    container,
  } as any)

describe("blockonomicsWebhookHandler", () => {
  it("places the order as soon as a payment is seen", async () => {
    const { container, workflowEngine } = buildContainer({
      action: PaymentActions.PENDING_AUTHORIZATION,
    })

    await run(container)

    expect(workflowEngine.run).toHaveBeenCalledWith("complete-cart", {
      input: { id: "cart_1" },
    })
  })

  it("leaves an order that has already been placed alone", async () => {
    const { container, workflowEngine } = buildContainer({
      action: PaymentActions.PENDING_AUTHORIZATION,
      orders: [{ order_id: "order_1" }],
    })

    await run(container)

    expect(workflowEngine.run).not.toHaveBeenCalled()
  })

  it("hands a confirmed payment to Medusa's payment processing", async () => {
    const { container, workflowEngine } = buildContainer({
      action: PaymentActions.SUCCESSFUL,
    })

    await run(container)

    expect(workflowEngine.run).toHaveBeenCalledWith(
      "process-payment-workflow",
      {
        input: {
          action: PaymentActions.SUCCESSFUL,
          data: { session_id: "payses_1", amount: 100 },
        },
      }
    )
  })

  it.each([PaymentActions.PENDING, PaymentActions.NOT_SUPPORTED])(
    "does nothing for %s",
    async (action) => {
      const { container, workflowEngine } = buildContainer({ action })

      await run(container)

      expect(workflowEngine.run).not.toHaveBeenCalled()
    }
  )

  it("does nothing without a session", async () => {
    const { container, workflowEngine } = buildContainer({
      action: PaymentActions.SUCCESSFUL,
      sessionId: "",
    })

    await run(container)

    expect(workflowEngine.run).not.toHaveBeenCalled()
  })
})
