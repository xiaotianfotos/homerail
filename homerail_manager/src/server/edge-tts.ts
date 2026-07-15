import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const BUILTIN_EDGE_TTS_MODEL = "edge-tts";
export const DEFAULT_EDGE_TTS_VOICE = "en-US-MichelleNeural";
export const DEFAULT_EDGE_TTS_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

const DEFAULT_CHINESE_EDGE_TTS_VOICE = "zh-CN-XiaoxiaoNeural";
const DEFAULT_EDGE_TTS_TIMEOUT_MS = 30_000;
const MAX_EDGE_TTS_TEXT_LENGTH = 4_096;
const EDGE_VOICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type EdgeTtsClient = {
  ttsPromise(text: string, outputPath: string): Promise<unknown>;
};

export type EdgeTtsClientConfig = {
  voice: string;
  lang: string;
  outputFormat: string;
  saveSubtitles: boolean;
  rate?: string;
  timeout: number;
};

export type EdgeTtsClientFactory = (
  config: EdgeTtsClientConfig,
) => EdgeTtsClient | Promise<EdgeTtsClient>;

export class EdgeTtsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeTtsInputError";
  }
}

function isCjkDominant(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (!compact) return false;
  let cjk = 0;
  for (const character of compact) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
      (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
      (codePoint >= 0x3000 && codePoint <= 0x303f) ||
      (codePoint >= 0xff00 && codePoint <= 0xffef)
    ) {
      cjk += 1;
    }
  }
  return cjk / compact.length > 0.3;
}

function resolveVoice(text: string, requestedVoice: string | undefined): { voice: string; lang: string } {
  const configuredVoice = requestedVoice?.trim() || DEFAULT_EDGE_TTS_VOICE;
  const voice = configuredVoice === DEFAULT_EDGE_TTS_VOICE && isCjkDominant(text)
    ? DEFAULT_CHINESE_EDGE_TTS_VOICE
    : configuredVoice;
  if (!EDGE_VOICE_PATTERN.test(voice) || !voice.endsWith("Neural")) {
    throw new EdgeTtsInputError(`Invalid Edge TTS voice '${voice}'`);
  }
  const [language, region] = voice.split("-");
  if (!/^[a-z]{2,3}$/.test(language ?? "") || !/^[A-Z]{2}$/.test(region ?? "")) {
    throw new EdgeTtsInputError(`Invalid Edge TTS voice '${voice}'`);
  }
  return { voice, lang: `${language}-${region}` };
}

function resolveRate(speed: number | null | undefined): string | undefined {
  if (speed === null || speed === undefined) return undefined;
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new EdgeTtsInputError("Edge TTS speed must be between 0.5 and 2");
  }
  const percentage = Math.round((speed - 1) * 100);
  return `${percentage >= 0 ? "+" : ""}${percentage}%`;
}

async function createEdgeTtsClient(config: EdgeTtsClientConfig): Promise<EdgeTtsClient> {
  const { EdgeTTS } = await import("node-edge-tts");
  return new EdgeTTS(config);
}

export async function synthesizeEdgeTts(
  params: {
    text: string;
    voice?: string;
    speed?: number | null;
    timeoutMs?: number;
  },
  createClient: EdgeTtsClientFactory = createEdgeTtsClient,
): Promise<Buffer> {
  const text = params.text.trim();
  if (!text) throw new EdgeTtsInputError("Missing required field: text");
  if (text.length > MAX_EDGE_TTS_TEXT_LENGTH) {
    throw new EdgeTtsInputError(`Edge TTS text exceeds ${MAX_EDGE_TTS_TEXT_LENGTH} characters`);
  }
  const { voice, lang } = resolveVoice(text, params.voice);
  const timeout = params.timeoutMs ?? DEFAULT_EDGE_TTS_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 1_000 || timeout > 120_000) {
    throw new EdgeTtsInputError("Edge TTS timeout must be between 1000 and 120000 ms");
  }
  const client = await createClient({
    voice,
    lang,
    outputFormat: DEFAULT_EDGE_TTS_OUTPUT_FORMAT,
    saveSubtitles: false,
    rate: resolveRate(params.speed),
    timeout,
  });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "homerail-edge-tts-"));
  const outputPath = path.join(tempDir, "speech.mp3");
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await writeFile(outputPath, "");
      await client.ttsPromise(text, outputPath);
      if ((await stat(outputPath)).size > 0) {
        return await readFile(outputPath);
      }
    }
    throw new Error("Edge TTS produced empty audio after retry");
  } finally {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}
