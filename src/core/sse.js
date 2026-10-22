import { EMPTY_RESPONSE_CODE, LlmError } from "@deepseek-ai/dsh-llm";
import { normalizeHarnessMessages } from "./message-shape.js";
async function readWithIdleTimeout(reader, timeoutMs, label, signal, phase = "chunk") {
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  let timer;
  const onUserAbort = () => {
    if (timer) clearTimeout(timer);
  };
  signal?.addEventListener("abort", onUserAbort, { once: true });
  const readPromise = reader.read();
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new LlmError(`${label}: sse ${phase} timeout after ${timeoutMs}ms`, "TIMEOUT"));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([readPromise, timeoutPromise]);
    return { done: result.done, value: result.value };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof LlmError) {
      await reader.cancel().catch(() => {
      });
      throw error;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onUserAbort);
  }
}
function hasUsableToolName(name) {
  return typeof name === "string" && name.trim().length > 0;
}
function resolveEmptyResponseReason(reason, blockCount) {
  if (blockCount > 0 || reason.kind !== "stop") return reason;
  return {
    kind: "error",
    failure: {
      message: "model returned a completed response with no content",
      code: EMPTY_RESPONSE_CODE
    }
  };
}
function createBlankReasoningSuppressor() {
  let accumulated = "";
  let emitting = false;
  return {
    feed(text) {
      accumulated += text;
      if (emitting) return text;
      if (text.trim() === "") return void 0;
      emitting = true;
      return accumulated;
    },
    text() {
      return accumulated;
    }
  };
}
function resolveToolPairing(messages) {
  const normalized = normalizeHarnessMessages(messages);
  const allResultIds = /* @__PURE__ */ new Set();
  for (const message of normalized) {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (typeof block === "object" && block !== null && block.type === "tool-result") {
        allResultIds.add(String(block.toolCallId));
      }
    }
  }
  const keepCallIds = /* @__PURE__ */ new Set();
  for (const message of normalized) {
    if (message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const calls = content.filter((block) => typeof block === "object" && block !== null && block.type === "tool-call");
    if (calls.length === 0) continue;
    const usable = calls.filter((block) => hasUsableToolName(block.name));
    if (usable.length === 0) continue;
    if (usable.every((block) => allResultIds.has(String(block.id)))) {
      for (const block of usable) keepCallIds.add(String(block.id));
    }
  }
  const keepResultIds = /* @__PURE__ */ new Set();
  for (const id of keepCallIds) {
    if (allResultIds.has(id)) keepResultIds.add(id);
  }
  return { keepCallIds, keepResultIds };
}
function normalizeToolArguments(raw) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "{}";
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "{}";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "{}";
  return trimmed;
}
function isTruncatedArguments(raw) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    return true;
  }
}
const REASONING_LOOP_CODE = "REASONING_LOOP";
function resolveSliceChars(raw) {
  const value = raw ?? 64;
  return Number.isFinite(value) ? Math.max(1, value) : 64;
}
function createReasoningLoopDetector(options = {}) {
  const windowChars = options.windowChars ?? 3e3;
  const maxDistinctLineRatio = options.maxDistinctLineRatio ?? 0.35;
  const minLines = options.minLines ?? 40;
  const minLoopChars = options.minLoopChars ?? 2e3;
  const sliceChars = resolveSliceChars(options.sliceChars);
  let text = "";
  let detected = false;
  let cutAt;
  let runStart = 0;
  let runChars = 0;
  let hitLines = 0;
  let hitDistinct = 0;
  function feedPiece(piece) {
    text += piece;
    const window = text.slice(Math.max(0, text.length - windowChars));
    const lines = window.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    const looping = lines.length >= minLines && new Set(lines).size / lines.length < maxDistinctLineRatio;
    if (!looping) {
      runStart = 0;
      runChars = 0;
      return false;
    }
    if (runChars === 0) runStart = text.length - piece.length;
    runChars += piece.length;
    if (runChars < minLoopChars) return false;
    detected = true;
    cutAt = runStart;
    hitLines = lines.length;
    hitDistinct = new Set(lines).size;
    return true;
  }
  return {
    get detected() {
      return detected;
    },
    get cutAt() {
      return cutAt;
    },
    get diagnostics() {
      if (!detected) return void 0;
      return {
        observedChars: text.length,
        runChars,
        lines: hitLines,
        distinctLines: hitDistinct,
        distinctLineRatio: hitLines === 0 ? 1 : hitDistinct / hitLines
      };
    },
    observe(delta) {
      if (detected) return false;
      if (delta.length === 0) return false;
      for (let offset = 0; offset < delta.length; offset += sliceChars) {
        if (feedPiece(delta.slice(offset, offset + sliceChars))) return true;
      }
      return false;
    }
  };
}
function reasoningLoopFailure(diagnostics, maxTokens, channel) {
  const label = channel === "reasoning" ? "\u601D\u8003" : "\u6B63\u6587";
  const parts = [
    `\u6A21\u578B${label}\u9677\u5165\u75C5\u6001\u91CD\u590D\uFF0C\u5DF2\u4E2D\u6B62\u672C\u8F6E\uFF08**\u4E0D\u662F**\u8F93\u51FA token \u4E0A\u9650\uFF09\u3002`
  ];
  if (diagnostics !== void 0) {
    parts.push(
      `\u5224\u636E\uFF1A\u5C3E\u90E8 ${diagnostics.lines} \u884C\u91CC\u53EA\u6709 ${diagnostics.distinctLines} \u884C\u4E0D\u91CD\u590D\uFF08\u53BB\u91CD\u7387 ${diagnostics.distinctLineRatio.toFixed(3)}\uFF0C\u9608\u503C <0.35\uFF09\uFF0C\u8FDE\u7EED\u5FAA\u73AF\u4F53\u91CF ${diagnostics.runChars} \u5B57\u7B26\u3002`
    );
  }
  if (diagnostics !== void 0 && maxTokens !== void 0 && maxTokens > 0) {
    const usedTokens = Math.ceil(diagnostics.observedChars / 3.5);
    const remaining = Math.max(0, maxTokens - usedTokens);
    parts.push(
      `\u672C\u6B21${label}\u4EC5\u4EA7\u51FA\u7EA6 ${diagnostics.observedChars} \u5B57\u7B26\uFF08\u7EA6 ${usedTokens} token\uFF09\uFF0C\u989D\u5EA6 ${maxTokens} token \u4E2D**\u8FD8\u5269\u7EA6 ${remaining}**\uFF08\u4F30\u7B97\u503C\uFF09\u2014\u2014\u989D\u5EA6\u6CA1\u6709\u5360\u6EE1\uFF0C\u53EF\u4EE5\u76F4\u63A5\u7EE7\u7EED\u4EFB\u52A1\u3002`
    );
  } else {
    parts.push(`\u989D\u5EA6\u6CA1\u6709\u5360\u6EE1\uFF0C\u53EF\u4EE5\u76F4\u63A5\u7EE7\u7EED\u4EFB\u52A1\u3002`);
  }
  parts.push("\u82E5\u7EE7\u7EED\u540E\u518D\u6B21\u9677\u5165\u540C\u4E00\u5FAA\u73AF\uFF0C\u5EFA\u8BAE\u964D\u4F4E\u601D\u8003\u6863\u4F4D\u6216\u66F4\u6362\u6A21\u578B\u3002");
  return { message: parts.join(""), code: REASONING_LOOP_CODE };
}
function resolveReasoningLoopGuardFlag(raw) {
  if (raw === void 0) return true;
  const value = raw.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "no" || value === "off");
}
function isReasoningLoopGuardEnabled() {
  return resolveReasoningLoopGuardFlag(process.env.DSH_REASONING_LOOP_GUARD);
}
const THINK_CLOSE_TAG_RE = /<\/think(?::[0-9a-f]+)?>/g;
const THINK_ANY_TAG_RE = /<\/?think(?::[0-9a-f]+)?>/g;
function splitThinkTaggedContent(raw) {
  if (raw.length === 0) return void 0;
  const re = new RegExp(THINK_CLOSE_TAG_RE.source, "g");
  let last;
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) last = m;
  if (last === void 0) return void 0;
  if (isQuotedThinkTag(raw, last.index)) return void 0;
  const boundary = last.index;
  const textStart = boundary + last[0].length;
  const reasoning = raw.slice(0, boundary).replace(new RegExp(THINK_ANY_TAG_RE.source, "g"), "");
  return { reasoning, text: raw.slice(textStart), textStart };
}
function isQuotedThinkTag(raw, index) {
  const before = raw.slice(0, index).trimEnd();
  if (before.endsWith("`")) return true;
  const after = raw.slice(index).trimStart();
  const tagEnd = raw.indexOf(">", index);
  if (tagEnd !== -1 && raw.slice(tagEnd + 1).trimStart().startsWith("`")) return true;
  if ((before.match(/`/g) ?? []).length % 2 === 1) return true;
  const fences = raw.slice(0, index).match(/```/g);
  if (fences !== null && fences.length % 2 === 1) return true;
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineBefore = raw.slice(lineStart, index);
  if ((lineBefore.match(/'/g) ?? []).length % 2 === 1) return true;
  if ((lineBefore.match(/"/g) ?? []).length % 2 === 1) return true;
  return false;
}
const ASCII_LETTER_RE = /[A-Za-z]/;
function stripCourseLeak(text) {
  if (text.length === 0) return text;
  if (!text.includes("course") && !text.includes("\u8BFE")) return text;
  const lines = text.split("\n");
  let changed = false;
  const cleaned = lines.map((line) => {
    const match = /^([ \t]*)(course|课)(.*)$/.exec(line);
    if (match === null) return line;
    const [, indent, word, rest] = match;
    if (word === "course") {
      const first = rest[0];
      if (first !== void 0 && ASCII_LETTER_RE.test(first)) return line;
      const trimmed2 = rest.startsWith(" ") ? rest.slice(1) : rest;
      changed = true;
      return indent + trimmed2;
    }
    const trimmed = rest.startsWith(" ") ? rest.slice(1) : rest;
    changed = true;
    return indent + trimmed;
  });
  return changed ? cleaned.join("\n") : text;
}
function resolveCourseLeakStripFlag(raw) {
  if (raw === void 0) return true;
  const value = raw.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "no" || value === "off");
}
function isCourseLeakStripEnabled() {
  return resolveCourseLeakStripFlag(process.env.DSH_COURSE_LEAK_STRIP);
}
function stripCourseLeakIfEnabled(text) {
  return isCourseLeakStripEnabled() ? stripCourseLeak(text) : text;
}
function stripCourseLeakFromHistoryContent(role, content) {
  if (role !== "assistant") return content;
  if (!isCourseLeakStripEnabled()) return content;
  let changed = false;
  const cleaned = content.map((raw) => {
    if (typeof raw !== "object" || raw === null) return raw;
    const block = raw;
    if (block.type !== "text" && block.type !== "reasoning") return raw;
    if (typeof block.text !== "string" || block.text.length === 0) return raw;
    const stripped = stripCourseLeak(block.text);
    if (stripped === block.text) return raw;
    changed = true;
    return { ...block, text: stripped };
  });
  return changed ? cleaned : content;
}
function resolveThinkLeakStripFlag(raw) {
  if (raw === void 0) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
function isThinkLeakStripEnabled() {
  return resolveThinkLeakStripFlag(process.env.DSH_THINK_LEAK_STRIP);
}
function stripBareThinkCloseTagIfEnabled(text) {
  return isThinkLeakStripEnabled() ? stripBareThinkCloseTag(text) : text;
}
function stripBareThinkCloseTag(text) {
  const trimmed = text.trim();
  if (/^`.*<\/think>.*`$/.test(trimmed)) return text;
  let backtickCount = 0;
  for (const ch of text) if (ch === "`") backtickCount++;
  if (backtickCount % 2 === 1) return text;
  const stripped = trimmed.replace(/<\/think>/g, "").trim();
  if (stripped.length === 0) return "";
  return text;
}
function isProseTruncatedByStopString(text) {
  if (text.length === 0) return false;
  const tail = text.trimEnd();
  if (tail.length === 0) return false;
  let ticks = 0;
  for (const ch of tail) if (ch === "`") ticks += 1;
  if (ticks % 2 === 0) return false;
  return /`$/.test(tail) || /<$/.test(tail) || /<\/think$/.test(tail);
}
export {
  REASONING_LOOP_CODE,
  createBlankReasoningSuppressor,
  createReasoningLoopDetector,
  hasUsableToolName,
  isCourseLeakStripEnabled,
  isProseTruncatedByStopString,
  isReasoningLoopGuardEnabled,
  isThinkLeakStripEnabled,
  isTruncatedArguments,
  normalizeToolArguments,
  readWithIdleTimeout,
  reasoningLoopFailure,
  resolveCourseLeakStripFlag,
  resolveEmptyResponseReason,
  resolveReasoningLoopGuardFlag,
  resolveSliceChars,
  resolveThinkLeakStripFlag,
  resolveToolPairing,
  splitThinkTaggedContent,
  stripBareThinkCloseTag,
  stripBareThinkCloseTagIfEnabled,
  stripCourseLeak,
  stripCourseLeakFromHistoryContent,
  stripCourseLeakIfEnabled
};
