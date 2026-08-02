import { useCallback, useEffect, useRef } from 'react'

export type GameSound =
  | 'shot'
  | 'hit'
  | 'miss'
  | 'blocked'
  | 'reflected'
  | 'spell-plus'
  | 'spell-minus'
  | 'spell-circle'
  | 'spell-star'
  | 'spell-triangle'
  | 'reload'

const SOUND_URLS: Record<GameSound, string> = {
  shot: '/sounds/shot.mp3',
  hit: '/sounds/hit.mp3',
  miss: '/sounds/miss.mp3',
  blocked: '/sounds/blocked.mp3',
  reflected: '/sounds/reflected.mp3',
  'spell-plus': '/sounds/spell-plus.mp3',
  'spell-minus': '/sounds/spell-minus.mp3',
  'spell-circle': '/sounds/spell-circle.mp3',
  'spell-star': '/sounds/spell-star.mp3',
  'spell-triangle': '/sounds/spell-triangle.mp3',
  reload: '/sounds/reload.mp3',
}

const SOUND_NAMES = Object.keys(SOUND_URLS) as GameSound[]

export function useGameAudio() {
  const contextRef = useRef<AudioContext | null>(null)
  const buffersRef = useRef(new Map<GameSound, AudioBuffer>())
  const loadingRef = useRef(
    new Map<GameSound, Promise<AudioBuffer | null>>(),
  )

  const loadSound = useCallback((context: AudioContext, sound: GameSound) => {
    const cached = buffersRef.current.get(sound)
    if (cached) return Promise.resolve(cached)

    const pending = loadingRef.current.get(sound)
    if (pending) return pending

    const loading = fetch(SOUND_URLS[sound])
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load ${sound}`)
        return response.arrayBuffer()
      })
      .then((data) => context.decodeAudioData(data))
      .then((buffer) => {
        buffersRef.current.set(sound, buffer)
        return buffer
      })
      .catch(() => null)
      .finally(() => loadingRef.current.delete(sound))

    loadingRef.current.set(sound, loading)
    return loading
  }, [])

  const unlockAudio = useCallback(() => {
    const context = contextRef.current ?? new AudioContext()
    contextRef.current = context

    if (context.state !== 'running') {
      void context.resume()
    }

    for (const sound of SOUND_NAMES) {
      void loadSound(context, sound)
    }
  }, [loadSound])

  const playSound = useCallback(
    (sound: GameSound) => {
      const context = contextRef.current
      if (!context) return

      const play = async () => {
        if (context.state !== 'running') {
          await context.resume().catch(() => undefined)
        }
        if (context.state !== 'running') return

        const buffer = await loadSound(context, sound)
        if (!buffer || context.state !== 'running') return

        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        source.start()
      }

      void play()
    },
    [loadSound],
  )

  useEffect(
    () => () => {
      const context = contextRef.current
      contextRef.current = null
      buffersRef.current.clear()
      loadingRef.current.clear()
      if (context && context.state !== 'closed') void context.close()
    },
    [],
  )

  return { unlockAudio, playSound }
}
