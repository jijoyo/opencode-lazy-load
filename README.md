# opencode-lazy-load

OpenCode plugin that reduces MCP tool token overhead by 88-90% through HTTP body interception and on-demand tool loading.

## Problem

9 MCP servers × ~250 tool definitions = ~40-70k tokens consumed per conversation before a single user message. This wastes context window and increases API costs.

## Solution

This plugin intercepts `globalThis.fetch` to strip ALL tool definitions from HTTP requests to the LLM. The LLM only sees `load_tool` as a callable tool plus 7 ALWAYS_VISIBLE core tools. When the LLM needs a tool, it calls `load_tool({name: "toolname"})` to get full instructions, then calls the real tool directly.

## Results

| Metric | Before | After |
|--------|--------|-------|
| Tools visible to LLM | ~113 (13 built-in + ~100 MCP) | 20 (load_tool + 7 ALWAYS_VISIBLE + 12 built-in) |
| Token overhead | ~40-70k | ~6-8k |
| Savings | - | ~88-90% |
| MCP servers connected | 9 | 9 (still active) |

## Architecture: 3-Layer Defense

```
Layer 1: HTTP Body Interception (mechanical)
- Strips all tools except load_tool + 7 ALWAYS_VISIBLE
- Reliability: 100%

Layer 2: SSE Transform (mechanical)
- Redirects direct MCP calls → load_tool
- Reliability: 100%

Layer 3: Pointer List (semi-mechanical)
- load_tool description lists all available tools
- Reliability: ~90% (depends on LLM)
```

## ALWAYS_VISIBLE Tools

7 core tools that are NEVER stripped from the HTTP body:
```
bash, read, edit, write, task, glob, grep
```
These work directly without `load_tool`. All other tools require `load_tool`.

## Installation

1. Copy `index.ts` to `.opencode/plugins/lazy-load/`
2. Add to global config `~/.config/opencode/opencode.jsonc`:
```jsonc
{
  "plugin": ["C:\\path\\to\\opencode-lazy-load"]
}
```
3. Restart OpenCode Desktop

## Usage

```typescript
// Load instructions for a tool
load_tool({name: "supabase_list_tables"})

// List all available tools
load_tool({name: "__list__"})
```

## Available Tools

After loading, these tools are accessible via `load_tool`:

**Built-in (always visible, no load needed):**
bash, read, edit, write, task, glob, grep

**MCP tools (load with load_tool):**
supabase_*, memory_*, context7_*, playwright_*, chrome-devtools_*, sequential-thinking_*

## Comparison

| Feature | opencode-lazy-load | omarwaly-ai/opencode-lazy-loading | keybrdist/opencode-lazy-loader |
|---------|-------------------|-----------------------------------|-------------------------------|
| ALWAYS_VISIBLE | ✅ 7 tools | ❌ | N/A |
| __list__ command | ✅ | ❌ | N/A |
| 3-layer defense | ✅ | ❌ (2 layers) | ❌ |
| MCP proxy | ✅ Full | ⚠️ Partial | ✅ Different purpose |
| Token savings | 88-90% | 95-98% | N/A |
| Dependencies | 1 | 0 | 3 |

## How It Works

1. **Request Interception**: Strips all tool definitions from HTTP body except `load_tool` and ALWAYS_VISIBLE tools
2. **Pointer List**: Appends available tool names to `load_tool` description
3. **SSE Transform**: Intercepts LLM responses and redirects direct tool calls to `load_tool` when not yet loaded
4. **Turn Tracking**: Tracks which tools have been loaded per turn, clears on conversation completion

## Known Limitations

- **Argument type coercion**: Arrays/booleans may arrive as strings to MCP servers (OpenCode bug #34652)
- **LLM behavioral**: ~10% of calls miss `load_tool` first (SSE transform catches these)
- **MCP tools bypass `tool.definition` hook**: OpenCode bug #31670 (PR #31671 pending)

## License

MIT

## Built with

AI-assisted development (OpenCode + Mimo v2.5).
