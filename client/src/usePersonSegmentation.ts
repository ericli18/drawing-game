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
const LOCK_MASK_THRESHOLD = 0.6
// Require most of a small region directly beneath the crosshair to be person
// pixels. This avoids locking when the reticle is merely near a pose.
const LOCK_REGION_EXTENT = 0.025
const LOCK_REGION_MIN_COVERAGE = 0.5
const LOCK_ACQUIRE_FRAMES = 3
// Full-body landmark visibility is diagnostic only. It naturally falls when a
// close-up face pushes shoulders or hips outside the frame.
const CORE_LANDMARK_INDICES = [0, 11, 12, 23, 24] as const
const STALE_VIDEO_MS = 1_000
const DIAGNOSTICS_INTERVAL_MS = 2_000
const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

type PersonTracking = {
  state: PersonTrackingState
  count: number
  targetLocked: boolean
}

type SegmentationMasks = {
  maskData: Float32Array[]
  width: number
  height: number
}

function readSegmentationMasks(masks: MPMask[]): SegmentationMasks {
  const firstMask = masks[0]
  return {
    maskData: masks.map((mask) => mask.getAsFloat32Array()),
    width: firstMask.width,
    height: firstMask.height,
  }
}

function fullBodyVisibility(pose: NormalizedLandmark[] | undefined) {
  if (!pose) return 0
  const scores = CORE_LANDMARK_INDICES.map(
    (index) => pose[index]?.visibility,
  ).filter((visibility): visibility is number => Number.isFinite(visibility))
  if (scores.length === 0) return 0
  return scores.reduce((sum, visibility) => sum + visibility, 0) / scores.length
}

function centerMaskStats({ maskData, width, height }: SegmentationMasks) {
  if (maskData.length === 0 || width === 0 || height === 0) {
    return {
      averageConfidence: 0,
      centerConfidence: 0,
      coverage: 0,
      maxConfidence: 0,
    }
  }

  const radiusX = Math.max(1, Math.round(width * LOCK_REGION_EXTENT))
  const radiusY = Math.max(1, Math.round(height * LOCK_REGION_EXTENT))
  const centerX = Math.floor(width / 2)
  const centerY = Math.floor(height / 2)
  let coveredPixels = 0
  let confidenceSum = 0
  let maxConfidence = 0
  let sampledPixels = 0
  let centerConfidence = 0

  for (let y = centerY - radiusY; y <= centerY + radiusY; y += 1) {
    const rowOffset = y * width
    for (let x = centerX - radiusX; x <= centerX + radiusX; x += 1) {
      sampledPixels += 1
      let pixelConfidence = 0
      for (const data of maskData) {
        pixelConfidence = Math.max(
          pixelConfidence,
          data[rowOffset + x] ?? 0,
        )
      }
      confidenceSum += pixelConfidence
      maxConfidence = Math.max(maxConfidence, pixelConfidence)
      if (x === centerX && y === centerY) centerConfidence = pixelConfidence
      if (pixelConfidence >= LOCK_MASK_THRESHOLD) coveredPixels += 1
    }
  }
  return {
    averageConfidence: confidenceSum / sampledPixels,
    centerConfidence,
    coverage: coveredPixels / sampledPixels,
    maxConfidence,
  }
}

async function createPoseLandmarker() {
  const { FilesetResolver, PoseLandmarker } = await import(
    '@mediapipe/tasks-vision'
  )
  const vision = await FilesetResolver.forVisionTasks(WASM_URL, false)
  const options = {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: 'GPU' as const,
    },
    runningMode: 'VIDEO' as const,
    canvas: document.createElement('canvas'),
    numPoses: MAX_POSES,
    minPoseDetectionConfidence: 0.6,
    minPosePresenceConfidence: 0.6,
    minTrackingConfidence: 0.6,
    outputSegmentationMasks: true,
  }

  try {
    return await PoseLandmarker.createFromOptions(vision, options)
  } catch (error) {
    console.warn(
      '[targeting] GPU initialization failed; falling back to CPU.',
      error,
    )
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
      return
    }

    let cancelled = false
    let animationFrame = 0
    let videoFrameCallback = 0
    let videoFrameSource: HTMLVideoElement | null = null
    let landmarker: PoseLandmarker | null = null
    let lastInferenceAt = -Infinity
    let lastResultAt = performance.now()
    let lastVideoTime = -1
    let candidateCount = 0
    let candidateFrames = 0
    let lockEngaged = false
    let lockFrames = 0
    const diagnosticsEnabled =
      new URLSearchParams(window.location.search).get('trackingDebug') === '1'
    let diagnosticsStartedAt = performance.now()
    let inferenceCount = 0
    let inferenceTotalMs = 0
    let inferenceMaxMs = 0
    let detectedCount = 0
    let centerCovered = false
    let maskStats = {
      averageConfidence: 0,
      centerConfidence: 0,
      coverage: 0,
      maxConfidence: 0,
    }
    let bodyVisibility = 0
    let lockEvidence = 'no pose'
    let hitEvidence = 'none'

    const resetLock = () => {
      lockEngaged = false
      lockFrames = 0
    }

    countRef.current = 0
    targetLockedRef.current = false
    setTracking({ state: 'loading', count: 0, targetLocked: false })

    const logDiagnostics = (
      nowMs: number,
      video: HTMLVideoElement | null,
    ) => {
      const elapsedMs = nowMs - diagnosticsStartedAt
      if (!diagnosticsEnabled || elapsedMs < DIAGNOSTICS_INTERVAL_MS) return

      console.info('[targeting] metrics', {
        inferenceFps: Number(((inferenceCount * 1_000) / elapsedMs).toFixed(1)),
        averagePipelineMs:
          inferenceCount === 0
            ? null
            : Number((inferenceTotalMs / inferenceCount).toFixed(1)),
        maxPipelineMs: Number(inferenceMaxMs.toFixed(1)),
        lastResultAgeMs: Number((nowMs - lastResultAt).toFixed(1)),
        videoTime: video ? Number(video.currentTime.toFixed(3)) : null,
        videoPaused: video?.paused ?? null,
        detectedCount,
        confirmedCount: countRef.current,
        centerCovered,
        maskAverageConfidence: Number(maskStats.averageConfidence.toFixed(3)),
        maskCenterConfidence: Number(maskStats.centerConfidence.toFixed(3)),
        maskCoverage: Number(maskStats.coverage.toFixed(3)),
        maskMaxConfidence: Number(maskStats.maxConfidence.toFixed(3)),
        fullBodyVisibility: Number(bodyVisibility.toFixed(3)),
        lockEvidence,
        hitEvidence,
        targetLocked: targetLockedRef.current,
        frameScheduler: videoFrameSource ? 'video frame' : 'animation frame',
      })
      diagnosticsStartedAt = nowMs
      inferenceCount = 0
      inferenceTotalMs = 0
      inferenceMaxMs = 0
    }

    const runInference = (video: HTMLVideoElement, timestamp: number) => {
      const currentLandmarker = landmarker
      if (
        !currentLandmarker ||
        video.paused ||
        video.ended ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        timestamp - lastInferenceAt < INFERENCE_INTERVAL_MS
      ) {
        return
      }

      lastInferenceAt = timestamp

      try {
        const inferenceStartedAt = performance.now()
        const result = currentLandmarker.detectForVideo(video, timestamp)
        const masks = result.segmentationMasks ?? []
        try {
          lastResultAt = performance.now()
          detectedCount = result.landmarks.length
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

          const segmentation =
            masks.length > 0 ? readSegmentationMasks(masks) : null

          maskStats =
            segmentation === null
              ? {
                  averageConfidence: 0,
                  centerConfidence: 0,
                  coverage: 0,
                  maxConfidence: 0,
                }
              : centerMaskStats(segmentation)
          centerCovered =
            maskStats.centerConfidence >= LOCK_MASK_THRESHOLD &&
            maskStats.coverage >= LOCK_REGION_MIN_COVERAGE
          hitEvidence = centerCovered ? 'segmentation mask' : 'none'
          bodyVisibility =
            detectedCount === 1
              ? fullBodyVisibility(result.landmarks[0])
              : 0
          const usable = detectedCount === 1 && centerCovered
          lockEvidence =
            detectedCount !== 1
              ? `pose count ${detectedCount}`
              : !centerCovered
                ? 'off center'
                : 'eligible'
          if (lockEngaged) {
            if (!usable) resetLock()
          } else if (usable) {
            lockFrames += 1
            if (lockFrames >= LOCK_ACQUIRE_FRAMES) {
              lockEngaged = true
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
        } finally {
          for (const mask of masks) mask.close()
        }
        const inferenceMs = performance.now() - inferenceStartedAt
        inferenceCount += 1
        inferenceTotalMs += inferenceMs
        inferenceMaxMs = Math.max(inferenceMaxMs, inferenceMs)
      } catch (error) {
        console.error('[targeting] Inference failed.', error)
        cancelled = true
        currentLandmarker.close()
        landmarker = null
        setTracking({ state: 'error', count: 0, targetLocked: false })
      }
    }

    // Live camera currentTime can stall even while frames are being presented,
    // so use the browser's frame-delivery callback whenever it is available.
    const trackVideoFrame = (timestamp: number) => {
      const video = videoFrameSource
      if (cancelled || !landmarker || !video) return
      runInference(video, timestamp)
      if (!cancelled && landmarker) {
        videoFrameCallback = video.requestVideoFrameCallback(trackVideoFrame)
      }
    }

    // This loop remains as the stale-stream watchdog and older-browser fallback.
    const trackPeople = (timestamp: number) => {
      if (cancelled || !landmarker) return
      animationFrame = window.requestAnimationFrame(trackPeople)

      const video = videoRef.current
      logDiagnostics(timestamp, video)
      if (
        timestamp - lastResultAt > STALE_VIDEO_MS &&
        (countRef.current !== 0 || targetLockedRef.current)
      ) {
        countRef.current = 0
        targetLockedRef.current = false
        candidateCount = 0
        candidateFrames = 0
        resetLock()
        setTracking({ state: 'tracking', count: 0, targetLocked: false })
      }
      if (!video || videoFrameSource || video.currentTime === lastVideoTime) {
        return
      }

      lastVideoTime = video.currentTime
      runInference(video, timestamp)
    }

    const startTracking = async () => {
      try {
        const instance = await createPoseLandmarker()
        if (cancelled) {
          instance.close()
          return
        }

        landmarker = instance
        const video = videoRef.current
        if (video && typeof video.requestVideoFrameCallback === 'function') {
          videoFrameSource = video
          videoFrameCallback = video.requestVideoFrameCallback(trackVideoFrame)
        }
        setTracking({ state: 'tracking', count: 0, targetLocked: false })
        animationFrame = window.requestAnimationFrame(trackPeople)
      } catch (error) {
        console.error('[targeting] Initialization failed.', error)
        if (!cancelled) {
          setTracking({ state: 'error', count: 0, targetLocked: false })
        }
      }
    }

    void startTracking()

    return () => {
      cancelled = true
      window.cancelAnimationFrame(animationFrame)
      if (videoFrameSource && videoFrameCallback) {
        videoFrameSource.cancelVideoFrameCallback(videoFrameCallback)
      }
      landmarker?.close()
    }
  }, [enabled, retryKey, videoRef])

  const retryPersonTracking = useCallback(() => {
    setRetryKey((current) => current + 1)
  }, [])

  return {
    personCount: tracking.count,
    targetLocked: tracking.targetLocked,
    personTrackingState: tracking.state,
    retryPersonTracking,
  }
}
