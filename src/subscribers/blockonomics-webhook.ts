import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import {
  IPaymentModuleService,
  ProviderWebhookPayload,
} from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentActions,
} from "@medusajs/framework/utils"
import {
  completeCartWorkflowId,
  processPaymentWorkflowId,
} from "@medusajs/medusa/core-flows"

/** Emitted by the plugin's callback route instead of Medusa's webhook event. */
export const BLOCKONOMICS_WEBHOOK_EVENT = "blockonomics.webhook_received"

/**
 * Same as Medusa's payment webhook subscriber, except that an unconfirmed
 * payment already places the order (unpaid). The confirming callback then
 * captures the payment on that order.
 */
export default async function blockonomicsWebhookHandler({
  event,
  container,
}: SubscriberArgs<ProviderWebhookPayload>) {
  const paymentModule = container.resolve<IPaymentModuleService>(
    Modules.PAYMENT
  )
  const workflowEngine = container.resolve(Modules.WORKFLOW_ENGINE)

  const processed = await paymentModule.getWebhookActionAndData(event.data)
  const sessionId = processed.data?.session_id

  if (!sessionId) {
    return
  }

  switch (processed.action) {
    case PaymentActions.AUTHORIZED:
    case PaymentActions.SUCCESSFUL:
      await workflowEngine.run(processPaymentWorkflowId, { input: processed })
      return
    case PaymentActions.PENDING_AUTHORIZATION: {
      const cartId = await findOpenCart(container, sessionId)

      if (cartId) {
        await workflowEngine.run(completeCartWorkflowId, {
          input: { id: cartId },
        })
      }
      return
    }
    default:
      return
  }
}

/** The session's cart, or nothing if it already has an order. */
async function findOpenCart(
  container: SubscriberArgs["container"],
  sessionId: string
): Promise<string | undefined> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: sessions } = await query.graph({
    entity: "payment_session",
    fields: ["payment_collection_id"],
    filters: { id: sessionId },
  })
  const paymentCollectionId = sessions[0]?.payment_collection_id

  if (!paymentCollectionId) {
    return
  }

  const { data: carts } = await query.graph({
    entity: "cart_payment_collection",
    fields: ["cart_id"],
    filters: { payment_collection_id: paymentCollectionId },
  })
  const cartId = carts[0]?.cart_id

  if (!cartId) {
    return
  }

  const { data: orders } = await query.graph({
    entity: "order_cart",
    fields: ["order_id"],
    filters: { cart_id: cartId },
  })

  return orders.length ? undefined : cartId
}

export const config: SubscriberConfig = {
  event: BLOCKONOMICS_WEBHOOK_EVENT,
  context: {
    subscriberId: "blockonomics-webhook-handler",
  },
}
