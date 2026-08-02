import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type {
  MPMask,
  NormalizedLandmark,
  PoseLandmarker,
} from '@mediapipe/tasks-vision'

export type PersonTrackingState = 'idle' | 'loading' | 'tracking' | 'error'

const MAX_POSES = 3
const INFERENCE_INTERVAL_MS = 125
// Consecutive identical detections before the reported person count changes,
// so a single dropped frame does not flap the count.
const COUNT_CONFIRMATION_FRAMES = 2
const MASK_THRESHOLD = 0.15
// The lock samples this fraction of the frame around the crosshair rather
// than a single pixel, because the lite model's masks are patchy.
const LOCK_REGION_EXTENT = 0.08
const LANDMARK_LOCK_MARGIN = 0.05
// The lock is a hysteresis machine: it needs consecutive confident frames to
// engage, then rides through detection flicker for a grace period at a lower
// confidence bar before releasing.
const LOCK_ACQUIRE_FRAMES = 2
const LOCK_GRACE_MS = 300
const LOCK_ACQUIRE_CONFIDENCE = 0.6
const LOCK_RELEASE_CONFIDENCE = 0.45
// Nose, shoulders, and hips: their mean visibility is a stable measure of how
// certain the model is that a real person is in frame.
const CORE_LANDMARK_INDICES = [0, 11, 12, 23, 24] as const
// The highlight overlay is decorative; render it at a bounded resolution so
// high-resolution camera masks stay cheap to draw.
const HIGHLIGHT_MAX_DIMENSION = 320
const STALE_VIDEO_MS = 1_000
const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

type PersonTracking = {
  state: PersonTrackingState
  count: number
  targetLocked: boolean
}

type HighlightRender = {
  maskData: Float32Array[]
  width: number
  height: number
}

function clearHighlight(canvas: HTMLCanvasElement | null) {
  const context = canvas?.getContext('2d')
  if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height)
}

function renderHighlight(
  canvas: HTMLCanvasElement,
  masks: MPMask[],
): HighlightRender {
  const firstMask = masks[0]
  const maskData = masks.map((mask) => mask.getAsFloat32Array())
  const { width, height } = firstMask
  const render = { maskData, width, height }

  const stride = Math.max(
    1,
    Math.ceil(Math.max(width, height) / HIGHLIGHT_MAX_DIMENSION),
  )
  const outWidth = Math.max(1, Math.floor(width / stride))
  const outHeight = Math.max(1, Math.floor(height / stride))
  if (canvas.width !== outWidth || canvas.height !== outHeight) {
    canvas.width = outWidth
    canvas.height = outHeight
  }

  const context = canvas.getContext('2d')
  if (!context) return render

  const imageData = context.createImageData(outWidth, outHeight)
  const color = [68, 70, 76]

  for (let y = 0; y < outHeight; y += 1) {
    const sourceRow = y * stride * width
    for (let x = 0; x < outWidth; x += 1) {
      const sourcePixel = sourceRow + x * stride
      let confidence = 0
      for (const data of maskData) {
        confidence = Math.max(confidence, data[sourcePixel] ?? 0)
      }

      if (confidence < MASK_THRESHOLD) continue

      const offset = (y * outWidth + x) * 4
      imageData.data[offset] = color[0]
      imageData.data[offset + 1] = color[1]
      imageData.data[offset + 2] = color[2]
      imageData.data[offset + 3] = Math.round(confidence * 108)
    }
  }

  context.putImageData(imageData, 0, 0)
  return render
}

function coreConfidence(pose: NormalizedLandmark[] | undefined) {
  if (!pose) return 0
  const scores = CORE_LANDMARK_INDICES.map(
    (index) => pose[index]?.visibility,
  ).filter((visibility): visibility is number => Number.isFinite(visibility))
  if (scores.length === 0) return 0
  return scores.reduce((sum, visibility) => sum + visibility, 0) / scores.length
}

function maskCoversCenter({ maskData, width, height }: HighlightRender) {
  if (maskData.length === 0 || width === 0 || height === 0) return false

  const radiusX = Math.max(1, Math.round(width * LOCK_REGION_EXTENT))
  const radiusY = Math.max(1, Math.round(height * LOCK_REGION_EXTENT))
  const centerX = Math.floor(width / 2)
  const centerY = Math.floor(height / 2)

  for (let y = centerY - radiusY; y <= centerY + radiusY; y += 1) {
    const rowOffset = y * width
    for (let x = centerX - radiusX; x <= centerX + radiusX; x += 1) {
      for (const data of maskData) {
        if ((data[rowOffset + x] ?? 0) >= MASK_THRESHOLD) return true
      }
    }
  }
  return false
}

function poseCoversCenter(poses: NormalizedLandmark[][]) {
  return poses.some((pose) => {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const point of pose) {
      minX = Math.min(minX, point.x)
      maxX = Math.max(maxX, point.x)
      minY = Math.min(minY, point.y)
      maxY = Math.max(maxY, point.y)
    }
    return (
      0.5 >= minX - LANDMARK_LOCK_MARGIN &&
      0.5 <= maxX + LANDMARK_LOCK_MARGIN &&
      0.5 >= minY - LANDMARK_LOCK_MARGIN &&
      0.5 <= maxY + LANDMARK_LOCK_MARGIN
    )
  })
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
    minPoseDetectionConfidence: 0.4,
    minPosePresenceConfidence: 0.4,
    minTrackingConfidence: 0.3,
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
  const targetLockedRef = useRef(false)
  const [retryKey, setRetryKey] = useState(0)
  const [tracking, setTracking] = useState<PersonTracking>({
    state: 'idle',
    count: 0,
    targetLocked: false,
  })

  useEffect(() => {
    if (!enabled) {
      countRef.current = 0
      targetLockedRef.current = false
      setTracking({ state: 'idle', count: 0, targetLocked: false })
      clearHighlight(highlightCanvasRef.current)
      return
    }

    let cancelled = false
    let animationFrame = 0
    let landmarker: PoseLandmarker | null = null
    let lastInferenceAt = -Infinity
    let lastResultAt = performance.now()
    let lastVideoTime = -1
    let candidateCount = 0
    let candidateFrames = 0
    let lockEngaged = false
    let lockFrames = 0
    let lockInvalidSinceMs: number | null = null
    const highlightCanvas = highlightCanvasRef.current

    const resetLock = () => {
      lockEngaged = false
      lockFrames = 0
      lockInvalidSinceMs = null
    }

    countRef.current = 0
    targetLockedRef.current = false
    setTracking({ state: 'loading', count: 0, targetLocked: false })

    const trackPeople = (timestamp: number) => {
      if (cancelled || !landmarker) return
      animationFrame = window.requestAnimationFrame(trackPeople)

      const video = videoRef.current
      if (
        timestamp - lastResultAt > STALE_VIDEO_MS &&
        (countRef.current !== 0 || targetLockedRef.current)
      ) {
        countRef.current = 0
        targetLockedRef.current = false
        candidateCount = 0
        candidateFrames = 0
        resetLock()
        clearHighlight(highlightCanvas)
        setTracking({ state: 'tracking', count: 0, targetLocked: false })
      }
      if (
        !video ||
        video.paused ||
        video.ended ||
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
          lastResultAt = performance.now()
          const detectedCount = result.landmarks.length
          if (detectedCount === candidateCount) {
            candidateFrames += 1
          } else {
            candidateCount = detectedCount
            candidateFrames = 1
          }
          const count =
            candidateFrames >= COUNT_CONFIRMATION_FRAMES
              ? candidateCount
              : countRef.current

          const masks = result.segmentationMasks ?? []
          let render: HighlightRender | null = null
          if (highlightCanvas && detectedCount > 0 && masks.length > 0) {
            render = renderHighlight(highlightCanvas, masks)
          } else {
            clearHighlight(highlightCanvas)
          }

          const centerCovered =
            (render !== null && maskCoversCenter(render)) ||
            poseCoversCenter(result.landmarks)
          const confidence =
            detectedCount === 1 ? coreConfidence(result.landmarks[0]) : 0
          const usable =
            detectedCount === 1 &&
            centerCovered &&
            confidence >=
              (lockEngaged ? LOCK_RELEASE_CONFIDENCE : LOCK_ACQUIRE_CONFIDENCE)
          const nowMs = performance.now()

          if (lockEngaged) {
            if (usable) {
              lockInvalidSinceMs = null
            } else {
              lockInvalidSinceMs ??= nowMs
              if (nowMs - lockInvalidSinceMs > LOCK_GRACE_MS) resetLock()
            }
          } else if (usable) {
            lockFrames += 1
            if (lockFrames >= LOCK_ACQUIRE_FRAMES) {
              lockEngaged = true
              lockInvalidSinceMs = null
            }
          } else {
            lockFrames = 0
          }
          const targetLocked = lockEngaged

          if (
            count !== countRef.current ||
            targetLocked !== targetLockedRef.current
          ) {
            countRef.current = count
            targetLockedRef.current = targetLocked
            setTracking({ state: 'tracking', count, targetLocked })
          }
        })
      } catch {
        cancelled = true
        landmarker.close()
        landmarker = null
        clearHighlight(highlightCanvas)
        setTracking({ state: 'error', count: 0, targetLocked: false })
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
        setTracking({ state: 'tracking', count: 0, targetLocked: false })
        animationFrame = window.requestAnimationFrame(trackPeople)
      } catch {
        if (!cancelled) {
          setTracking({ state: 'error', count: 0, targetLocked: false })
        }
      }
    }

    void startTracking()

    return () => {
      cancelled = true
      window.cancelAnimationFrame(animationFrame)
      landmarker?.close()
      clearHighlight(highlightCanvas)
    }
  }, [enabled, retryKey, videoRef])

  const retryPersonTracking = useCallback(() => {
    setRetryKey((current) => current + 1)
  }, [])

  return {
    highlightCanvasRef,
    personCount: tracking.count,
    targetLocked: tracking.targetLocked,
    personTrackingState: tracking.state,
    retryPersonTracking,
  }
}
