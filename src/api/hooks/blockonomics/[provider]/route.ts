import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  PaymentModuleOptions,
  ProviderWebhookPayload,
} from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

import { BLOCKONOMICS_WEBHOOK_EVENT } from "../../../../subscribers/blockonomics-webhook"

/**
 * Receives Blockonomics payment callbacks.
 *
 * Blockonomics sends callbacks as `GET`, which Medusa's `/hooks/payment`
 * endpoint does not accept. This route passes the query to the plugin's
 * webhook subscriber instead.
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
        name: BLOCKONOMICS_WEBHOOK_EVENT,
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
