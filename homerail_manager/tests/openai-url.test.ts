import { describe, expect, it } from "vitest";

import { normalizeOpenAiBaseUrl, openAiModelsUrl } from "../src/server/openai-url.js";

describe("normalizeOpenAiBaseUrl", () => {
  it.each([
    // 裸地址与斜杠变体：原样保留（仅去尾斜杠）
    ["http://192.168.100.10:5000", "http://192.168.100.10:5000"],
    ["http://192.168.100.10:5000/", "http://192.168.100.10:5000"],
    // 带 /v1：保留 /v1
    ["http://192.168.100.10:5000/v1", "http://192.168.100.10:5000/v1"],
    ["http://192.168.100.10:5000/v1/", "http://192.168.100.10:5000/v1"],
    // 完整端点地址：剥到 API 根
    ["http://192.168.100.10:5000/v1/models", "http://192.168.100.10:5000/v1"],
    ["http://192.168.100.10:5000/v1/chat/completions", "http://192.168.100.10:5000/v1"],
    ["http://192.168.100.10:5000/chat/completions", "http://192.168.100.10:5000"],
    ["http://192.168.100.10:5002/v1/realtime", "http://192.168.100.10:5002/v1"],
    ["http://192.168.100.10:5001/v1/audio/speech", "http://192.168.100.10:5001/v1"],
    ["http://192.168.100.10:5001/v1/audio/speech/stream", "http://192.168.100.10:5001/v1"],
    ["http://192.168.100.10:5000/v1/audio/transcriptions", "http://192.168.100.10:5000/v1"],
    ["http://192.168.100.10:5000/v1/embeddings", "http://192.168.100.10:5000/v1"],
    // 空白与大小写
    ["  http://192.168.100.10:5000/v1//  ", "http://192.168.100.10:5000/v1"],
    ["http://192.168.100.10:5000/V1/CHAT/COMPLETIONS", "http://192.168.100.10:5000/V1"],
    // 预设供应商地址不受影响
    ["https://api.moonshot.cn/v1", "https://api.moonshot.cn/v1"],
    ["https://openspeech.bytedance.com/api/v3", "https://openspeech.bytedance.com/api/v3"],
  ])("normalizeOpenAiBaseUrl(%s) === %s", (input, expected) => {
    expect(normalizeOpenAiBaseUrl(input)).toBe(expected);
  });
});

describe("openAiModelsUrl", () => {
  it.each([
    ["http://192.168.100.10:5000", "http://192.168.100.10:5000/v1/models"],
    ["http://192.168.100.10:5000/v1", "http://192.168.100.10:5000/v1/models"],
    ["http://192.168.100.10:5000/v1/models", "http://192.168.100.10:5000/v1/models"],
    ["http://192.168.100.10:5000/v1/chat/completions", "http://192.168.100.10:5000/v1/models"],
  ])("openAiModelsUrl(%s) === %s", (input, expected) => {
    expect(openAiModelsUrl(input)).toBe(expected);
  });
});
