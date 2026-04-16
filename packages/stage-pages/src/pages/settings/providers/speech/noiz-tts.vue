<script setup lang="ts">
import type { SpeechProvider } from '@xsai-ext/providers/utils'

import {
  SpeechPlayground,
  SpeechProviderSettings,
} from '@proj-airi/stage-ui/components'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { FieldInput, FieldRange } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const speechStore = useSpeechStore()
const providersStore = useProvidersStore()
const { providers } = storeToRefs(providersStore)
const { t } = useI18n()

const providerId = 'noiz-tts'
const defaultModel = 'noiz-tts'

const defaultVoiceSettings = {
  speed: 1.0,
}

const speed = ref<number>(
  (providers.value[providerId] as any)?.speed
  || defaultVoiceSettings.speed,
)

const emo = ref<string>(
  (providers.value[providerId] as any)?.emo || '',
)

watch(
  () => providers.value[providerId],
  (newConfig) => {
    if (newConfig) {
      const config = newConfig as any
      const newSpeed = typeof config.speed === 'number' ? config.speed : defaultVoiceSettings.speed
      if (Math.abs(speed.value - newSpeed) > 0.001)
        speed.value = newSpeed

      if (typeof config.emo === 'string' && config.emo !== emo.value)
        emo.value = config.emo
    }
    else {
      speed.value = defaultVoiceSettings.speed
      emo.value = ''
    }
  },
  { deep: true, immediate: true },
)

const apiKeyConfigured = computed(() => !!providers.value[providerId]?.apiKey)

const availableVoices = computed(() => {
  return speechStore.availableVoices[providerId] || []
})

onMounted(async () => {
  if (!providers.value[providerId])
    providers.value[providerId] = {}

  const providerConfig = providersStore.getProviderConfig(providerId)
  const providerMetadata = providersStore.getProviderMetadata(providerId)
  if (await providerMetadata.validators.validateProviderConfig(providerConfig)) {
    await speechStore.loadVoicesForProvider(providerId)
  }
})

watch(
  () => providers.value[providerId]?.apiKey,
  async (newKey, oldKey) => {
    if (newKey && newKey !== oldKey) {
      const providerConfig = providersStore.getProviderConfig(providerId)
      const providerMetadata = providersStore.getProviderMetadata(providerId)
      if (await providerMetadata.validators.validateProviderConfig(providerConfig)) {
        await speechStore.loadVoicesForProvider(providerId)
      }
    }
  },
)

async function handleGenerateSpeech(input: string, voiceId: string, _useSSML: boolean) {
  const provider = await providersStore.getProviderInstance<SpeechProvider<string>>(providerId)
  if (!provider)
    throw new Error('Failed to initialize speech provider')

  const providerConfig = providersStore.getProviderConfig(providerId)

  return await speechStore.speech(
    provider,
    defaultModel,
    input,
    voiceId,
    {
      ...providerConfig,
      ...defaultVoiceSettings,
      speed: speed.value,
      emo: emo.value,
    },
  )
}

watch(speed, () => {
  if (!providers.value[providerId])
    providers.value[providerId] = {}
  providers.value[providerId].speed = speed.value
})

watch(emo, () => {
  if (!providers.value[providerId])
    providers.value[providerId] = {}
  providers.value[providerId].emo = emo.value
})
</script>

<template>
  <SpeechProviderSettings
    :provider-id="providerId"
    :default-model="defaultModel"
    :additional-settings="defaultVoiceSettings"
    placeholder="noiz_xxx_api_key"
  >
    <template #basic-settings>
      <p class="text-sm text-neutral-500 dark:text-neutral-400">
        {{ t('settings.pages.providers.provider.noiz-tts.api-key-hint') }}
        <a
          href="https://developers.noiz.ai/api-keys"
          target="_blank"
          rel="noopener noreferrer"
          class="text-primary underline outline-none hover:opacity-80"
        >
          https://developers.noiz.ai/api-keys
        </a>
      </p>
    </template>
    <template #voice-settings>
      <FieldRange
        v-model="speed"
        :label="t('settings.pages.providers.provider.common.fields.field.speed.label')"
        :description="t('settings.pages.providers.provider.common.fields.field.speed.description')"
        :min="0.5"
        :max="2.0"
        :step="0.01"
      />
      <FieldInput
        v-model="emo"
        :label="t('settings.pages.providers.provider.noiz-tts.fields.field.emo.label')"
        :description="t('settings.pages.providers.provider.noiz-tts.fields.field.emo.description')"
        placeholder="{&quot;Sadness&quot;:0.2,&quot;Surprise&quot;:0.5}"
      />
    </template>

    <template #playground>
      <SpeechPlayground
        :available-voices="availableVoices"
        :generate-speech="handleGenerateSpeech"
        :api-key-configured="apiKeyConfigured"
        default-text="Hello! This is a test of the Noiz TTS voice synthesis."
      >
        <template #before-actions>
          <div class="rounded-lg bg-neutral-100 px-4 py-3 dark:bg-neutral-800">
            <p class="text-sm text-neutral-500 dark:text-neutral-400">
              {{ t('settings.pages.providers.provider.noiz-tts.voice-clone-hint') }}
              <a
                href="https://noiz.ai/voice/clone"
                target="_blank"
                rel="noopener noreferrer"
                class="text-primary underline outline-none hover:opacity-80"
              >
                https://noiz.ai/voice/clone
              </a>
            </p>
          </div>
        </template>
      </SpeechPlayground>
    </template>
  </SpeechProviderSettings>
</template>

<route lang="yaml">
meta:
  layout: settings
  stageTransition:
    name: slide
</route>
