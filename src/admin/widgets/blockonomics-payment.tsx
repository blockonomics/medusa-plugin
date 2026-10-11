import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { AdminOrder, DetailWidgetProps } from "@medusajs/framework/types"
import { Badge, Container, Heading, Text } from "@medusajs/ui"
import { useEffect, useState } from "react"

type BlockonomicsPayment = {
  address: string
  txid: string | null
  expected_fiat: number
  confirmations: number
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

const NEW = 0
const IN_PROGRESS = 1
const SETTLED = 2

/**
 * Shows what the customer actually sent. Reads the payment sessions rather
 * than the order's payments: Medusa only creates a payment once the session is
 * authorized, so an order placed on an unconfirmed or short payment would
 * otherwise show nothing, and an overpayment would be invisible since the
 * payment records the order total.
 */
const BlockonomicsPaymentWidget = ({
  data: order,
}: DetailWidgetProps<AdminOrder>) => {
  const [sessions, setSessions] = useState<BlockonomicsData[]>([])

  useEffect(() => {
    let active = true

    // The dashboard signs admins in with a session cookie; the backend is on
    // the same origin unless the admin is built with VITE_BACKEND_URL.
    fetch(
      `${import.meta.env.VITE_BACKEND_URL ?? ""}/admin/orders/${order.id}?fields=id,*payment_collections.payment_sessions`,
      { credentials: "include" }
    )
      .then((res) => {
        if (!res.ok) {
          throw new Error(`${res.status}`)
        }
        return res.json() as Promise<{ order: AdminOrder }>
      })
      .then(({ order: withSessions }) => {
        if (!active) {
          return
        }

        setSessions(
          (withSessions.payment_collections ?? [])
            .flatMap((collection) => collection.payment_sessions ?? [])
            .filter((session) =>
              session.provider_id.startsWith("pp_blockonomics_")
            )
            .map((session) => session.data as unknown as BlockonomicsData)
            // Sessions the customer never paid into, e.g. an abandoned retry.
            .filter((data) =>
              data?.payments?.some(
                (payment) => payment.payment_status !== NEW
              )
            )
        )
      })
      .catch(() => {})

    return () => {
      active = false
    }
  }, [order.id])

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
        const payments = data.payments!
        const active = payments[payments.length - 1]
        const confirming = active.payment_status === IN_PROGRESS
        const difference = data.paid_fiat - data.fiat_amount

        return (
          <div key={i} className="flex flex-col gap-y-3 px-6 py-4">
            <div className="flex items-center justify-between">
              <Text size="small" weight="plus">
                Received {money(data.paid_fiat)} of {money(data.fiat_amount)}
              </Text>
              {confirming && (
                <Badge color="blue" size="2xsmall">
                  Confirming
                </Badge>
              )}
              {data.overpaid && (
                <Badge color="orange" size="2xsmall">
                  Overpaid
                </Badge>
              )}
              {data.underpaid && !confirming && (
                <Badge color="red" size="2xsmall">
                  Underpaid
                </Badge>
              )}
            </div>
            {confirming && (
              <Text size="small" className="text-ui-fg-subtle">
                A payment was sent and is waiting for confirmations on the
                Bitcoin network. The order is marked as paid once it confirms;
                nothing needs to be done.
              </Text>
            )}
            {data.underpaid && !confirming && (
              <Text size="small" className="text-ui-fg-subtle">
                The customer still owes {money(-difference)}. They can pay it
                from the checkout page, and the order is marked as paid once
                it arrives. If they don't, contact them, or cancel the order
                and send back what they paid from your wallet.
              </Text>
            )}
            {data.overpaid && (
              <Text size="small" className="text-ui-fg-subtle">
                The customer sent {money(difference)} more than the order
                total. Nothing is refunded automatically: decide whether to
                send the difference back from your wallet or compensate the
                customer another way.
              </Text>
            )}
            {payments.map((payment) => (
              <div key={payment.address} className="flex flex-col gap-y-1">
                <Text size="xsmall" className="text-ui-fg-subtle break-all">
                  {payment.address}
                </Text>
                <Text size="xsmall" className="text-ui-fg-subtle break-all">
                  {describe(payment, money)}
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

function describe(
  payment: BlockonomicsPayment,
  money: (amount: number) => string
): string {
  switch (payment.payment_status) {
    case SETTLED:
      return `${(payment.paid_satoshis / 1e8).toFixed(8)} BTC, worth ${money(payment.paid_fiat)}`
    case IN_PROGRESS:
      return `Payment seen, ${payment.confirmations} ${
        payment.confirmations === 1 ? "confirmation" : "confirmations"
      } so far`
    default:
      return `Waiting for ${money(payment.expected_fiat)}`
  }
}

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
})

export default BlockonomicsPaymentWidget
