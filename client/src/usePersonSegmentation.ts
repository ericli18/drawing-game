import { useEffect, useRef, useState, type RefObject } from 'react'
import type { MPMask, PoseLandmarker } from '@mediapipe/tasks-vision'

export type PersonTrackingState = 'idle' | 'loading' | 'tracking' | 'error'

const MAX_POSES = 3
const INFERENCE_INTERVAL_MS = 125
const SINGLE_PERSON_CONFIRMATION_FRAMES = 3
const MASK_THRESHOLD = 0.25
const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

type PersonTracking = {
  state: PersonTrackingState
  count: number
}

function clearHighlight(canvas: HTMLCanvasElement | null) {
  const context = canvas?.getContext('2d')
  if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height)
}

function drawHighlight(
  canvas: HTMLCanvasElement,
  masks: MPMask[],
  personCount: number,
) {
  const firstMask = masks[0]
  if (!firstMask || personCount === 0) {
    clearHighlight(canvas)
    return
  }

  if (canvas.width !== firstMask.width || canvas.height !== firstMask.height) {
    canvas.width = firstMask.width
    canvas.height = firstMask.height
  }

  const context = canvas.getContext('2d')
  if (!context) return

  const maskData = masks.map((mask) => mask.getAsFloat32Array())
  const imageData = context.createImageData(firstMask.width, firstMask.height)
  const color = [68, 70, 76]

  for (let pixel = 0; pixel < firstMask.width * firstMask.height; pixel += 1) {
    let confidence = 0
    for (const data of maskData) confidence = Math.max(confidence, data[pixel])

    if (confidence < MASK_THRESHOLD) continue

    const offset = pixel * 4
    imageData.data[offset] = color[0]
    imageData.data[offset + 1] = color[1]
    imageData.data[offset + 2] = color[2]
    imageData.data[offset + 3] = Math.round(confidence * 108)
  }

  context.putImageData(imageData, 0, 0)
}

async function createPoseLandmarker() {
  const { FilesetResolver, PoseLandmarker } = await import(
    '@mediapipe/tasks-vision'
  )
  const vision = await FilesetResolver.forVisionTasks(WASM_URL)
  const options = {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: 'GPU' as const,
    },
    runningMode: 'VIDEO' as const,
    numPoses: MAX_POSES,
    minPoseDetectionConfidence: 0.55,
    minPosePresenceConfidence: 0.55,
    minTrackingConfidence: 0.55,
    outputSegmentationMasks: true,
  }

  try {
    return await PoseLandmarker.createFromOptions(vision, options)
  } catch {
    return PoseLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
    })
  }
}

export function usePersonSegmentation(
  videoRef: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
) {
  const highlightCanvasRef = useRef<HTMLCanvasElement>(null)
  const countRef = useRef(0)
  const [tracking, setTracking] = useState<PersonTracking>({
    state: 'idle',
    count: 0,
  })

  useEffect(() => {
    if (!enabled) {
      countRef.current = 0
      setTracking({ state: 'idle', count: 0 })
      clearHighlight(highlightCanvasRef.current)
      return
    }

    let cancelled = false
    let animationFrame = 0
    let landmarker: PoseLandmarker | null = null
    let lastInferenceAt = -Infinity
    let lastVideoTime = -1
    let singlePersonFrames = 0
    const highlightCanvas = highlightCanvasRef.current

    countRef.current = 0
    setTracking({ state: 'loading', count: 0 })

    const trackPeople = (timestamp: number) => {
      if (cancelled || !landmarker) return
      animationFrame = window.requestAnimationFrame(trackPeople)

      const video = videoRef.current
      if (
        !video ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        video.currentTime === lastVideoTime ||
        timestamp - lastInferenceAt < INFERENCE_INTERVAL_MS
      ) {
        return
      }

      lastInferenceAt = timestamp
      lastVideoTime = video.currentTime

      try {
        landmarker.detectForVideo(video, timestamp, (result) => {
          const detectedCount = result.landmarks.length
          singlePersonFrames =
            detectedCount === 1 ? singlePersonFrames + 1 : 0
          const count =
            detectedCount === 1 &&
            singlePersonFrames < SINGLE_PERSON_CONFIRMATION_FRAMES
              ? countRef.current
              : detectedCount
          if (highlightCanvas) {
            drawHighlight(
              highlightCanvas,
              result.segmentationMasks ?? [],
              count,
            )
          }

          if (count !== countRef.current) {
            countRef.current = count
            setTracking({ state: 'tracking', count })
          }
        })
      } catch {
        cancelled = true
        landmarker.close()
        landmarker = null
        clearHighlight(highlightCanvas)
        setTracking({ state: 'error', count: 0 })
      }
    }

    const startTracking = async () => {
      try {
        const instance = await createPoseLandmarker()
        if (cancelled) {
          instance.close()
          return
        }

        landmarker = instance
        setTracking({ state: 'tracking', count: 0 })
        animationFrame = window.requestAnimationFrame(trackPeople)
      } catch {
        if (!cancelled) setTracking({ state: 'error', count: 0 })
      }
    }

    void startTracking()

    return () => {
      cancelled = true
      window.cancelAnimationFrame(animationFrame)
      landmarker?.close()
      clearHighlight(highlightCanvas)
    }
  }, [enabled, videoRef])

  return {
    highlightCanvasRef,
    personCount: tracking.count,
    personTrackingState: tracking.state,
  }
}
