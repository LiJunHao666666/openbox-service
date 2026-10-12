'use strict';
/**
 * 领域 · 工具目录（服务端权威副本）
 *
 * ⚠️ 这是计价与耗时的唯一权威来源。
 * 前端提交的任何 plan / price / mins 都只当「参考」，一律被本目录重算覆盖 ——
 * 否则任何人只要改一个请求体就能把 199 的单子改成 1 块。
 *
 * 与 index.html 里的 TOOLS 保持一致；改动时两边同步。
 */

const CATEGORIES = {
  terminal: { label: '命令行' },
  editor: { label: '编辑器' },
  model: { label: '本地模型' },
  vision: { label: '绘图' },
  voice: { label: '语音' },
  flow: { label: '应用编排' },
  base: { label: '基础环境' },
};

const TOOLS = [
  { id: 'claude-code', name: 'Claude Code', cat: 'terminal', mins: 15, need: '需接口' },
  { id: 'codex-cli', name: 'Codex CLI', cat: 'terminal', mins: 15, need: '需接口' },
  { id: 'gemini-cli', name: 'Gemini CLI', cat: 'terminal', mins: 15, need: '需接口' },
  { id: 'aider', name: 'Aider', cat: 'terminal', mins: 20, need: '需接口' },

  { id: 'cursor', name: 'Cursor', cat: 'editor', mins: 20, need: '需订阅' },
  { id: 'vscode', name: 'VS Code', cat: 'editor', mins: 10, need: '免费' },
  { id: 'trae', name: 'Trae', cat: 'editor', mins: 20, need: '免费' },
  { id: 'copilot', name: 'GitHub Copilot', cat: 'editor', mins: 10, need: '需订阅' },
  { id: 'cline', name: 'Cline', cat: 'editor', mins: 15, need: '需接口' },

  { id: 'ollama', name: 'Ollama', cat: 'model', mins: 25, need: '免费' },
  { id: 'lmstudio', name: 'LM Studio', cat: 'model', mins: 20, need: '免费' },
  { id: 'anythingllm', name: 'AnythingLLM', cat: 'model', mins: 30, need: '免费' },
  { id: 'openwebui', name: 'Open WebUI', cat: 'model', mins: 30, need: '免费' },

  { id: 'comfyui', name: 'ComfyUI', cat: 'vision', mins: 45, need: '需显卡' },
  { id: 'sd-webui', name: 'SD WebUI', cat: 'vision', mins: 45, need: '需显卡' },

  { id: 'whisper', name: 'Whisper', cat: 'voice', mins: 25, need: '免费' },
  { id: 'gpt-sovits', name: 'GPT-SoVITS', cat: 'voice', mins: 50, need: '需显卡' },

  { id: 'dify', name: 'Dify', cat: 'flow', mins: 40, need: '免费' },
  { id: 'ragflow', name: 'RAGFlow', cat: 'flow', mins: 50, need: '免费' },

  { id: 'nodejs', name: 'Node.js 环境', cat: 'base', mins: 10, need: '免费' },
  { id: 'python', name: 'Python 环境', cat: 'base', mins: 10, need: '免费' },
  { id: 'git', name: 'Git', cat: 'base', mins: 10, need: '免费' },
  { id: 'docker', name: 'Docker', cat: 'base', mins: 30, need: '免费' },
  { id: 'cuda', name: '显卡加速环境', cat: 'base', mins: 25, need: '需显卡' },
];

const BY_ID = new Map(TOOLS.map((t) => [t.id, t]));

/** 单个工具的最长耗时上限，用于兜底防止异常数据 */
const MAX_TOTAL_MINS = 600;
const MAX_TOOLS = 30;

module.exports = { CATEGORIES, TOOLS, BY_ID, MAX_TOTAL_MINS, MAX_TOOLS };
