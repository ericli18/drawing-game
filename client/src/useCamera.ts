import { useCallback, useEffect, useRef, useState } from 'react'

export type CameraState = 'requesting' | 'ready' | 'blocked'

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const requestRef = useRef(0)
  const [state, setState] = useState<CameraState>('requesting')

  const start = useCallback(async () => {
    const requestId = ++requestRef.current
    streamRef.current?.getTracks().forEach((track) => track.stop())
    setState('requesting')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      })

      if (requestId !== requestRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
      setState('ready')
    } catch {
      setState('blocked')
    }
  }, [])

  useEffect(() => {
    void start()

    return () => {
      requestRef.current += 1
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [start])

  return { videoRef, cameraState: state, startCamera: start }
}
