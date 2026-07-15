import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EDGE_TTS_OUTPUT_FORMAT,
  EdgeTtsInputError,
  synthesizeEdgeTts,
  type EdgeTtsClientConfig,
} from "../src/server/edge-tts.js";

describe("built-in Edge TTS", () => {
  it("uses the Chinese neural voice for CJK-dominant text and cleans its workspace", async () => {
    let receivedConfig: EdgeTtsClientConfig | undefined;
    let receivedOutputPath = "";
    const audio = Buffer.from("ID3-edge-audio");

    const result = await synthesizeEdgeTts(
      { text: "你好，这是 HomeRail 的语音播报。", speed: 1.25 },
      async (config) => {
        receivedConfig = config;
        return {
          ttsPromise: async (_text, outputPath) => {
            receivedOutputPath = outputPath;
            await writeFile(outputPath, audio);
          },
        };
      },
    );

    expect(result).toEqual(audio);
    expect(receivedConfig).toMatchObject({
      voice: "zh-CN-XiaoxiaoNeural",
      lang: "zh-CN",
      outputFormat: DEFAULT_EDGE_TTS_OUTPUT_FORMAT,
      saveSubtitles: false,
      rate: "+25%",
      timeout: 30_000,
    });
    expect(existsSync(path.dirname(receivedOutputPath))).toBe(false);
  });

  it("retries one empty output before returning audio", async () => {
    let attempts = 0;
    const result = await synthesizeEdgeTts(
      { text: "HomeRail voice output" },
      async () => ({
        ttsPromise: async (_text, outputPath) => {
          attempts += 1;
          if (attempts === 2) await writeFile(outputPath, Buffer.from("ID3-retry"));
        },
      }),
    );

    expect(attempts).toBe(2);
    expect(result.toString()).toBe("ID3-retry");
  });

  it("rejects unsafe voice names and out-of-range speed before creating a client", async () => {
    const createClient = vi.fn();

    await expect(synthesizeEdgeTts({
      text: "hello",
      voice: 'en-US-JennyNeural\"/><break time="10s"/>',
    }, createClient)).rejects.toBeInstanceOf(EdgeTtsInputError);
    await expect(synthesizeEdgeTts({ text: "hello", speed: 2.1 }, createClient))
      .rejects.toThrow("speed must be between 0.5 and 2");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("cleans its workspace when synthesis fails", async () => {
    let receivedOutputPath = "";
    await expect(synthesizeEdgeTts(
      { text: "network failure" },
      async () => ({
        ttsPromise: async (_text, outputPath) => {
          receivedOutputPath = outputPath;
          throw new Error("Edge service unavailable");
        },
      }),
    )).rejects.toThrow("Edge service unavailable");

    expect(existsSync(path.dirname(receivedOutputPath))).toBe(false);
  });
});
