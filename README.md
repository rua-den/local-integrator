# local-integrator

A small local MCP bridge that lets Codex / ChatGPT desktop use Ollama models on the same machine as bounded reviewer workers.

The intended architecture is:

```text
GPT / Codex = scout + orchestrator
        |
        | selects only relevant diff / files / tests
        v
local-integrator MCP
        |
        v
Ornith 9B in Ollama = bounded reviewer / counterexample finder
```

Do **not** use Ornith 9B as a whole-repository explorer. Let the parent agent search the repo with `rg`, `git ls-files`, normal code search, etc., then pass only the relevant context into Ornith.

## Tools

- `ollama_models` — list local Ollama models.
- `ornith_ask` — bounded generic question with supplied context.
- `ornith_review_diff` — review a diff already collected by the parent agent.
- `ornith_review_code` — review selected source/test snippets.
- `ornith_find_counterexample` — adversarially try to falsify a claim/invariant.

The reviewer tools have **no filesystem access**. They cannot recursively walk a repo unless the parent agent explicitly dumps the repo into the prompt, and a default input budget blocks oversized calls.

## Requirements

- Node.js 20+
- Ollama running locally (default: `http://127.0.0.1:11434`)
- At least one local model installed

## Install / update

```powershell
git pull
npm install
npm run check
```

Check Ollama directly:

```powershell
curl.exe http://127.0.0.1:11434/api/tags
```

## Test the MCP server before connecting Codex

```powershell
npm run inspect
```

The MCP Inspector opens in a browser. Connect, open **Tools**, then call `ollama_models`.

Basic smoke test with `ornith_ask`:

```json
{
  "prompt": "Reply with exactly: ORNITH_OK",
  "temperature": 0,
  "max_output_tokens": 128
}
```

Then try the bounded code-review path:

```json
{
  "code": "// Foo.cs\npublic static int Divide(int a, int b) => a / b;",
  "question": "Find the smallest runtime failure case.",
  "max_output_tokens": 512
}
```

with `ornith_review_code`.

## Connect to Codex / ChatGPT desktop

Add this to your user-level `~/.codex/config.toml`.

On Windows, forward slashes avoid TOML escaping issues:

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
# Recommended once the exact local tag is known:
# OLLAMA_MODEL = "your-exact-ornith-model-name"
OLLAMA_TIMEOUT_MS = "180000"
OLLAMA_KEEP_ALIVE = "15m"
ORNITH_MAX_INPUT_CHARS = "60000"
ORNITH_NUM_PREDICT = "1536"
ORNITH_THINK = "false"
```

Restart Codex / ChatGPT desktop after saving the config.

In Codex TUI:

```text
/mcp
```

You should see `local_ollama` with all five tools.

## Recommended Codex usage

Do this:

```text
Find the implementation and tests relevant to PullRequestValidator yourself.
Use rg/git ls-files/code search; do not recursively enumerate generated folders.
Select only the relevant source/test snippets, then call ornith_review_code.
Ask Ornith for an independent review, then verify every finding yourself.
```

For a patch:

```text
Collect the narrow git diff for this fix, then call ornith_review_diff.
Do not ask Ornith to inspect the repository. After it answers, independently
verify each claimed regression against the actual repo.
```

For a regression boundary:

```text
Gather the production implementation plus the directly relevant tests.
Call ornith_find_counterexample with the invariant we believe is true.
Do not reveal your own suspected counterexample to Ornith. Verify its result yourself.
```

Avoid this:

```text
Ask Ornith to understand this whole repo and find bugs.
```

A 9B model can waste minutes deciding how to explore the filesystem, and commands such as recursive `Get-ChildItem` may spend much longer traversing `.git`, `bin`, `obj`, `node_modules`, test outputs, and generated files than the model spends reasoning.

## Performance defaults

The v0.2 defaults are intentionally biased toward local 9B latency:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama server URL |
| `OLLAMA_MODEL` | auto | Default local model name/tag |
| `OLLAMA_TIMEOUT_MS` | `180000` | Ollama request timeout |
| `OLLAMA_KEEP_ALIVE` | `15m` | Keep model loaded between reviewer calls |
| `ORNITH_MAX_INPUT_CHARS` | `60000` | Refuse oversized context instead of silently feeding a repo dump |
| `ORNITH_NUM_PREDICT` | `1536` | Default maximum generated tokens |
| `ORNITH_THINK` | `false` | Disable explicit thinking by default for speed |

Every response includes timing counters from Ollama when available, for example:

```text
model: ... (inputChars=12000, promptTokens=3100, outputTokens=420, load=0.02s, promptEval=4.10s, generate=19.20s, total=23.40s)
```

That makes it easy to distinguish model load time, prompt ingestion, and generation time.

If quality is more important than latency for one call, pass:

```json
{
  "think": true,
  "max_output_tokens": 2048
}
```

Do not globally enable thinking until the fast bounded workflow has been measured on your machine.

## Model resolution

Tool calls choose the model in this order:

1. Explicit `model` argument
2. `OLLAMA_MODEL`
3. First installed model whose name contains `ornith`
4. The only installed model, if exactly one exists
5. Otherwise return an error listing available models

## Safety / behavior

This is intentionally a local STDIO MCP server. Do not expose Ollama to the public internet just to make this work.

STDOUT is reserved for MCP protocol traffic. Diagnostics use STDERR only.

The specialized reviewer prompt explicitly tells the local model not to claim it ran tests/commands and not to invent repository state it was not given.
