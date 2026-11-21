import QRCode from 'qrcode'

/**
 * Renders a ticket's signed QR payload as inline SVG on the server, so the
 * buyer's ticket page works offline once loaded and needs no client script.
 */
export async function TicketQr({ payload, label }: { payload: string; label: string }) {
  const svg = await QRCode.toString(payload, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', width: 240 })
  // The SVG comes from the qrcode library, built from our own signed payload.
  return <div className="mt-qr" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />
}
