import type { PerceptionEvent } from '../stores/modules/perception'

import { computed, onScopeDispose, ref, watch } from 'vue'

import { useSpeakingStore } from '../stores/audio'
import { useChatOrchestratorStore } from '../stores/chat'
import { usePerceptionPipeline, usePerceptionStore } from '../stores/modules/perception'

/**
 * Composable that auto-responds to perception events with busy-state buffering.
 *
 * When the model is idle (not generating text and not playing TTS), perception
 * events trigger an immediate response. When the model is busy, events are
 * accumulated in a queue. Once the model returns to idle, all queued events
 * are consolidated into a single prompt and sent at once.
 *
 * Use when:
 * - Setting up automatic AI responses to environmental sound events
 * - Both stage-web and stage-tamagotchi index pages
 *
 * Expects:
 * - `send` callback that handles the actual chat ingestion
 * - Perception pipeline to be running and `autoRespond` enabled
 *
 * Returns:
 * - `pendingEvents`: reactive ref of buffered events waiting to be sent
 * - `cleanup`: function to unsubscribe and clear state
 */
export function usePerceptionAutoRespond(options: {
  send: (prompt: string) => Promise<void> | void
}) {
  const perceptionStore = usePerceptionStore()
  const perceptionPipeline = usePerceptionPipeline()
  const chatOrchestrator = useChatOrchestratorStore()
  const speakingStore = useSpeakingStore()

  const pendingEvents = ref<PerceptionEvent[]>([])

  const isBusy = computed(() => chatOrchestrator.sending || speakingStore.nowSpeaking)

  function formatConsolidatedPrompt(events: PerceptionEvent[]): string {
    if (events.length === 1) {
      const e = events[0]
      return `[Environmental sound detected] ${e.eventType} (confidence: ${e.confidence.toFixed(2)}): ${e.summary}`
    }

    const descriptions = events.map((e) => {
      const agoSeconds = Math.round((Date.now() - e.timestamp) / 1000)
      return `- [${agoSeconds}s ago] ${e.eventType} (confidence: ${e.confidence.toFixed(2)}): ${e.summary}`
    })

    return `[Multiple environmental sounds detected while you were speaking]\n${descriptions.join('\n')}`
  }

  async function flushPendingEvents() {
    if (pendingEvents.value.length === 0)
      return

    const events = pendingEvents.value.splice(0)
    const prompt = formatConsolidatedPrompt(events)

    try {
      await options.send(prompt)
    }
    catch (err) {
      console.error('[PerceptionAutoRespond] Failed to send consolidated events:', err)
    }
  }

  const stopBusyWatch = watch(isBusy, (busy, wasBusy) => {
    if (wasBusy && !busy && pendingEvents.value.length > 0) {
      void flushPendingEvents()
    }
  })

  const unsubPerception = perceptionPipeline.onEvent((event) => {
    if (!perceptionStore.autoRespond)
      return

    if (isBusy.value) {
      pendingEvents.value = [...pendingEvents.value, event]
      return
    }

    const prompt = formatConsolidatedPrompt([event])
    void options.send(prompt)
  })

  function cleanup() {
    stopBusyWatch()
    unsubPerception()
    pendingEvents.value = []
  }

  onScopeDispose(cleanup)

  return {
    pendingEvents,
    cleanup,
  }
}
