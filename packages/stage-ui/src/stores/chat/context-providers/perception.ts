import type { ContextMessage } from '../../../types/chat'

import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'

import { usePerceptionStore } from '../../modules/perception'

const PERCEPTION_CONTEXT_ID = 'system:perception'

/** Maximum age in milliseconds for events to include in the context snapshot. */
const CONTEXT_WINDOW_MS = 60_000

/**
 * Creates a context message summarizing recent environmental audio perception events.
 *
 * Use when:
 * - Injecting ambient sound awareness into the chat context before each LLM turn
 *
 * Expects:
 * - `usePerceptionStore` to be configured and enabled with recent events
 *
 * Returns:
 * - A `ContextMessage` with a natural-language summary of recent sounds, or `null` if
 *   perception is not active or there are no recent events
 */
export function createPerceptionContext(): ContextMessage | null {
  const perceptionStore = usePerceptionStore()

  if (!perceptionStore.configured || !perceptionStore.enabled)
    return null

  const now = Date.now()
  const recentEvents = perceptionStore.recentEvents.filter(
    e => (now - e.timestamp) < CONTEXT_WINDOW_MS,
  )

  if (recentEvents.length === 0)
    return null

  const eventDescriptions = recentEvents.map((e) => {
    const agoSeconds = Math.round((now - e.timestamp) / 1000)
    return `[${agoSeconds}s ago] ${e.eventType} (confidence: ${e.confidence.toFixed(2)}) - "${e.summary}"`
  })

  const text = [
    'Environmental audio perception is active.',
    'AIRI can hear ambient sounds in the environment and should respond naturally when relevant.',
    `Recent detected sounds:\n${eventDescriptions.join('\n')}`,
    'Use these environmental cues to inform your response when appropriate.',
    'For example, if an alarm is heard, express concern; if music is playing, you may comment on it.',
  ].join(' ')

  return {
    id: nanoid(),
    contextId: PERCEPTION_CONTEXT_ID,
    strategy: ContextUpdateStrategy.ReplaceSelf,
    text,
    createdAt: now,
    metadata: {
      source: {
        id: PERCEPTION_CONTEXT_ID,
        kind: 'plugin',
        plugin: {
          id: 'airi:system:perception',
        },
      },
    },
  }
}
