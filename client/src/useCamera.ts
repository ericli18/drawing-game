import { useCallback, useEffect, useRef, useState } from 'react'

export type CameraState = 'idle' | 'requesting' | 'ready' | 'blocked'

export function useCamera(enabled = true) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const requestRef = useRef(0)
  const [state, setState] = useState<CameraState>(
    enabled ? 'requesting' : 'idle',
  )

  const start = useCallback(async () => {
    const requestId = ++requestRef.current
    streamRef.current?.getTracks().forEach((track) => track.stop())
    setState('requesting')
    let stream: MediaStream | null = null

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 30, max: 30 },
        },
      })

      if (requestId !== requestRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      const video = videoRef.current
      if (!video) throw new Error('Camera view is unavailable')

      streamRef.current = stream
      video.srcObject = stream
      await video.play()

      if (requestId !== requestRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      const videoTrack = stream.getVideoTracks()[0]
      videoTrack?.addEventListener(
        'ended',
        () => {
          if (streamRef.current !== stream) return
          streamRef.current = null
          video.srcObject = null
          setState('blocked')
        },
        { once: true },
      )
      setState('ready')
    } catch {
      stream?.getTracks().forEach((track) => track.stop())
      if (requestId === requestRef.current) setState('blocked')
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      requestRef.current += 1
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      if (videoRef.current) videoRef.current.srcObject = null
      setState('idle')
      return
    }

    void start()

    return () => {
      requestRef.current += 1
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [enabled, start])

  return { videoRef, cameraState: state, startCamera: start }
}
