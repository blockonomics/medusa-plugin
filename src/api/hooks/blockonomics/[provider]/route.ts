import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  PaymentModuleOptions,
  ProviderWebhookPayload,
} from "@medusajs/framework/types"
import { Modules, PaymentWebhookEvents } from "@medusajs/framework/utils"

/**
 * Receives Blockonomics payment callbacks.
 *
 * Medusa's own `/hooks/payment/:provider` endpoint only accepts `POST`, while
 * Blockonomics notifies with a `GET` request carrying the payment in the query
 * string. This route emits the same event as Medusa's endpoint, with the query
 * in place of the body, so Medusa's payment webhook subscriber processes it
 * and the provider's `getWebhookActionAndData` receives the callback values.
 *
 * `:provider` is `blockonomics_{id}`, where `id` is the provider's `id` in
 * `medusa-config.ts`.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const { provider } = req.params

    const options: PaymentModuleOptions =
      // @ts-expect-error options is not typed on the module service
      req.scope.resolve(Modules.PAYMENT).options || {}

    const event: ProviderWebhookPayload = {
      provider,
      payload: {
        data: req.query as Record<string, unknown>,
        rawData: "",
        headers: req.headers as Record<string, unknown>,
      },
    }

    const eventBus = req.scope.resolve(Modules.EVENT_BUS)

    // Delayed like Medusa's own webhook endpoint, to avoid racing the request
    // that created the payment session.
    await eventBus.emit(
      {
        name: PaymentWebhookEvents.WebhookReceived,
        data: event,
      },
      {
        delay: options.webhook_delay || 5000,
        attempts: options.webhook_retries || 3,
      }
    )
  } catch (err) {
    res.status(400).send(`Webhook Error: ${err.message}`)
    return
  }

  res.sendStatus(200)
}
