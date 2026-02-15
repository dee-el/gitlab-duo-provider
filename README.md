# gitlab-duo-provider

Anthropic-compatible proxy server that bridges [Goose](https://github.com/block/goose) (or any Anthropic API client) to GitLab Duo's AI Gateway. This lets you use your GitLab Duo Pro/Enterprise subscription as the LLM backend for Goose with full tool calling and streaming support.

## How it works

```
Goose ──(Anthropic API)──> localhost:4141/v1/messages
  └──> @gitlab/gitlab-ai-provider (token exchange + caching)
    └──> cloud.gitlab.com/ai/v1/proxy/anthropic/ (Claude API)
```

GitLab's AI Gateway requires a 2-step authentication flow (fetch a short-lived token via your GitLab instance, then use it to call the Anthropic proxy). This server handles that automatically using the [`@gitlab/gitlab-ai-provider`](https://www.npmjs.com/package/@gitlab/gitlab-ai-provider) package — tokens are cached for 25 minutes and auto-refreshed.

## Supported models

| Model ID | Backend |
|----------|---------|
| `claude-opus-4-6` | Claude Opus 4.6 |
| `claude-opus-4-5-20251101` | Claude Opus 4.5 |
| `claude-sonnet-4-5-20250929` | Claude Sonnet 4.5 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |

## Prerequisites

- Node.js 20+
- GitLab Duo Pro or Enterprise subscription
- GitLab Personal Access Token (PAT) with `api` scope

## Setup

```bash
npm install

cp .env.example .env
# Edit .env and set GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx

npm start
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GITLAB_TOKEN` | *(required)* | GitLab PAT with `api` scope |
| `GITLAB_INSTANCE_URL` | `https://gitlab.com` | GitLab instance URL |
| `GITLAB_AI_GATEWAY_URL` | `https://cloud.gitlab.com` | AI Gateway URL (for self-hosted) |
| `PORT` | `4141` | Proxy server port |
| `DEFAULT_MODEL` | `claude-sonnet-4-5-20250929` | Default model when none specified |
| `DEBUG` | *(unset)* | Set to `1` to log incoming requests |

## Goose configuration

### Step 1: Add the custom provider

Create `~/.config/goose/custom_providers/gitlab_duo.json`:

```json
{
  "name": "gitlab_duo",
  "engine": "anthropic",
  "display_name": "GitLab Duo",
  "description": "GitLab Duo AI via local proxy (Claude models with tool calling)",
  "api_key_env": "GITLAB_DUO_PROXY_KEY",
  "base_url": "http://localhost:4141",
  "models": [
    { "name": "claude-opus-4-6", "context_limit": 200000 },
    { "name": "claude-sonnet-4-5-20250929", "context_limit": 200000 },
    { "name": "claude-opus-4-5-20251101", "context_limit": 200000 },
    { "name": "claude-haiku-4-5-20251001", "context_limit": 200000 }
  ],
  "supports_streaming": true,
  "requires_auth": false
}
```

### Step 2: Configure Goose

```bash
goose configure
```

When prompted:

1. Select **Configure Providers**
2. Select **GitLab Duo**
3. Set `ANTHROPIC_HOST` to `http://localhost:4141`
4. Set `ANTHROPIC_API_KEY` to any non-empty string (e.g. `dummy`) — auth is handled by the proxy server via your `GITLAB_TOKEN`
5. Select your model (e.g. `claude-opus-4-6`)

### Step 3: Use Goose

Make sure the proxy is running first (`npm start`), then:

```bash
goose session start

# Or run a recipe:
goose run --recipe my-recipe --params key=value
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API (streaming + non-streaming) |
| `GET` | `/v1/models` | List available models |
| `GET` | `/` | Health check / info |

## Development

```bash
# Hot reload
npm run dev

# Type check
npm run typecheck

# Debug logging
DEBUG=1 npm start
```
