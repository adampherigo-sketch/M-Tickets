'use client'

/**
 * Camera QR scanner. Uses getUserMedia plus jsQR (pure JS), so it works in
 * iOS Safari as well as Chrome; BarcodeDetector is not available everywhere.
 * Needs a secure context (https or localhost).
 */
import jsQR from 'jsqr'
import { useEffect, useRef, useState } from 'react'

const SCAN_INTERVAL_MS = 150
const REPEAT_SUPPRESS_MS = 3000
const MAX_FRAME_WIDTH = 640

export function QrScanner({ onScan }: { onScan: (payload: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onScanRef = useRef(onScan)
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  useEffect(() => {
    if (!active) return
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    let last = { value: '', at: 0 }

    const tick = () => {
      if (cancelled) return
      const video = videoRef.current
      const canvas = canvasRef.current
      if (video && canvas && video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth)
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (context) {
          context.drawImage(video, 0, 0, canvas.width, canvas.height)
          const frame = context.getImageData(0, 0, canvas.width, canvas.height)
          const found = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' })
          const now = performance.now()
          if (found?.data && (found.data !== last.value || now - last.at > REPEAT_SUPPRESS_MS)) {
            last = { value: found.data, at: now }
            onScanRef.current(found.data)
          }
        }
      }
      timer = setTimeout(tick, SCAN_INTERVAL_MS)
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (media) => {
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop())
          return
        }
        stream = media
        const video = videoRef.current
        if (!video) return
        video.srcObject = media
        await video.play()
        tick()
      })
      .catch((cause: unknown) => {
        // Stopping the camera mid-start aborts play(); that is not an error.
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : 'Camera unavailable')
        setActive(false)
      })

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [active])

  return (
    <div className="mt-scanner">
      <div className="mt-scanner__frame" hidden={!active}>
        <video ref={videoRef} muted playsInline className="mt-scanner__video" />
      </div>
      <canvas ref={canvasRef} hidden />
      <button
        type="button"
        className="mt-button"
        onClick={() => {
          setError(null)
          setActive((value) => !value)
        }}
      >
        {active ? 'Stop camera' : 'Scan with camera'}
      </button>
      {error ? (
        <p className="mt-error" role="alert">
          Camera unavailable: {error}. Type the code instead.
        </p>
      ) : null}
    </div>
  )
}
