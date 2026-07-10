<script setup lang="ts">
import { computed, ref, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '@/stores/agent-store'
import { invokeManagerAgent, managerChat } from '@/api/agent'
import { getDagStatus } from '@/api/services/dag-api'
import { transcribeVoice, speechStream } from '@/api/services/voice-api'
import { cn } from '@/lib/utils'
import MarkdownIt from 'markdown-it'
import { SayStreamExtractor, stripSayTags } from '@/utils/say-stream'
import { createVoiceMediaStream } from '@/utils/voice-audio-input'
import {
  AudioLines,
  Mic,
  MicOff,
  Send,
  StopCircle,
  ChevronDown,
  ChevronUp,
  Wrench,
  Bot,
  User,
  GitBranch,
  ExternalLink,
} from 'lucide-vue-next'

const store = useAgentStore()
const { t } = useI18n()

const inputValue = ref('')
const isSending = ref(false)
const messageListRef = ref<HTMLElement | null>(null)
const expandedToolCalls = ref<Set<string>>(new Set())
const isAtBottom = ref(true)
const voiceMode = ref(false)
const voiceStatusKey = ref('shell.chat.voice.clickToStart')
const voiceError = ref('')
const voiceLevel = ref(0)
const waveformBars = ref<number[]>(Array.from({ length: 34 }, () => 0.08))
const voiceBusy = ref(false)
const sayParser = new SayStreamExtractor()
const sayProcessedLengths = new Map<string, number>()
const ttsEnabledForResponse = ref(false)
let mediaStream: MediaStream | null = null
let audioContext: AudioContext | null = null
let analyser: AnalyserNode | null = null
let processor: ScriptProcessorNode | null = null
let micSource: MediaStreamAudioSourceNode | null = null
let silentGain: GainNode | null = null
let rafId = 0
let speechActive = false
let lastVoiceAt = 0
let pcmChunks: Float32Array[] = []
let ttsAbort: AbortController | null = null
let ttsQueue: Promise<void> = Promise.resolve()
let nextTtsStart = 0
let voiceAbort: AbortController | null = null
let voiceSessionToken = 0
let activeTtsSources: AudioBufferSourceNode[] = []

const md = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: true })

function renderMarkdown(text: string): string {
  return md.render(stripSayTags(text))
}

const placeholder = computed(() => t('shell.chat.placeholder'))
const voiceStatus = computed(() => t(voiceStatusKey.value))
const voiceLevelPct = computed(() => `${Math.round(voiceLevel.value * 100)}%`)

onMounted(() => {
  void store.loadManagerRuntimeOptions()
})

function addSystemWelcome(): void {
  if (store.chatMessages.length === 0) {
    store.chatMessages.push({
      id: `sys-welcome-${Date.now()}`,
      role: 'system',
      content: t('shell.chat.welcome'),
      type: 'text',
      timestamp: new Date().toISOString(),
    })
  }
}
addSystemWelcome()

function toggleExpanded(id: string): void {
  const next = new Set(expandedToolCalls.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedToolCalls.value = next
}

function formatToolResult(result?: string): string {
  if (!result) return ''
  try {
    const parsed = JSON.parse(result)
    const output = parsed?.output ?? parsed?.content ?? parsed?.message
    if (Array.isArray(output)) {
      const text = output
        .map(item => typeof item === 'string' ? item : item?.text ?? JSON.stringify(item))
        .filter(Boolean)
        .join('\n')
      return text || result
    }
    if (typeof output === 'string') return output
    if (output) return JSON.stringify(output, null, 2)
  } catch { /* raw tool result */ }
  return result
}

function toolResultPreview(result?: string): string {
  return formatToolResult(result).replace(/\s+/g, ' ').slice(0, 180)
}

async function sendMessage(): Promise<void> {
  const text = inputValue.value.trim()
  if (!text || isSending.value) return

  await sendUserText(text, false)
  inputValue.value = ''
}

async function sendUserText(text: string, asVoice: boolean, signal?: AbortSignal): Promise<void> {
  store.addChatMessage({
    id: `user-${Date.now()}`,
    role: 'user',
    content: text,
    type: 'text',
    timestamp: new Date().toISOString(),
  })
  isSending.value = true
  store.managerResponding = true
  ttsEnabledForResponse.value = asVoice
  resetSayTracking()

  try {
    const runId = store.currentRunId

    if (runId) {
      // Path B: existing run, invoke directly
      const response = await invokeManagerAgent(runId, { prompt: text })
      store.addChatMessage({
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: (response as any).message || t('shell.chat.runStarting'),
        type: 'text',
        timestamp: new Date().toISOString(),
      })
      try {
        const dag = await getDagStatus(runId)
        if (dag) store.setDagExecution(dag)
      } catch (e: any) {
        console.warn('Failed to fetch DAG status:', e.message)
      }
    } else {
      // Path A: real Manager Agent turn. The backend owns session creation,
      // persistence, and Manager Agent routing.
      store.resetWsStreamed()
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

      const raw = await managerChat({
        message: text,
        project_id: store.managerProjectId ?? undefined,
        session_id: store.managerSessionId ?? undefined,
      }, signal)
      const data = (raw as any).data ?? (raw as any)
      const sessionId = data?.session_id || store.managerSessionId
      if (sessionId) store.managerSessionId = sessionId

      // HTTP fallback: only render if WS events didn't arrive
      if (!store.hasWsStreamed()) {
        const assistantText = data?.text || data?.message || ''
        if (assistantText) {
          store.addChatMessage({
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: assistantText,
            type: 'text',
            timestamp: new Date().toISOString(),
          })
        }
      }

      const spawnedRunId: string | null | undefined = data?.run_id
      if (spawnedRunId) {
        store.setRunId(spawnedRunId)
        store.addChatMessage({
          id: `sys-run-${Date.now()}`,
          role: 'system',
          content: t('shell.chat.runStarted', { runId: spawnedRunId }),
          type: 'status',
          timestamp: new Date().toISOString(),
        })
        try {
          const dag = await getDagStatus(spawnedRunId)
          if (dag) store.setDagExecution(dag)
        } catch (e: any) {
          console.warn('Failed to fetch DAG status:', e.message)
        }
      }

      store.updateManagerSessionStatus(sessionId, 'completed', spawnedRunId ?? undefined)
    }
  } catch (error: any) {
    store.updateManagerSessionStatus(store.managerSessionId, 'failed')
    store.addChatMessage({
      id: `assistant-error-${Date.now()}`,
      role: 'assistant',
      content: t('shell.chat.error', { message: error.message || t('shell.chat.requestFailed') }),
      type: 'text',
      timestamp: new Date().toISOString(),
    })
  } finally {
    isSending.value = false
    store.managerResponding = false
    if (asVoice) {
      for (const segment of sayParser.finish()) enqueueSpeech(segment.text)
    }
    if (store.managerProjectId) {
      window.setTimeout(() => { void store.fetchManagerSessions() }, 2500)
    }
    if (isAtBottom.value) scrollToBottom()
  }
}

function scrollToBottom(): void {
  nextTick(() => {
    const el = messageListRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function checkAtBottom(): void {
  const el = messageListRef.value
  if (el) {
    isAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 32
  }
}

watch(
  () => store.chatMessages.length,
  () => { if (isAtBottom.value) scrollToBottom() },
  { flush: 'post' },
)

watch(
  () => store.chatMessages.map(msg => `${msg.id}:${msg.content.length}`).join('|'),
  () => consumeSayDeltas(),
  { flush: 'post' },
)

watch(
  () => store.chatMessages.map(msg => `${msg.id}:${msg.type}:${msg.toolResult ? 'result' : ''}`).join('|'),
  () => {
    const next = new Set(expandedToolCalls.value)
    for (const msg of store.chatMessages) {
      if (msg.type === 'tool_call' && msg.toolResult) next.add(msg.id)
    }
    expandedToolCalls.value = next
  },
  { flush: 'post' },
)

onUnmounted(() => {
  stopVoiceMode()
  ttsAbort?.abort()
})

function handleKeyDown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if ((event.ctrlKey && event.key === 'Enter') || (!event.shiftKey && event.key === 'Enter')) {
    event.preventDefault()
    if (!isSending.value) sendMessage()
  }
}

function handleProviderChange(event: Event): void {
  store.setManagerRuntime((event.target as HTMLSelectElement).value)
}

function handleModelChange(event: Event): void {
  store.setManagerRuntime(store.managerProviderName, (event.target as HTMLSelectElement).value)
}

function appendVoiceInput(text: string): void {
  const clean = text.trim()
  if (!clean) return
  const current = inputValue.value.trim()
  inputValue.value = current ? `${current}\n${clean}` : clean
}

function isInvokeRun(msg: { toolName?: string; content: string }): boolean {
  return (msg.toolName || '').endsWith('invoke_run')
}

function extractRunId(msg: { content: string }): string | null {
  try {
    const parsed = JSON.parse(msg.content)
    return parsed?.run_id ?? null
  } catch { return null }
}

function clickRunCard(runId: string): void {
  store.switchToRun(runId, store.managerProjectId ?? undefined)
}

async function toggleVoiceMode(): Promise<void> {
  if (voiceMode.value) {
    stopVoiceMode()
    return
  }
  voiceMode.value = true
  voiceError.value = ''
  voiceStatusKey.value = 'shell.chat.voice.requestingMicrophone'
  try {
    await startVoiceCapture()
  } catch (err: any) {
    voiceError.value = err?.message || t('shell.chat.voice.microphoneUnavailable')
    stopVoiceMode('shell.chat.voice.notStarted')
  }
}

async function startVoiceCapture(): Promise<void> {
  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
  if (!navigator.mediaDevices?.getUserMedia || !AudioContextCtor) {
    throw new Error(t('shell.chat.voice.unsupported'))
  }

  mediaStream = await createVoiceMediaStream()
  audioContext = new AudioContextCtor()
  analyser = audioContext.createAnalyser()
  analyser.fftSize = 1024
  micSource = audioContext.createMediaStreamSource(mediaStream)
  processor = audioContext.createScriptProcessor(4096, 1, 1)
  silentGain = audioContext.createGain()
  silentGain.gain.value = 0

  micSource.connect(analyser)
  micSource.connect(processor)
  processor.connect(silentGain)
  silentGain.connect(audioContext.destination)
  processor.onaudioprocess = event => {
    if (!speechActive) return
    pcmChunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
  }

  voiceStatusKey.value = 'shell.chat.voice.listening'
  rafId = window.requestAnimationFrame(updateVoiceWaveform)
}

function stopVoiceMode(statusKey = 'shell.chat.voice.stopped'): void {
  voiceSessionToken += 1
  voiceAbort?.abort()
  voiceAbort = null
  ttsAbort?.abort()
  ttsAbort = null
  stopActiveTtsSources()
  voiceMode.value = false
  voiceBusy.value = false
  speechActive = false
  pcmChunks = []
  if (rafId) window.cancelAnimationFrame(rafId)
  rafId = 0
  processor?.disconnect()
  analyser?.disconnect()
  micSource?.disconnect()
  silentGain?.disconnect()
  mediaStream?.getTracks().forEach(track => track.stop())
  audioContext?.close().catch(() => {})
  processor = null
  analyser = null
  micSource = null
  silentGain = null
  mediaStream = null
  audioContext = null
  voiceLevel.value = 0
  voiceStatusKey.value = statusKey
  waveformBars.value = waveformBars.value.map(() => 0.08)
}

function updateVoiceWaveform(now: number): void {
  if (!voiceMode.value || !analyser) return
  const data = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(data)
  let sum = 0
  for (const value of data) {
    const centered = (value - 128) / 128
    sum += centered * centered
  }
  const rms = Math.sqrt(sum / data.length)
  voiceLevel.value = Math.min(1, rms * 8)
  waveformBars.value = waveformBars.value.map((_, index) => {
    const sample = data[Math.floor(index * data.length / waveformBars.value.length)] ?? 128
    return Math.max(0.08, Math.min(1, Math.abs(sample - 128) / 72 + voiceLevel.value * 0.35))
  })

  const speaking = voiceLevel.value > 0.16
  if (speaking) {
    lastVoiceAt = now
    if (!speechActive && !voiceBusy.value) {
      speechActive = true
      pcmChunks = []
      voiceStatusKey.value = 'shell.chat.voice.listeningActive'
    }
  } else if (speechActive && now - lastVoiceAt > 850) {
    void finishUtterance()
  }
  rafId = window.requestAnimationFrame(updateVoiceWaveform)
}

async function finishUtterance(): Promise<void> {
  if (!speechActive || voiceBusy.value) return
  const token = voiceSessionToken
  speechActive = false
  const chunks = pcmChunks
  pcmChunks = []
  if (chunks.reduce((total, chunk) => total + chunk.length, 0) < 2400) {
    if (voiceMode.value && token === voiceSessionToken) voiceStatusKey.value = 'shell.chat.voice.listening'
    return
  }
  voiceBusy.value = true
  voiceStatusKey.value = 'shell.chat.voice.recognizing'
  voiceAbort?.abort()
  voiceAbort = new AbortController()
  const signal = voiceAbort.signal
  try {
    const sampleRate = audioContext?.sampleRate || 48000
    const wav = encodeWav(chunks, sampleRate)
    const dataUrl = await blobToDataUrl(wav)
    if (token !== voiceSessionToken || signal.aborted) return
    const result = await transcribeVoice(dataUrl, signal)
    if (token !== voiceSessionToken || signal.aborted) return
    const transcript = (result.data?.text || '').trim()
    if (!transcript) throw new Error(t('shell.chat.voice.noTranscript'))
    appendVoiceInput(transcript)
    voiceStatusKey.value = 'shell.chat.voice.inserted'
  } catch (err: any) {
    if (err?.name === 'CanceledError' || err?.name === 'AbortError' || signal.aborted || token !== voiceSessionToken) {
      return
    }
    voiceError.value = err?.message || t('shell.chat.voice.recognitionFailed')
    voiceStatusKey.value = 'shell.chat.voice.retry'
  } finally {
    if (token === voiceSessionToken) {
      voiceBusy.value = false
      voiceAbort = null
      if (voiceMode.value && voiceStatusKey.value === 'shell.chat.voice.recognizing') {
        voiceStatusKey.value = 'shell.chat.voice.listening'
      }
    }
  }
}

function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + length * 2, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, length * 2, true)
  let offset = 44
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const value = Math.max(-1, Math.min(1, sample))
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true)
      offset += 2
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function resetSayTracking(): void {
  sayParser.reset()
  sayProcessedLengths.clear()
  for (const message of store.chatMessages) {
    if (message.role === 'assistant' && message.type === 'text') {
      sayProcessedLengths.set(message.id, message.content.length)
    }
  }
  ttsAbort?.abort()
  ttsAbort = null
  stopActiveTtsSources()
  ttsQueue = Promise.resolve()
  nextTtsStart = 0
}

function consumeSayDeltas(): void {
  if (!ttsEnabledForResponse.value) return
  for (const message of store.chatMessages) {
    if (message.role !== 'assistant' || message.type !== 'text') continue
    const processed = sayProcessedLengths.get(message.id) ?? 0
    if (message.content.length <= processed) continue
    const delta = message.content.slice(processed)
    sayProcessedLengths.set(message.id, message.content.length)
    for (const segment of sayParser.push(delta)) {
      enqueueSpeech(segment.text)
    }
  }
}

function enqueueSpeech(text: string): void {
  const spoken = stripSayTags(text).trim()
  if (!spoken) return
  ttsQueue = ttsQueue.then(() => playSpeech(spoken)).catch(err => {
    voiceError.value = err?.message || t('shell.chat.voice.ttsFailed')
  })
}

async function playSpeech(text: string): Promise<void> {
  ttsAbort = new AbortController()
  const response = await speechStream(text, undefined, false, ttsAbort.signal)
  await playWavResponse(response)
}

async function playWavResponse(response: Response): Promise<void> {
  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
  if (!response.body || !AudioContextCtor) {
    const blob = await response.blob()
    await playBlob(blob)
    return
  }
  const context = audioContext && audioContext.state !== 'closed' ? audioContext : new AudioContextCtor()
  if (!audioContext || audioContext.state === 'closed') audioContext = context
  const reader = response.body.getReader()
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array()
  let format: { channels: number; sampleRate: number; bits: number } | null = null
  let playbackDone: Promise<void> = Promise.resolve()

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    pending = concatBytes(pending, value)
    if (!format) {
      const parsed = parseWavHeader(pending)
      if (!parsed) continue
      format = parsed.format
      pending = pending.slice(parsed.dataOffset)
      nextTtsStart = Math.max(context.currentTime + 0.04, nextTtsStart || 0)
    }
    const byteCount = pending.length - (pending.length % 2)
    if (byteCount < 2048) continue
    const playable = pending.slice(0, byteCount)
    pending = pending.slice(byteCount)
    playbackDone = schedulePcm(context, playable, format)
  }
  if (format && pending.length >= 2) {
    playbackDone = schedulePcm(context, pending.slice(0, pending.length - (pending.length % 2)), format)
  }
  await playbackDone
}

function parseWavHeader(bytes: Uint8Array<ArrayBufferLike>): { dataOffset: number; format: { channels: number; sampleRate: number; bits: number } } | null {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') return null
  let offset = 12
  let channels = 1
  let sampleRate = 24000
  let bits = 16
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4)
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true)
    if (offset + 8 + size > bytes.length && id !== 'data') return null
    if (id === 'fmt ') {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 8, Math.min(size, bytes.length - offset - 8))
      channels = view.getUint16(2, true)
      sampleRate = view.getUint32(4, true)
      bits = view.getUint16(14, true)
    }
    if (id === 'data') return { dataOffset: offset + 8, format: { channels, sampleRate, bits } }
    offset += 8 + size
  }
  return null
}

function ascii(bytes: Uint8Array<ArrayBufferLike>, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

function concatBytes(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function schedulePcm(context: AudioContext, bytes: Uint8Array<ArrayBufferLike>, format: { channels: number; sampleRate: number; bits: number }): Promise<void> {
  if (format.bits !== 16 || bytes.length < 2) return Promise.resolve()
  const samples = bytes.length / 2 / format.channels
  const buffer = context.createBuffer(format.channels, samples, format.sampleRate)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let frame = 0; frame < samples; frame++) {
    for (let channel = 0; channel < format.channels; channel++) {
      const index = (frame * format.channels + channel) * 2
      buffer.getChannelData(channel)[frame] = view.getInt16(index, true) / 32768
    }
  }
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  const startAt = Math.max(context.currentTime + 0.02, nextTtsStart || 0)
  activeTtsSources.push(source)
  source.start(startAt)
  nextTtsStart = startAt + buffer.duration
  return new Promise(resolve => {
    source.onended = () => {
      activeTtsSources = activeTtsSources.filter(item => item !== source)
      resolve()
    }
  })
}

function stopActiveTtsSources(): void {
  for (const source of activeTtsSources) {
    try { source.stop() } catch { /* already stopped */ }
  }
  activeTtsSources = []
}

async function playBlob(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob)
  try {
    const audio = new Audio(url)
    await audio.play()
    await new Promise(resolve => { audio.onended = resolve })
  } finally {
    URL.revokeObjectURL(url)
  }
}
</script>

<template>
  <div class="agent-chat-surface flex h-full flex-col bg-transparent">
    <div class="agent-chat-header flex h-16 flex-shrink-0 items-center justify-between border-b border-cyan-200/10 px-6">
      <div>
        <div class="text-[11px] uppercase tracking-[0.22em] text-cyan-200/45">Manager</div>
        <div class="mt-1 text-lg font-semibold text-white">Runtime</div>
      </div>
      <div class="flex items-center gap-2 text-xs">
        <select
          :value="store.managerProviderName"
          class="h-9 rounded-full border border-cyan-200/14 bg-white/[0.035] px-3 text-xs text-white/72 outline-none focus:border-cyan-200/35"
          :disabled="isSending || store.managerRuntimeLoading"
          @change="handleProviderChange"
        >
          <option
            v-for="provider in store.managerProviderOptions"
            :key="provider"
            :value="provider"
          >
            {{ store.managerProviderLabel(provider) }}
          </option>
        </select>
        <select
          v-model="store.managerModelName"
          class="h-9 rounded-full border border-cyan-200/14 bg-white/[0.035] px-3 text-xs text-white/72 outline-none focus:border-cyan-200/35"
          :disabled="isSending || store.managerRuntimeLoading"
          @change="handleModelChange"
        >
          <option
            v-for="model in store.managerModelOptions"
            :key="model"
            :value="model"
          >
            {{ store.managerModelLabel(store.managerProviderName, model) }}
          </option>
        </select>
      </div>
    </div>
    <!-- Message List -->
    <div
      ref="messageListRef"
      class="agent-chat-scroll flex-1 overflow-y-auto px-7 py-8"
      @scroll="checkAtBottom"
    >
      <!-- Empty state -->
      <div v-if="store.chatMessages.length === 0" class="flex items-center justify-center h-full text-gray-500 text-sm">
        <div class="text-center space-y-2">
          <div class="text-4xl opacity-20">💬</div>
          <div>{{ t('shell.chat.empty') }}</div>
        </div>
      </div>

      <div class="mx-auto max-w-[760px] space-y-5">
      <template v-for="msg in store.chatMessages" :key="msg.id">
        <!-- System / Assistant -->
        <div v-if="msg.role === 'system' || msg.role === 'assistant'" class="flex gap-3">
          <div class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-2xl border border-cyan-200/18 bg-cyan-200/10">
            <Bot class="h-4 w-4 text-cyan-200" />
          </div>
          <div class="flex-1 min-w-0 space-y-1">
            <!-- Text -->
            <div v-if="msg.type === 'text'" class="agent-markdown rounded-[22px] border border-white/[0.08] bg-white/[0.035] px-4 py-3 text-[15px] leading-7 text-white/[0.82] break-words shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]" v-html="renderMarkdown(msg.content)" />

            <!-- Thinking summary -->
            <div
              v-if="msg.type === 'thinking'"
              class="inline-flex h-8 items-center gap-1.5 rounded-full border border-cyan-200/15 bg-cyan-200/5 px-3"
            >
              <span class="h-1.5 w-1.5 rounded-full bg-cyan-200 animate-pulse" />
              <span class="h-1.5 w-1.5 rounded-full bg-cyan-200 animate-pulse [animation-delay:120ms]" />
              <span class="h-1.5 w-1.5 rounded-full bg-cyan-200 animate-pulse [animation-delay:240ms]" />
            </div>

            <!-- Tool Call -->
            <div
              v-if="msg.type === 'tool_call'"
              :class="cn(
                'overflow-hidden rounded-[20px] border',
                isInvokeRun(msg) && extractRunId(msg)
                  ? 'border-cyan-200/30 bg-cyan-200/[0.08] cursor-pointer hover:border-cyan-200/50'
                  : 'border-white/10 bg-white/[0.035]'
              )"
              @click="isInvokeRun(msg) && extractRunId(msg) ? clickRunCard(extractRunId(msg)!) : undefined"
            >
              <!-- invoke_run Run Card -->
              <template v-if="isInvokeRun(msg) && extractRunId(msg)">
                <div class="flex items-center gap-2 px-3 py-2">
                  <GitBranch class="h-4 w-4 text-cyan-200 flex-shrink-0" />
                  <div class="flex-1 min-w-0">
                    <div class="text-xs font-medium text-cyan-100">DAG Run</div>
                    <div class="text-[10px] text-white/35 font-mono">{{ extractRunId(msg)!.slice(-12) }}</div>
                  </div>
                  <ExternalLink class="h-3 w-3 text-white/35" />
                </div>
              </template>
              <!-- Regular tool call -->
              <template v-else>
                <button
                  class="flex items-center gap-2 w-full px-3 py-2.5 text-xs text-white/66 hover:bg-white/5 transition-colors"
                  @click="toggleExpanded(msg.id)"
                >
                  <ChevronDown v-if="expandedToolCalls.has(msg.id)" class="h-3.5 w-3.5" />
                  <ChevronUp v-else class="h-3.5 w-3.5" />
                  <Wrench class="h-3.5 w-3.5 text-cyan-200/80" />
                  <span class="text-white/35">{{ t('shell.chat.toolCalls') }}</span>
                  <span class="font-medium text-white/[0.86]">{{ msg.toolName }}</span>
                  <span v-if="msg.toolSummary" class="text-white/35">{{ msg.toolSummary }}</span>
                  <span
                    :class="cn(
                      'ml-auto text-[10px]',
                      msg.status === 'completed' && 'text-green-400',
                      msg.status === 'failed' && 'text-red-400',
                      msg.status === 'pending' && 'text-amber-400'
                    )"
                  >
                    {{ msg.status === 'completed' ? t('shell.chat.status.completed') : msg.status === 'failed' ? t('shell.chat.status.failed') : t('shell.chat.status.running') }}
                  </span>
                </button>
                <div
                  v-if="!expandedToolCalls.has(msg.id) && msg.toolResult"
                  class="border-t border-white/5 px-3 py-2 text-xs text-white/40"
                >
                  {{ toolResultPreview(msg.toolResult) }}
                </div>
                <div v-if="expandedToolCalls.has(msg.id)" class="px-3 pb-3 text-xs text-white/40 border-t border-white/5 mt-1 pt-2 whitespace-pre-wrap">
                  <template v-if="msg.content">
                    <div class="text-white/55">Input</div>
                    <div>{{ msg.content }}</div>
                  </template>
                  <template v-if="msg.toolResult">
                    <div class="mt-2 text-white/55">Result</div>
                    <div class="max-h-64 overflow-y-auto rounded-2xl border border-white/5 bg-black/20 p-2">{{ formatToolResult(msg.toolResult) }}</div>
                  </template>
                </div>
              </template>
            </div>

            <!-- Status -->
            <div v-if="msg.type === 'status'" class="text-xs text-white/35 italic">
              {{ msg.content }}
            </div>
          </div>
        </div>

        <!-- User -->
        <div v-else-if="msg.role === 'user'" class="flex gap-3 flex-row-reverse">
          <div class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.055]">
            <User class="h-4 w-4 text-white/55" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="ml-auto max-w-[86%] rounded-[22px] rounded-tr-md border border-cyan-200/18 bg-cyan-200/12 px-4 py-3 text-sm leading-relaxed text-cyan-50 break-words">
              {{ msg.content }}
            </div>
          </div>
        </div>
      </template>
        <div v-if="store.managerResponding && !store.hasWsStreamed()" class="flex gap-3">
          <div class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-2xl border border-cyan-200/18 bg-cyan-200/10">
            <Bot class="h-4 w-4 text-cyan-200" />
          </div>
          <div class="inline-flex h-8 items-center gap-1.5 rounded-full border border-cyan-200/15 bg-cyan-200/5 px-3">
            <span class="h-1.5 w-1.5 rounded-full bg-cyan-200 animate-pulse" />
            <span class="h-1.5 w-1.5 rounded-full bg-cyan-200 animate-pulse [animation-delay:120ms]" />
            <span class="h-1.5 w-1.5 rounded-full bg-cyan-200 animate-pulse [animation-delay:240ms]" />
          </div>
        </div>
      </div>
    </div>

    <!-- Input Area -->
    <div class="px-7 pb-6 pt-3 bg-gradient-to-t from-[#071012] via-[#071012]/92 to-[#071012]/20">
      <div class="agent-chat-composer mx-auto flex max-w-[820px] items-end gap-2 rounded-[26px] border border-cyan-200/18 bg-black/35 p-3 shadow-2xl backdrop-blur-xl">
        <button
          :class="cn(
            'flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-colors',
            voiceMode ? 'bg-cyan-200/15 text-cyan-100 hover:bg-cyan-200/20' : 'bg-transparent text-white/45 hover:bg-white/10 hover:text-white'
          )"
          :title="voiceMode ? t('shell.chat.voice.stop') : t('shell.chat.voice.start')"
          @click="toggleVoiceMode"
        >
          <MicOff v-if="voiceMode" class="h-4 w-4" />
          <Mic v-else class="h-4 w-4" />
        </button>
        <div v-if="voiceMode" class="min-h-[54px] w-[240px] shrink-0 rounded-[20px] border border-cyan-200/14 bg-black/22 px-3 py-2">
          <div class="flex h-8 items-center gap-1 overflow-hidden">
            <span
              v-for="(bar, index) in waveformBars"
              :key="index"
              class="w-1 rounded-full bg-gradient-to-t from-teal-500 via-cyan-300 to-emerald-200 transition-[height,opacity] duration-75"
              :style="{ height: `${Math.max(10, bar * 34)}px`, opacity: 0.38 + bar * 0.62 }"
            />
          </div>
          <div class="mt-1 flex items-center justify-between gap-3 text-[11px]">
            <span class="flex items-center gap-1.5 text-gray-400">
              <AudioLines class="h-3.5 w-3.5 text-cyan-200" />
              {{ voiceStatus }}
            </span>
            <span class="font-mono text-gray-500">{{ voiceLevelPct }}</span>
          </div>
          <div v-if="voiceError" class="mt-1 text-[11px] text-red-300">{{ voiceError }}</div>
        </div>
        <textarea
          v-model="inputValue"
          :class="cn(
            'flex-1 resize-none bg-transparent text-sm text-white/[0.82] placeholder:text-white/30 outline-none',
            'max-h-32 min-h-[44px] py-1 px-1'
          )"
          :rows="2"
          :placeholder="placeholder"
          :disabled="isSending"
          @keydown="handleKeyDown"
        />
        <button
          :class="cn(
            'flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-colors',
            isSending
              ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25'
              : 'bg-cyan-300 text-black hover:bg-cyan-200'
          )"
          :title="t('shell.chat.send')"
          @click="isSending ? undefined : sendMessage()"
        >
          <Send v-if="!isSending" class="h-4 w-4" />
          <StopCircle v-else class="h-4 w-4" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
@keyframes pulse-ring {
  0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.4); }
  70% { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
  100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
}

.agent-chat-surface {
  --agent-radius-card: 24px;
  --agent-radius-control: 20px;
  --agent-space-card: 18px;
}

.agent-chat-header {
  min-height: 72px;
  padding-inline: 24px;
}

.agent-chat-scroll {
  padding: 32px 28px 28px;
}

.agent-chat-scroll :deep(.space-y-5 > :not([hidden]) ~ :not([hidden])) {
  margin-top: 22px;
}

.agent-chat-surface :deep(select) {
  min-height: 40px;
  border-radius: 999px;
  padding-inline: 14px;
}

.agent-chat-surface :deep(.agent-markdown) {
  border-radius: var(--agent-radius-card);
  padding: var(--agent-space-card) 20px;
}

.agent-chat-surface :deep(textarea) {
  min-height: 58px;
  padding: 10px 8px;
}

.agent-chat-composer {
  border-radius: 30px;
  gap: 12px;
  padding: 14px;
}

.agent-chat-composer button {
  width: 42px;
  height: 42px;
}

.agent-chat-surface :deep(.rounded-lg),
.agent-chat-surface :deep(.rounded-xl),
.agent-chat-surface :deep(.rounded-2xl) {
  border-radius: var(--agent-radius-control);
}

.agent-markdown :deep(p) { margin: 0.4em 0; }
.agent-markdown :deep(p:first-child) { margin-top: 0; }
.agent-markdown :deep(p:last-child) { margin-bottom: 0; }
.agent-markdown :deep(code) {
  background: rgba(255,255,255,0.08);
  padding: 0.15em 0.4em;
  border-radius: 4px;
  font-size: 0.875em;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
}
.agent-markdown :deep(pre) {
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 8px;
  padding: 0.75em 1em;
  overflow-x: auto;
  margin: 0.5em 0;
}
.agent-markdown :deep(pre code) {
  background: none;
  padding: 0;
  font-size: 0.8em;
}
.agent-markdown :deep(a) {
  color: #60a5fa;
  text-decoration: underline;
}
.agent-markdown :deep(ul), .agent-markdown :deep(ol) {
  padding-left: 1.5em;
  margin: 0.4em 0;
}
.agent-markdown :deep(li) { margin: 0.15em 0; }
.agent-markdown :deep(blockquote) {
  border-left: 3px solid rgba(255,255,255,0.15);
  padding-left: 0.75em;
  margin: 0.5em 0;
  color: #9ca3af;
}
.agent-markdown :deep(h1), .agent-markdown :deep(h2), .agent-markdown :deep(h3) {
  color: #e5e7eb;
  margin: 0.6em 0 0.3em;
  font-weight: 600;
}
.agent-markdown :deep(h1) { font-size: 1.15em; }
.agent-markdown :deep(h2) { font-size: 1.1em; }
.agent-markdown :deep(h3) { font-size: 1.05em; }
.agent-markdown :deep(table) { border-collapse: collapse; margin: 0.5em 0; width: 100%; }
.agent-markdown :deep(th), .agent-markdown :deep(td) {
  border: 1px solid rgba(255,255,255,0.1);
  padding: 0.3em 0.6em;
  text-align: left;
}
.agent-markdown :deep(th) { background: rgba(255,255,255,0.05); font-weight: 600; }
.agent-markdown :deep(hr) { border-color: rgba(255,255,255,0.1); margin: 0.75em 0; }
.agent-markdown :deep(strong) { color: #e5e7eb; }
</style>
