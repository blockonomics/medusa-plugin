import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { AdminOrder, DetailWidgetProps } from "@medusajs/framework/types"
import { Badge, Container, Heading, Text } from "@medusajs/ui"

type BlockonomicsPayment = {
  address: string
  txid: string | null
  paid_satoshis: number
  paid_fiat: number
  payment_status: number
}

type BlockonomicsData = {
  fiat_amount: number
  currency_code: string
  paid_fiat: number
  overpaid?: boolean
  underpaid?: boolean
  payments?: BlockonomicsPayment[]
}

const SETTLED = 2

/**
 * Shows what the customer actually sent. Medusa records the order total as
 * captured, so an overpayment is otherwise invisible to the merchant.
 */
const BlockonomicsPaymentWidget = ({
  data: order,
}: DetailWidgetProps<AdminOrder>) => {
  const sessions = (order.payment_collections ?? [])
    .flatMap((collection) => collection.payments ?? [])
    .filter((payment) => payment.provider_id.startsWith("pp_blockonomics_"))
    .map((payment) => payment.data as unknown as BlockonomicsData)
    .filter((data) => data?.payments?.length)

  if (!sessions.length) {
    return null
  }

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Bitcoin payment</Heading>
      </div>
      {sessions.map((data, i) => {
        const money = (amount: number) =>
          new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: data.currency_code.toUpperCase(),
          }).format(amount)
        const difference = data.paid_fiat - data.fiat_amount

        return (
          <div key={i} className="flex flex-col gap-y-3 px-6 py-4">
            <div className="flex items-center justify-between">
              <Text size="small" weight="plus">
                Received {money(data.paid_fiat)} of {money(data.fiat_amount)}
              </Text>
              {data.overpaid && (
                <Badge color="orange" size="2xsmall">
                  Overpaid
                </Badge>
              )}
              {data.underpaid && (
                <Badge color="red" size="2xsmall">
                  Underpaid
                </Badge>
              )}
            </div>
            {data.overpaid && (
              <Text size="small" className="text-ui-fg-subtle">
                The customer sent {money(difference)} more than the order
                total. Nothing is refunded automatically: decide whether to
                send the difference back from your wallet or compensate the
                customer another way.
              </Text>
            )}
            {data.payments!.map((payment) => (
              <div key={payment.address} className="flex flex-col gap-y-1">
                <Text size="xsmall" className="text-ui-fg-subtle break-all">
                  {payment.address}
                </Text>
                <Text size="xsmall" className="text-ui-fg-subtle break-all">
                  {payment.payment_status === SETTLED
                    ? `${(payment.paid_satoshis / 1e8).toFixed(8)} BTC, worth ${money(payment.paid_fiat)}`
                    : "Not settled"}
                  {payment.txid ? ` · txid ${payment.txid}` : ""}
                </Text>
              </div>
            ))}
          </div>
        )
      })}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
})

export default BlockonomicsPaymentWidget
