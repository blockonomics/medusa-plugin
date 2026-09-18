import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { IPaymentModuleService } from "@medusajs/framework/types"
import { MedusaError, Modules } from "@medusajs/framework/utils"

/**
 * Re-quotes the BTC amount of a Blockonomics payment session.
 *
 * The storefront calls this when the price lock runs out, the way the
 * WooCommerce plugin refreshes the order amount. Medusa's own endpoint for
 * payment sessions replaces the session, which hands the customer a new
 * address; this one runs the provider's `updatePayment`, which keeps the
 * address and only re-quotes the amount once the lock has expired with nothing
 * received.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { id } = req.params

  const paymentModule = req.scope.resolve<IPaymentModuleService>(
    Modules.PAYMENT
  )

  const session = await paymentModule.retrievePaymentSession(id, {
    select: ["id", "provider_id", "amount", "currency_code", "data", "status"],
  })

  if (!session.provider_id.startsWith("pp_blockonomics_")) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Payment session ${id} is not a Blockonomics session`
    )
  }

  const updated = await paymentModule.updatePaymentSession({
    id: session.id,
    amount: session.amount,
    currency_code: session.currency_code,
    data: session.data ?? {},
  })

  res.json({
    payment_session: {
      id: updated.id,
      status: updated.status,
      data: updated.data,
    },
  })
}
