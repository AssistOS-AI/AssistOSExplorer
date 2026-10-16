# Soul Gateway — Provider API Keys

> **Do NOT commit this file to git.** It contains secrets.

## LLM Providers

| Provider | Dashboard Name | Base URL | API Key |
|----------|---------------|----------|---------|
| OpenRouter | openrouter | `https://openrouter.ai/api/v1/chat/completions` | *(GitHub secret: `OPENROUTER_API_KEY`)* |
| CLIProxyAPI | axiologic_proxy | `http://10.0.2.2:8317/v1/chat/completions` | `sk-6992d807ac65daebdb0c422e5228b5d90df84b5759db2765fd7d5f50b36ec64c` |
| Kiro Gateway | axiologic_kiro | `http://10.0.2.2:8000/v1/chat/completions` | `kiro-gateway-key` (subscription, managed auth) |
| Copilot Gateway | copilot | `http://10.0.2.2:4141/v1/chat/completions` | `no-auth-needed` (subscription, managed auth) |
| OpenAI | openai | `https://api.openai.com/v1/chat/completions` | *(GitHub secret: `OPENAI_API_KEY`)* |
| Anthropic | anthropic | `https://api.anthropic.com/v1/messages` | *(GitHub secret: `ANTHROPIC_API_KEY`)* |
| Google AI | google | `https://generativelanguage.googleapis.com/v1beta/models/` | *(GitHub secret: `GEMINI_API_KEY`)* |
| Mistral | mistral | `https://api.mistral.ai/v1/chat/completions` | *(GitHub secret: `MISTRAL_API_KEY`)* |
| xAI (Grok) | xai | `https://api.x.ai/v1/chat/completions` | *(GitHub secret: `XAI_API_KEY`)* |
| NVIDIA | nvidia | `https://integrate.api.nvidia.com/v1/chat/completions` | *(GitHub secret: `NVIDIA_API_KEY`)* |
| DeepSeek | deepseek | `https://api.deepseek.com/v1/chat/completions` | *(GitHub secret: `DEEPSEEK_API_KEY`)* |
| Groq | groq | `https://api.groq.com/openai/v1/chat/completions` | *(GitHub secret: `GROQ_API_KEY`)* |
| Together AI | together | `https://api.together.xyz/v1/chat/completions` | *(GitHub secret: `TOGETHER_API_KEY`)* |
| Fireworks AI | fireworks | `https://api.fireworks.ai/inference/v1/chat/completions` | *(GitHub secret: `FIREWORKS_API_KEY`)* |
| DeepInfra | deepinfra | `https://api.deepinfra.com/v1/openai/chat/completions` | *(GitHub secret: `DEEPINFRA_API_KEY`)* |
| Perplexity | perplexity | `https://api.perplexity.ai/chat/completions` | *(GitHub secret: `PERPLEXITY_API_KEY`)* |
| Cohere | cohere | `https://api.cohere.com/v2/chat` | *(GitHub secret: `COHERE_API_KEY`)* |
| OpenCode | opencode | `https://opencode.ai/zen/v1/chat/completions` | *(GitHub secret: `OPENCODE_API_KEY`)* |
| OpenCode (Anthropic) | opencode_anthropic | `https://opencode.ai/zen/v1/messages` | *(same as OpenCode)* |
| OpenCode (Responses) | opencode_responses | `https://opencode.ai/zen/v1/responses` | *(same as OpenCode)* |

## OAuth Providers (Managed Auth)

These use device-flow or PKCE OAuth — no static API key. Use the "Manage" button in the dashboard.

| Provider | Dashboard Name | Protocol |
|----------|---------------|----------|
| GitHub Copilot | copilot | openai |
| Kiro (AWS Claude) | axiologic_kiro | openai |
| OpenAI Codex | codex | openai |
| Google Gemini | gemini | openai |
| Anthropic Claude | anthropic | anthropic |

## Search Providers

Configure via the dashboard "Add Provider" dropdown (search templates).

| Provider | Dashboard Name | Base URL | API Key |
|----------|---------------|----------|---------|
| Tavily | tavily | `https://api.tavily.com/search` | *(GitHub secret: `TAVILY_API_KEY`)* |
| Brave Search | brave | `https://api.search.brave.com/res/v1/web/search` | *(GitHub secret: `BRAVE_API_KEY`)* |
| Exa | exa | `https://api.exa.ai/search` | *(GitHub secret: `EXA_API_KEY`)* |
| Serper | serper | `https://google.serper.dev/search` | *(GitHub secret: `SERPER_API_KEY`)* |
| Jina | jina | `https://s.jina.ai/` | *(optional)* |
| DuckDuckGo | duckduckgo | `https://html.duckduckgo.com/html/` | *(none needed)* |
| SearXNG | searxng | *(self-hosted URL)* | *(none needed)* |
| Gemini Search | gemini_search | `https://generativelanguage.googleapis.com/v1beta/models/` | *(same as Google AI key)* |

## Search Gateway (External)

| Key | Value |
|-----|-------|
| Search Gateway URL | `http://10.0.2.2:8043/v1/chat/completions` |
| `SEARCH_GATEWAY_API_KEY` | *(GitHub secret)* |

## Soul Gateway Keys

| Key | Value |
|-----|-------|
| `PLOINKY_AGENT_API_KEY` | *(runtime-injected signed-subject key of shape `subjectId` + `\|` + signature; not a static secret)* |
| Dashboard password | `soulpass!321` |
| Default proxy API key | *(GitHub secret: `SG_DEFAULT_PROXY_API_KEY`)* |
