# local-integrator

A tiny local MCP bridge that lets Codex / ChatGPT desktop call models running in Ollama on the same machine.

Current tools:

- `ollama_models` — list local Ollama models.
- `ornith_ask` — send an independent task/review/question to a local Ollama model.

## Requirements

- Node.js 20+
- Ollama running locally (default: `http://127.0.0.1:11434`)
- At least one local model installed

## Install

```powershell
npm install
```

Check Ollama directly first:

```powershell
curl.exe http://127.0.0.1:11434/api/tags
```

## Test the MCP server before connecting Codex

```powershell
npm run inspect
```

The MCP Inspector opens in a browser. Connect, open **Tools**, then:

1. Call `ollama_models`.
2. Copy the exact Ornith model name returned by Ollama.
3. Call `ornith_ask` with e.g.:

```json
{
  "prompt": "Reply with exactly: ORNITH_OK",
  "model": "YOUR_EXACT_OLLAMA_MODEL_NAME",
  "temperature": 0
}
```

If your only installed model contains `ornith` in its name, `model` can usually be omitted.

## Connect to Codex / ChatGPT desktop

Codex CLI, the Codex IDE extension, and ChatGPT desktop can use local STDIO MCP servers. Add this to your user-level `~/.codex/config.toml`.

On Windows, using forward slashes in the TOML path avoids escaping backslashes:

```toml
[mcp_servers.local_ollama]
command = "node"
args = ["src/index.js"]
cwd = "C:/ABSOLUTE/PATH/TO/local-integrator"
startup_timeout_sec = 20
tool_timeout_sec = 180
enabled = true

[mcp_servers.local_ollama.env]
OLLAMA_BASE_URL = "http://127.0.0.1:11434"
# Recommended after you know the exact tag from ollama_models:
# OLLAMA_MODEL = "your-exact-ornith-model-name"
OLLAMA_TIMEOUT_MS = "180000"
```

Restart Codex / ChatGPT desktop after saving the config.

In Codex TUI, run:

```text
/mcp
```

You should see `local_ollama` with the tools `ollama_models` and `ornith_ask`.

Then try:

```text
Use ollama_models and tell me which local model is available.
```

And then:

```text
Ask Ornith through ornith_ask: "Reply with exactly ORNITH_OK". Do not answer it yourself.
```

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama server URL |
| `OLLAMA_MODEL` | auto | Default local model name/tag |
| `OLLAMA_TIMEOUT_MS` | `180000` | Ollama request timeout |

Model resolution order for `ornith_ask`:

1. Explicit `model` argument
2. `OLLAMA_MODEL`
3. First installed model whose name contains `ornith`
4. The only installed model, if exactly one exists
5. Otherwise return an error listing available models

## Notes

This is intentionally a local STDIO MCP server. Do not expose Ollama directly to the public internet just to make this work.

STDOUT is reserved for MCP protocol traffic. Server diagnostics are written to STDERR only.
