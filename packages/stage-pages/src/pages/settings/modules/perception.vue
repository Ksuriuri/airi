<script setup lang="ts">
import type { PerceptionEvent } from '@proj-airi/stage-ui/stores/modules/perception'

import { usePerceptionPipeline, usePerceptionStore } from '@proj-airi/stage-ui/stores/modules/perception'
import { useSettingsAudioDevice } from '@proj-airi/stage-ui/stores/settings'
import { Button, FieldCheckbox, FieldInput, FieldRange, FieldSelect } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const perceptionStore = usePerceptionStore()
const {
  wsUrl,
  encoding,
  targetSampleRate,
  timeout,
  volumeThreshold,
  contextPaddingS,
  autoRespond,
  enabled,
  recentEvents,
  configured,
} = storeToRefs(perceptionStore)

const pipeline = usePerceptionPipeline()
const { isRunning, isCapturing, currentVolume, error: pipelineError } = storeToRefs(pipeline)

const settingsAudioDeviceStore = useSettingsAudioDevice()
const { stream, selectedAudioInput } = storeToRefs(settingsAudioDeviceStore)
const { startStream, stopStream } = settingsAudioDeviceStore

const testStreamWasStarted = ref(false)

const encodingOptions = [
  { label: 'PCM Signed 16-bit LE', value: 'pcm_s16le' },
  { label: 'PCM Float 32-bit LE', value: 'pcm_f32le' },
]

const sampleRateOptions = [
  { label: '16000 Hz', value: '16000' },
  { label: '22050 Hz', value: '22050' },
  { label: '44100 Hz', value: '44100' },
  { label: '48000 Hz', value: '48000' },
]

const canStartPipeline = computed(() => configured.value && !!stream.value)

/** Volume bar width as a percentage (0..100), capped at 100. */
const volumeBarPercent = computed(() => Math.min(100, currentVolume.value * 1000))

/** Threshold marker position as a percentage of the bar. */
const thresholdPercent = computed(() => Math.min(100, volumeThreshold.value * 1000))

function formatEvent(event: PerceptionEvent): string {
  const agoSeconds = Math.round((Date.now() - event.timestamp) / 1000)
  return `[${agoSeconds}s ago] ${event.eventType} (${(event.confidence * 100).toFixed(0)}%) — ${event.summary} [${event.latencyMs}ms]`
}

function eventTypeColor(eventType: string): string {
  const colors: Record<string, string> = {
    speech: 'text-blue-500',
    human_activity: 'text-green-500',
    music: 'text-purple-500',
    alarm: 'text-red-500',
    notification: 'text-amber-500',
    mechanical: 'text-neutral-500',
    media_playback: 'text-indigo-500',
    error: 'text-red-600',
  }
  return colors[eventType] ?? 'text-neutral-400'
}

async function togglePipeline() {
  if (isRunning.value) {
    pipeline.stop()
    if (testStreamWasStarted.value) {
      stopStream()
      testStreamWasStarted.value = false
    }
    return
  }

  if (!stream.value) {
    testStreamWasStarted.value = true
    await startStream()
  }

  if (stream.value) {
    await pipeline.start(stream.value)
  }
}

watch(enabled, (val) => {
  if (!val && isRunning.value) {
    pipeline.stop()
  }
})

onUnmounted(() => {
  if (isRunning.value) {
    pipeline.stop()
  }
  if (testStreamWasStarted.value) {
    stopStream()
    testStreamWasStarted.value = false
  }
})
</script>

<template>
  <div :class="['flex flex-col gap-6', 'md:flex-row']">
    <!-- Configuration panel -->
    <div
      :class="[
        'flex flex-col gap-4 rounded-xl p-4 h-fit',
        'w-full md:w-[40%]',
        'bg-neutral-100 dark:bg-[rgba(0,0,0,0.3)]',
      ]"
    >
      <!-- Enable toggle -->
      <FieldCheckbox
        v-model="enabled"
        :label="t('settings.pages.modules.perception.sections.section.status.enabled')"
        description="Enable environmental audio perception to classify ambient sounds and provide context to the AI."
      />

      <!-- Auto-respond toggle -->
      <FieldCheckbox
        v-model="autoRespond"
        :label="t('settings.pages.modules.perception.sections.section.auto-respond.label')"
        :description="t('settings.pages.modules.perception.sections.section.auto-respond.description')"
      />

      <!-- Connection settings -->
      <div :class="['flex flex-col gap-4', 'border-t border-neutral-200 pt-4 dark:border-neutral-700']">
        <div>
          <h2 :class="['text-lg md:text-2xl', 'text-neutral-500 dark:text-neutral-500']">
            {{ t('settings.pages.modules.perception.sections.section.connection.title') }}
          </h2>
          <div :class="['text-neutral-400 dark:text-neutral-400']">
            {{ t('settings.pages.modules.perception.sections.section.connection.description') }}
          </div>
        </div>

        <FieldInput
          v-model="wsUrl"
          label="WebSocket URL"
          description="The WebSocket endpoint of the perception classification server."
          placeholder="ws://localhost:8080/v1/ws"
        />

        <FieldRange
          v-model="timeout"
          label="Timeout (seconds)"
          description="Maximum time to wait for a response from the server."
          :min="3"
          :max="30"
          :step="1"
          :format-value="(v: number) => `${v}s`"
        />
      </div>

      <!-- Audio settings -->
      <div :class="['flex flex-col gap-4', 'border-t border-neutral-200 pt-4 dark:border-neutral-700']">
        <div>
          <h2 :class="['text-lg md:text-2xl', 'text-neutral-500 dark:text-neutral-500']">
            {{ t('settings.pages.modules.perception.sections.section.audio.title') }}
          </h2>
          <div :class="['text-neutral-400 dark:text-neutral-400']">
            {{ t('settings.pages.modules.perception.sections.section.audio.description') }}
          </div>
        </div>

        <FieldSelect
          v-model="encoding"
          label="Encoding"
          description="Audio encoding format for PCM data sent to the server."
          :options="encodingOptions"
        />

        <FieldSelect
          :model-value="String(targetSampleRate)"
          label="Sample Rate"
          description="Target sample rate for audio sent to the classification server."
          :options="sampleRateOptions"
          @update:model-value="(v: string | undefined) => targetSampleRate = Number(v ?? targetSampleRate)"
        />
      </div>

      <!-- Volume threshold settings -->
      <div :class="['flex flex-col gap-4', 'border-t border-neutral-200 pt-4 dark:border-neutral-700']">
        <div>
          <h2 :class="['text-lg md:text-2xl', 'text-neutral-500 dark:text-neutral-500']">
            {{ t('settings.pages.modules.perception.sections.section.threshold.title') }}
          </h2>
          <div :class="['text-neutral-400 dark:text-neutral-400']">
            {{ t('settings.pages.modules.perception.sections.section.threshold.description') }}
          </div>
        </div>

        <FieldRange
          v-model="volumeThreshold"
          :label="t('settings.pages.modules.perception.sections.section.threshold.volume-label')"
          :description="t('settings.pages.modules.perception.sections.section.threshold.volume-description')"
          :min="0.001"
          :max="0.1"
          :step="0.001"
          :format-value="(v: number) => `${(v * 100).toFixed(1)}%`"
        />

        <FieldRange
          v-model="contextPaddingS"
          :label="t('settings.pages.modules.perception.sections.section.threshold.padding-label')"
          :description="t('settings.pages.modules.perception.sections.section.threshold.padding-description')"
          :min="0.1"
          :max="2.0"
          :step="0.1"
          :format-value="(v: number) => `${v.toFixed(1)}s`"
        />
      </div>
    </div>

    <!-- Test panel -->
    <div :class="['flex flex-col gap-6', 'w-full md:w-[60%]']">
      <div :class="['rounded-xl w-full']">
        <h2 :class="['mb-4 text-lg md:text-2xl', 'text-neutral-500 dark:text-neutral-400']">
          {{ t('settings.pages.modules.perception.sections.section.test.title') }}
        </h2>
        <div :class="['mb-4 text-sm', 'text-neutral-400 dark:text-neutral-500']">
          {{ t('settings.pages.modules.perception.sections.section.test.description') }}
        </div>

        <!-- Warnings -->
        <div
          v-if="!selectedAudioInput"
          :class="[
            'mb-4 flex items-center gap-2 rounded-lg border p-3',
            'border-amber-200 bg-amber-50 text-amber-700',
            'dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-400',
          ]"
        >
          <div class="i-solar:warning-circle-line-duotone text-lg" />
          <span class="text-sm font-medium">Please select an audio input device first</span>
        </div>

        <div
          v-else-if="!enabled"
          :class="[
            'mb-4 flex items-center gap-2 rounded-lg border p-3',
            'border-amber-200 bg-amber-50 text-amber-700',
            'dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-400',
          ]"
        >
          <div class="i-solar:warning-circle-line-duotone text-lg" />
          <span class="text-sm font-medium">Enable perception above to start testing</span>
        </div>

        <!-- Start/Stop button -->
        <Button
          v-if="enabled && selectedAudioInput"
          :class="['mb-4 w-full']"
          :disabled="!canStartPipeline && !isRunning"
          @click="togglePipeline"
        >
          <div v-if="isRunning" class="mr-2">
            <div class="i-solar:stop-circle-line-duotone text-lg" />
          </div>
          <div v-else class="mr-2">
            <div class="i-solar:play-circle-line-duotone text-lg" />
          </div>
          {{ isRunning ? 'Stop Classification' : 'Start Classification' }}
        </Button>

        <!-- Pipeline error -->
        <div
          v-if="pipelineError"
          :class="[
            'mb-4 flex items-center gap-2 rounded-lg border p-3',
            'border-red-200 bg-red-50 text-red-700',
            'dark:border-red-800 dark:bg-red-900/20 dark:text-red-400',
          ]"
        >
          <div class="i-solar:danger-circle-line-duotone text-lg" />
          <span class="text-sm">{{ pipelineError }}</span>
        </div>

        <!-- Volume meter + status -->
        <div v-if="isRunning" :class="['mb-4 flex flex-col gap-3']">
          <!-- Volume bar with threshold marker -->
          <div :class="['flex flex-col gap-1']">
            <div :class="['flex items-center justify-between text-xs', 'text-neutral-500 dark:text-neutral-400']">
              <span>Input Level</span>
              <span>{{ (currentVolume * 100).toFixed(1) }}%</span>
            </div>
            <div :class="['relative h-3 rounded-full overflow-hidden', 'bg-neutral-200 dark:bg-neutral-700']">
              <div
                :class="[
                  'absolute inset-y-0 left-0 rounded-full transition-all duration-75',
                  isCapturing ? 'bg-amber-500' : 'bg-green-500',
                ]"
                :style="{ width: `${volumeBarPercent}%` }"
              />
              <!-- Threshold marker -->
              <div
                :class="['absolute inset-y-0 w-0.5', 'bg-red-500']"
                :style="{ left: `${thresholdPercent}%` }"
              />
            </div>
          </div>

          <!-- Capture status -->
          <div :class="['flex items-center gap-3']">
            <div
              :class="[
                'h-3 w-3 rounded-full transition-all duration-200',
                isCapturing
                  ? 'bg-amber-500 shadow-lg shadow-amber-500/50 animate-pulse'
                  : isRunning
                    ? 'bg-green-500 shadow-lg shadow-green-500/50'
                    : 'bg-neutral-300 dark:bg-neutral-700',
              ]"
            />
            <span :class="['text-sm font-medium']">
              {{ isCapturing ? 'Capturing audio...' : 'Listening (waiting for sound)' }}
            </span>
          </div>
        </div>

        <!-- Status indicator (when not running) -->
        <div v-else :class="['mb-4 flex items-center gap-3']">
          <div :class="['h-3 w-3 rounded-full', 'bg-neutral-300 dark:bg-neutral-700']" />
          <span :class="['text-sm font-medium']">
            {{ t('settings.pages.modules.perception.sections.section.status.stopped') }}
          </span>
        </div>

        <!-- Recent events -->
        <div :class="['flex flex-col gap-2']">
          <h3 :class="['text-sm font-medium', 'text-neutral-600 dark:text-neutral-300']">
            Recent Events ({{ recentEvents.length }})
          </h3>

          <div
            v-if="recentEvents.length === 0"
            :class="[
              'min-h-[150px] flex items-center justify-center rounded-lg border border-dashed p-4',
              'border-neutral-300 bg-neutral-50 text-neutral-400',
              'dark:border-neutral-700 dark:bg-neutral-900/50 dark:text-neutral-500',
            ]"
          >
            <span class="text-sm">No events yet. Start the pipeline — sound above the threshold will trigger classification.</span>
          </div>

          <div
            v-else
            :class="[
              'max-h-[400px] flex flex-col gap-1 overflow-y-auto rounded-lg border p-3',
              'border-neutral-200 bg-white',
              'dark:border-neutral-700 dark:bg-neutral-900',
            ]"
          >
            <div
              v-for="(event, index) in [...recentEvents].reverse()"
              :key="index"
              :class="[
                'flex items-start gap-2 rounded-md p-2',
                'bg-neutral-50 dark:bg-neutral-800/50',
              ]"
            >
              <div :class="['shrink-0 mt-0.5 text-sm font-mono font-bold', eventTypeColor(event.eventType)]">
                {{ event.eventType }}
              </div>
              <div :class="['flex flex-col gap-0.5 min-w-0']">
                <div :class="['text-sm', 'text-neutral-700 dark:text-neutral-200']">
                  {{ event.summary }}
                </div>
                <div :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">
                  {{ formatEvent(event) }}
                </div>
              </div>
            </div>
          </div>

          <Button
            v-if="recentEvents.length > 0"
            :class="['mt-2']"
            @click="perceptionStore.clearEvents()"
          >
            Clear Events
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.perception.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
