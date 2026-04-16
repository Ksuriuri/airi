import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import vadWorkletUrl from '../../workers/vad/process.worklet?worker&url'

/** Classification result returned by the perception WebSocket server. */
export interface PerceptionEvent {
  eventType: string
  confidence: number
  summary: string
  timestamp: number
  latencyMs: number
}

const MAX_RECENT_EVENTS = 20
const DEFAULT_WS_URL = 'ws://34.158.211.232:8080/v1/ws'
const DEFAULT_ENCODING = 'pcm_s16le'
const DEFAULT_TARGET_SAMPLE_RATE = 16000
const DEFAULT_TIMEOUT_S = 10

/**
 * Default volume threshold (RMS of float32 samples, range 0..1).
 * Audio below this level is considered silence and will not be sent for classification.
 */
const DEFAULT_VOLUME_THRESHOLD = 0.015

/**
 * Pre-roll / post-roll context kept around a detected loud segment, in seconds.
 * This ensures the classifier receives some silence context before and after the event.
 */
const DEFAULT_CONTEXT_PADDING_S = 0.5

/** How often (ms) the pipeline checks whether a loud segment has ended. */
const POLL_INTERVAL_MS = 100

/**
 * Settings and state store for environmental audio perception.
 *
 * Use when:
 * - Configuring the WS classification endpoint
 * - Reading recent environmental sound events
 * - Checking whether perception is configured and enabled
 *
 * Expects:
 * - Settings are persisted via localStorage
 *
 * Returns:
 * - Reactive settings refs and a rolling `recentEvents` array
 */
export const usePerceptionStore = defineStore('modules:perception', () => {
  const wsUrl = useLocalStorageManualReset('settings/perception/ws-url', DEFAULT_WS_URL)
  const encoding = useLocalStorageManualReset('settings/perception/encoding', DEFAULT_ENCODING)
  const targetSampleRate = useLocalStorageManualReset('settings/perception/target-sample-rate', DEFAULT_TARGET_SAMPLE_RATE)
  const timeout = useLocalStorageManualReset('settings/perception/timeout', DEFAULT_TIMEOUT_S)
  const enabled = useLocalStorageManualReset('settings/perception/enabled', false)

  /** RMS threshold (0..1). Audio louder than this triggers classification. */
  const volumeThreshold = useLocalStorageManualReset('settings/perception/volume-threshold', DEFAULT_VOLUME_THRESHOLD)

  /** Seconds of audio context kept before and after the loud segment. */
  const contextPaddingS = useLocalStorageManualReset('settings/perception/context-padding-s', DEFAULT_CONTEXT_PADDING_S)

  /** When true, a perception event will automatically trigger an AI response. */
  const autoRespond = useLocalStorageManualReset('settings/perception/auto-respond', true)

  const recentEvents = ref<PerceptionEvent[]>([])

  const latestEvent = computed<PerceptionEvent | undefined>(() => recentEvents.value[recentEvents.value.length - 1])

  const configured = computed(() => !!wsUrl.value && enabled.value)

  function pushEvent(event: PerceptionEvent) {
    recentEvents.value = [...recentEvents.value, event].slice(-MAX_RECENT_EVENTS)
  }

  function clearEvents() {
    recentEvents.value = []
  }

  function resetState() {
    wsUrl.reset()
    encoding.reset()
    targetSampleRate.reset()
    timeout.reset()
    enabled.reset()
    volumeThreshold.reset()
    contextPaddingS.reset()
    autoRespond.reset()
    clearEvents()
  }

  return {
    wsUrl,
    encoding,
    targetSampleRate,
    timeout,
    enabled,
    volumeThreshold,
    contextPaddingS,
    autoRespond,

    recentEvents,
    latestEvent,
    configured,

    pushEvent,
    clearEvents,
    resetState,
  }
})

function float32ToInt16(buffer: Float32Array): Int16Array {
  const output = new Int16Array(buffer.length)
  for (let i = 0; i < buffer.length; i++) {
    const value = Math.max(-1, Math.min(1, buffer[i]))
    output[i] = value < 0 ? value * 0x8000 : value * 0x7FFF
  }
  return output
}

/** Compute root-mean-square of a float32 audio buffer (range 0..1). */
function computeRMS(buffer: Float32Array): number {
  let sumSq = 0
  for (let i = 0; i < buffer.length; i++)
    sumSq += buffer[i] * buffer[i]
  return Math.sqrt(sumSq / buffer.length)
}

/**
 * Parses the JSON response from the perception WS server.
 *
 * The server sometimes nests the actual fields inside `summary` as a JSON string,
 * mirroring the Python reference's `_parse_result` logic.
 */
function parseClassifyResponse(raw: string): { eventType: string, confidence: number, summary: string } {
  const resp = JSON.parse(raw) as Record<string, unknown>

  let eventType = String(resp.event_type ?? 'unknown')
  let confidence = Number(resp.confidence ?? 0)
  let summary = String(resp.summary ?? '')

  if (eventType === 'unknown' && confidence === 0 && summary) {
    try {
      const inner = JSON.parse(summary) as Record<string, unknown>
      eventType = String(inner.event_type ?? eventType)
      confidence = Number(inner.confidence ?? confidence)
      summary = String(inner.summary ?? summary)
    }
    catch {
      // summary was not nested JSON, keep as-is
    }
  }

  return { eventType, confidence, summary }
}

/**
 * Runtime pipeline for environmental audio perception with volume-threshold gating.
 *
 * Instead of continuously sending audio for classification, the pipeline keeps a
 * rolling pre-roll ring buffer. When the audio volume exceeds the configured threshold
 * it starts recording. After the volume drops back below the threshold for the
 * post-roll duration, the accumulated segment (pre-roll + loud part + post-roll) is
 * flushed to the WS server for classification.
 *
 * Use when:
 * - Starting/stopping volume-gated audio classification against the WS server
 *
 * Expects:
 * - A valid MediaStream from the audio device
 * - `usePerceptionStore` to be configured and enabled
 *
 * Returns:
 * - `start(stream)` / `stop()` lifecycle, reactive `isRunning` / `currentVolume` flags,
 *   and an `onEvent` hook for callers to react to classification results
 *
 * Call stack:
 *
 * start(stream)
 * -> AudioWorkletNode (vad-audio-worklet-processor)
 * -> volume gating (pre-roll ring buffer + post-roll timer)
 * -> WebSocket connect + session.config
 * -> classify (send JSON + binary, receive JSON)
 * -> {@link usePerceptionStore}.pushEvent()
 * -> onEvent callbacks
 */
export const usePerceptionPipeline = defineStore('modules:perception:pipeline', () => {
  const perceptionStore = usePerceptionStore()
  const isRunning = ref(false)
  const error = ref<string>()

  /** Current audio RMS level (0..1), updated every worklet chunk for UI visualisation. */
  const currentVolume = ref(0)

  /** Whether the pipeline is currently capturing a loud segment. */
  const isCapturing = ref(false)

  /** Registered callbacks invoked after each successful classification. */
  const eventCallbacks: Array<(event: PerceptionEvent) => void> = []

  /**
   * Register a callback that fires whenever a perception event is classified.
   * Returns an unsubscribe function.
   */
  function onEvent(cb: (event: PerceptionEvent) => void): () => void {
    eventCallbacks.push(cb)
    return () => {
      const idx = eventCallbacks.indexOf(cb)
      if (idx !== -1)
        eventCallbacks.splice(idx, 1)
    }
  }

  const session = shallowRef<{
    audioContext: AudioContext
    workletNode: AudioWorkletNode
    mediaStreamSource: MediaStreamAudioSourceNode
    ws: WebSocket | null
    /** Ring buffer holding the last N chunks as pre-roll context. */
    preRollRing: { pcm: Int16Array, rms: number }[]
    /** Maximum number of chunks kept in the pre-roll ring (derived from contextPaddingS). */
    preRollMaxChunks: number
    /** Chunks accumulated during a loud segment (including pre-roll snapshot and post-roll). */
    captureBuffer: Int16Array[]
    /** Timestamp (ms) when volume last dropped below threshold during a capture. */
    silenceStartedAt: number | null
    pollTimer: ReturnType<typeof setInterval> | null
    requestId: number
    stopped: boolean
    classifying: boolean
  }>()

  function connectWs(): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(perceptionStore.wsUrl, ['perception.v1'])
      ws.binaryType = 'arraybuffer'

      const timeoutId = setTimeout(() => {
        ws.close()
        reject(new Error(`WebSocket connection timed out after ${perceptionStore.timeout}s`))
      }, perceptionStore.timeout * 1000)

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'session.config',
          sample_rate: perceptionStore.targetSampleRate,
          encoding: perceptionStore.encoding,
          channels: 1,
          prompt: [
            'Identify the sound. Respond with JSON only, no markdown.',
            'Fields: event_type (e.g. speech / human_activity / music / notification / mechanical / alarm / media_playback), confidence (0-1), summary (one sentence).',
            '{"event_type":"human_activity","confidence":0.92,"summary":"..."} # specific content for speech',
          ].join('\n'),
        }))
      }

      ws.onmessage = (event) => {
        clearTimeout(timeoutId)
        try {
          const resp = JSON.parse(event.data as string) as Record<string, unknown>
          if (resp.type === 'error') {
            reject(new Error(`Server rejected session config: ${resp.message ?? JSON.stringify(resp)}`))
            return
          }
          if (resp.type === 'session.ready') {
            resolve(ws)
            return
          }
          reject(new Error(`Expected session.ready, got: ${String(resp.type)}`))
        }
        catch (err) {
          reject(err)
        }
      }

      ws.onerror = () => {
        clearTimeout(timeoutId)
        reject(new Error('WebSocket connection error'))
      }

      ws.onclose = () => {
        clearTimeout(timeoutId)
      }
    })
  }

  function sendClassify(ws: WebSocket, requestId: number, pcmBytes: ArrayBuffer): Promise<PerceptionEvent> {
    return new Promise<PerceptionEvent>((resolve, reject) => {
      const t0 = performance.now()

      const timeoutId = setTimeout(() => {
        cleanup()
        reject(new Error('Classify response timed out'))
      }, perceptionStore.timeout * 1000)

      function onMessage(event: MessageEvent) {
        clearTimeout(timeoutId)
        cleanup()
        try {
          const parsed = parseClassifyResponse(event.data as string)
          resolve({
            ...parsed,
            timestamp: Date.now(),
            latencyMs: Math.round(performance.now() - t0),
          })
        }
        catch (err) {
          reject(err)
        }
      }

      function onWsError() {
        clearTimeout(timeoutId)
        cleanup()
        reject(new Error('WebSocket error during classify'))
      }

      function cleanup() {
        ws.removeEventListener('message', onMessage)
        ws.removeEventListener('error', onWsError)
      }

      ws.addEventListener('message', onMessage)
      ws.addEventListener('error', onWsError)

      ws.send(JSON.stringify({ type: 'classify', id: requestId }))
      ws.send(pcmBytes)
    })
  }

  /** Merge an array of Int16Array chunks into a single ArrayBuffer. */
  function mergeChunks(chunks: Int16Array[]): ArrayBuffer {
    const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0)
    const merged = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset)
      offset += chunk.byteLength
    }
    return merged.buffer
  }

  /** Flush the captured segment to the WS server for classification. */
  async function flushCapture() {
    const s = session.value
    if (!s || s.stopped || s.classifying)
      return
    if (s.captureBuffer.length === 0)
      return

    // Drain capture buffer
    const chunks = s.captureBuffer.splice(0)
    const pcmBytes = mergeChunks(chunks)
    if (pcmBytes.byteLength === 0)
      return

    // Ensure WS is connected
    if (!s.ws || s.ws.readyState !== WebSocket.OPEN) {
      await reconnect()
      if (!s.ws || s.ws.readyState !== WebSocket.OPEN)
        return
    }

    s.requestId++
    s.classifying = true

    try {
      const event = await sendClassify(s.ws, s.requestId, pcmBytes)
      if (event.eventType !== 'error') {
        perceptionStore.pushEvent(event)
        for (const cb of eventCallbacks)
          cb(event)
      }
    }
    catch (err) {
      console.warn('[Perception] classify failed:', err)
      await reconnect()
    }
    finally {
      s.classifying = false
    }
  }

  async function reconnect() {
    const s = session.value
    if (!s || s.stopped)
      return

    if (s.ws) {
      try {
        s.ws.close()
      }
      catch {}
      s.ws = null
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (s.stopped)
        return
      try {
        const ws = await connectWs()
        s.ws = ws
        installWsErrorHandler(ws)
        console.info(`[Perception] Reconnected on attempt ${attempt}`)
        return
      }
      catch (err) {
        console.warn(`[Perception] Reconnect attempt ${attempt} failed:`, err)
      }
    }

    error.value = 'All reconnect attempts failed'
    console.error('[Perception] All reconnect attempts failed, stopping pipeline')
    stop()
  }

  function installWsErrorHandler(ws: WebSocket) {
    ws.onclose = () => {
      const s = session.value
      if (s && !s.stopped) {
        console.warn('[Perception] WebSocket closed unexpectedly, will reconnect on next classify')
        s.ws = null
      }
    }
    ws.onerror = () => {
      const s = session.value
      if (s && !s.stopped) {
        console.warn('[Perception] WebSocket error, will reconnect on next classify')
        try {
          ws.close()
        }
        catch {}
        s.ws = null
      }
    }
  }

  /**
   * Poll function called at a fixed interval.
   *
   * Manages the state machine:
   * - **idle**: chunks go into the pre-roll ring; if any chunk exceeds threshold -> transition to capturing
   * - **capturing**: chunks accumulate; when silence lasts longer than contextPaddingS -> flush and return to idle
   */
  function pollCaptureState() {
    const s = session.value
    if (!s || s.stopped)
      return

    const threshold = perceptionStore.volumeThreshold
    const postRollMs = perceptionStore.contextPaddingS * 1000

    if (!isCapturing.value) {
      // Check if any chunk in the pre-roll ring exceeds threshold
      const loudIdx = s.preRollRing.findIndex(c => c.rms > threshold)
      if (loudIdx !== -1) {
        // Transition to capturing: copy pre-roll into capture buffer
        isCapturing.value = true
        s.silenceStartedAt = null
        for (const entry of s.preRollRing)
          s.captureBuffer.push(entry.pcm)
        s.preRollRing.length = 0
        console.info('[Perception] Volume exceeded threshold, started capturing')
      }
    }
    else {
      // Currently capturing — check if silence has lasted long enough for post-roll
      // The latest RMS is tracked via currentVolume (updated per-chunk)
      if (currentVolume.value <= threshold) {
        if (s.silenceStartedAt === null) {
          s.silenceStartedAt = Date.now()
        }
        else if (Date.now() - s.silenceStartedAt >= postRollMs) {
          // Silence exceeded post-roll duration -> flush
          isCapturing.value = false
          s.silenceStartedAt = null
          console.info('[Perception] Silence exceeded post-roll, flushing captured segment')
          void flushCapture()
        }
      }
      else {
        // Still loud — reset silence timer
        s.silenceStartedAt = null
      }
    }
  }

  /**
   * Starts the perception pipeline with volume-threshold gating.
   *
   * Audio chunks from the worklet are routed into either a pre-roll ring buffer (idle)
   * or the capture buffer (active). Classification is triggered only when a loud segment
   * finishes (volume drops below threshold for contextPaddingS seconds).
   */
  async function start(stream: MediaStream) {
    if (isRunning.value)
      return

    error.value = undefined

    try {
      const sampleRate = perceptionStore.targetSampleRate
      const audioContext = new AudioContext({ sampleRate, latencyHint: 'interactive' })
      await audioContext.audioWorklet.addModule(vadWorkletUrl)
      const workletNode = new AudioWorkletNode(audioContext, 'vad-audio-worklet-processor')

      // Pre-roll ring: how many chunks fit in contextPaddingS at the given sample rate.
      // Each worklet chunk is typically 512 samples.
      const chunkSamples = 512
      const preRollMaxChunks = Math.max(1, Math.ceil((perceptionStore.contextPaddingS * sampleRate) / chunkSamples))

      const preRollRing: { pcm: Int16Array, rms: number }[] = []
      const captureBuffer: Int16Array[] = []

      workletNode.port.onmessage = ({ data }: MessageEvent<{ buffer?: Float32Array }>) => {
        const buffer = data?.buffer
        if (!buffer)
          return

        const rms = computeRMS(buffer)
        currentVolume.value = rms

        const pcm = float32ToInt16(buffer)

        if (isCapturing.value) {
          captureBuffer.push(pcm)
        }
        else {
          preRollRing.push({ pcm, rms })
          // Trim ring to max size
          while (preRollRing.length > preRollMaxChunks)
            preRollRing.shift()
        }
      }

      const mediaStreamSource = audioContext.createMediaStreamSource(stream)
      mediaStreamSource.connect(workletNode)

      // Silent sink to avoid feedback
      const silentGain = audioContext.createGain()
      silentGain.gain.value = 0
      workletNode.connect(silentGain)
      silentGain.connect(audioContext.destination)

      // Connect to WS server
      let ws: WebSocket | null = null
      try {
        ws = await connectWs()
      }
      catch (err) {
        console.warn('[Perception] Initial WS connection failed:', err)
      }

      const newSession = {
        audioContext,
        workletNode,
        mediaStreamSource,
        ws,
        preRollRing,
        preRollMaxChunks,
        captureBuffer,
        silenceStartedAt: null as number | null,
        pollTimer: null as ReturnType<typeof setInterval> | null,
        requestId: 0,
        stopped: false,
        classifying: false,
      }

      if (ws)
        installWsErrorHandler(ws)

      // Poll capture state at a fixed interval
      newSession.pollTimer = setInterval(pollCaptureState, POLL_INTERVAL_MS)

      session.value = newSession
      isRunning.value = true
      console.info('[Perception] Pipeline started (volume-gated)')
    }
    catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      console.error('[Perception] Failed to start pipeline:', err)
    }
  }

  /** Tears down the audio graph, WebSocket, and poll timer. */
  function stop() {
    const s = session.value
    if (!s)
      return

    s.stopped = true

    if (s.pollTimer) {
      clearInterval(s.pollTimer)
      s.pollTimer = null
    }

    if (s.ws) {
      try {
        s.ws.close()
      }
      catch {}
      s.ws = null
    }

    try {
      s.mediaStreamSource.disconnect()
      s.workletNode.port.onmessage = null
      s.workletNode.disconnect()
    }
    catch {}

    try {
      void s.audioContext.close()
    }
    catch {}

    s.preRollRing.length = 0
    s.captureBuffer.length = 0

    session.value = undefined
    isRunning.value = false
    isCapturing.value = false
    currentVolume.value = 0

    // Clear all event callbacks on stop
    eventCallbacks.length = 0

    console.info('[Perception] Pipeline stopped')
  }

  return {
    isRunning,
    isCapturing,
    currentVolume,
    error,
    start,
    stop,
    onEvent,
  }
})
