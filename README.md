# AgentRelay

> **Zero-dependency local proxy bridging any OpenAI-compatible coding agent with free/subscription web chatbots.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-zero-orange.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**AgentRelay** intercepts requests from **any OpenAI-compatible coding agent** (such as **Cline**, **Roo Code**, **Continue**, **Aider**, or custom agentic workflows) and displays them on a sleek local web dashboard. You copy the prompt to your favorite web chatbot (**ChatGPT**, **Claude**, **Gemini**, **DeepSeek**) and paste the response back. AgentRelay streams it directly to your agent via standard OpenAI Server-Sent Events (SSE).

No paid API keys, credits, or token fees required.

---

## 🚀 Quick Start

Ensure [Node.js](https://nodejs.org/) (v18+) is installed. **Zero external dependencies—no `npm install` needed:**

```bash
git clone https://github.com/MohammadKermani/AgentPipe.git
cd AgentPipe
npm start
```

Dashboard runs at: **`http://localhost:4747`**

---

## ⚙️ Coding Agent Setup

In your agent or IDE extension settings (Cline, Roo Code, Continue, etc.), select **OpenAI Compatible**:

| Setting | Value |
| :--- | :--- |
| **API Provider** | `OpenAI Compatible` |
| **Base URL** | `http://localhost:4747/v1` |
| **API Key** | `agentrelay` *(or any arbitrary string)* |
| **Model ID** | `gpt-4o` *(or any model name your agent expects)* |

---

## 🔄 Workflow

```
[ Any Coding Agent ] ──(Request)──> [ AgentRelay :4747 ] ──(Web Dashboard)
                                                                    │
                                                            (Copy / Paste)
                                                                    ▼
[ Any Coding Agent ] <──(SSE Stream)── [ AgentRelay ] <── [ Web Chatbot ]
```

1. **Init Web Chat:** Click **`📋 Copy System Prompt`** in the dashboard and paste it once into a fresh web chat to set up the engine rules.
2. **Copy Request:** When your agent sends a query, click **`Copy (Compact)`** (for iterative tool outputs/prompts) or **`Full Context`** (for starting fresh tasks).
3. **Dispatch:** Paste the LLM's response into the dashboard and press `Ctrl + Enter` (or click **Send**). AgentRelay handles token streaming, JSON sanitization, and execution automatically.

---

## ✨ Features

- **⚡ Universal OpenAI SSE Stream:** Emulates real-time chunked streaming (`/v1/chat/completions`) compatible with any standard agent client.
- **🛡️ Auto-Sanitizer:** Automatically removes `<think>` reasoning tags, conversational fluff, and markdown code block wrappers from web outputs.
- **🪶 Zero Dependencies:** Powered exclusively by native Node.js core modules (`http`, `fs`, `path`, `crypto`).
- **📌 Sticky & Responsive UI:** Fixed-height editor, top-center toasts, and sticky controls for seamless multitasking across long request lists.

---

## 📄 License

Distributed under the [MIT License](LICENSE).
