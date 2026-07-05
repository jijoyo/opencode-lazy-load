/**
 * opencode-lazy-load
 *
 * Strips ALL tool definitions from every LLM request. The LLM only sees
 * load_tool as a callable tool. To use any other tool (built-in, user-installed,
 * or MCP), the LLM must call load_tool — there is no other path.
 *
 * Features:
 *   - ALWAYS_VISIBLE: 7 core tools (bash, read, edit, write, task, glob, grep) always available
 *   - __list__: List all available tools (built-in + MCP)
 *   - 3-layer defense: HTTP interception + SSE redirect + pointer list
 *
 * Usage:
 *   load_tool({name: "toolname"})           → returns full instructions + schema
 *   load_tool({name: "__list__"})           → lists all available tools
 *
 * INSTALL:
 *   Place this file at .opencode/plugins/lazy-load/index.ts
 *   Add to global config: ["C:\\...\\lazy-load"]
 *
 * ENFORCEMENT: mechanical, not prompt-based. The LLM literally cannot call
 * any tool directly — the tool is not in the array.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

const originals = new Map<string, string>()
const originalSchemas = new Map<string, any>()
const mcpOriginals = new Map<string, string>()
const mcpSchemas = new Map<string, any>()
const turnLoaded = new Map<string, Set<string>>()

const ALWAYS_VISIBLE = ["bash", "read", "edit", "write", "task", "glob", "grep"]

function briefOf(description: string): string {
  if (!description) return ""
  const byPeriod = description.split(".")[0]
  const byNewline = description.split("\n")[0].trim()
  let candidate = byPeriod.length <= byNewline.length ? byPeriod : byNewline
  candidate = candidate.replace(/\$\{[^}]*\}/g, "").trim()
  if (candidate.length < 5) return ""
  return candidate.length > 80 ? candidate.slice(0, 77) + "..." : candidate
}

function buildPointerList(): string {
  const pointers: string[] = []
  for (const [name, desc] of originals) {
    if (name === "load_tool") continue
    const brief = briefOf(desc)
    pointers.push(brief ? `- ${name} - ${brief}` : `- ${name}`)
  }
  return pointers.sort().join("\n")
}

function isParsableJson(str: string): boolean {
  if (!str) return false
  try { JSON.parse(str); return true } catch { return false }
}

let _originalFetch: typeof fetch | null = null
let _fetchWrapped = false

function writeLog(_msg: string): void {
  // Logging disabled for production use
}

function wrapFetch(): void {
  if (_fetchWrapped) return
  _fetchWrapped = true
  _originalFetch = globalThis.fetch

  globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
    const isLLM = url.includes("/chat/completions") || url.includes("/v1/messages") ||
      url.includes("api.deepseek.com") || url.includes("api.openai.com") ||
      url.includes("anthropic.com") || url.includes("openrouter.ai")
    if (!isLLM || !init) return _originalFetch!.call(globalThis, input, init)
    writeLog(`Intercepts request to ${url}`)

    let sessionID = ""
    try {
      const h = init.headers
      const headers = h instanceof Headers ? h : Array.isArray(h) ? new Headers(h as any) : h ? new Headers(h as any) : new Headers()
      sessionID = headers.get("x-opencode-session") || headers.get("x-session-id") || headers.get("X-Session-Id") || ""
    } catch {}
    if (!sessionID) sessionID = `__req_${Date.now()}_${Math.random().toString(36).slice(2)}__`

    if (init.body) {
      let bodyText = ""
      if (typeof init.body === "string") bodyText = init.body
      else if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) bodyText = new TextDecoder().decode(init.body)
      else if (init.body instanceof Blob) bodyText = await init.body.text()

      if (bodyText) {
        try {
          const body = JSON.parse(bodyText)
          if (Array.isArray(body.tools)) {
            const toolCountBefore = body.tools.length
            for (const t of body.tools) {
              const fn = t?.function
              const name = fn?.name || t?.name || ""
              if (!name || name === "load_tool") continue
              if (originals.has(name)) {
                const params = fn?.parameters || t?.parameters
                if (params && !originalSchemas.has(name)) originalSchemas.set(name, params)
                continue
              }
              const desc = fn?.description || t?.description || ""
              const params = fn?.parameters || t?.parameters || {}
              if (desc && !mcpOriginals.has(name)) {
                mcpOriginals.set(name, desc)
                mcpSchemas.set(name, params)
              }
            }

            body.tools = body.tools.filter((t: any) => {
              const name = t?.function?.name || t?.name || ""
              return name === "load_tool" || ALWAYS_VISIBLE.includes(name)
            })
            writeLog(`Found ${toolCountBefore} tools, stripped ${toolCountBefore - body.tools.length}, keeping load_tool + ${ALWAYS_VISIBLE.length} always-visible`)

            if (Array.isArray(body.messages)) {
              let lastUserIdx = -1
              for (let i = body.messages.length - 1; i >= 0; i--) {
                if (body.messages[i].role === "user") { lastUserIdx = i; break }
              }
              if (lastUserIdx > 0) {
                const priorMessages = body.messages.slice(0, lastUserIdx)
                const loadToolCallIds = new Set<string>()
                for (const m of priorMessages) {
                  if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
                    for (const tc of m.tool_calls) {
                      if (tc?.function?.name === "load_tool" && tc?.id) loadToolCallIds.add(tc.id)
                    }
                  }
                }
                const filteredPrior: any[] = []
                for (const m of priorMessages) {
                  if (m.role === "tool" && loadToolCallIds.has(m.tool_call_id)) continue
                  if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
                    m.tool_calls = m.tool_calls.filter((tc: any) => tc?.function?.name !== "load_tool")
                    if (m.tool_calls.length === 0) {
                      delete m.tool_calls
                      if (!(typeof m.content === "string" && m.content.length > 0)) continue
                    }
                  }
                  filteredPrior.push(m)
                }
                body.messages = [...filteredPrior, ...body.messages.slice(lastUserIdx)]
                for (const m of body.messages) {
                  if (Array.isArray(m.tool_calls) && m.tool_calls.length === 0) delete m.tool_calls
                }
              }
            }

            const pointerList = buildPointerList()
            if (pointerList) {
              for (const t of body.tools) {
                const fn = t?.function
                if (fn && fn.name === "load_tool") {
                  fn.description = [
                    "Gateway tool — the only tool you can call directly.",
                    "All other tools are accessed through this tool.",
                    "",
                    "Available tools:",
                    pointerList,
                    "",
                    "Usage:",
                    '  Load instructions: call with {"name": "toolname"}',
                    "  After loading, call the real tool directly on your next turn.",
                  ].join("\n")
                }
              }
            }

            init = { ...init, body: JSON.stringify(body) }
          }
        } catch {}
      }
    }

    const response = await _originalFetch!.call(globalThis, input, init)
    const contentType = response.headers.get("content-type") || ""
    if (!contentType.includes("text/event-stream") || !response.body) return response
    const transformed = response.body.pipeThrough(createSSETransform(sessionID))
    return new Response(transformed, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}

function createSSETransform(sessionID: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  const toolBuffers = new Map<number, { id?: string; name?: string; arguments: string }>()
  function getTurnLoaded(): Set<string> {
    if (!turnLoaded.has(sessionID)) turnLoaded.set(sessionID, new Set())
    return turnLoaded.get(sessionID)!
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const events = buffer.split(/\n\n|\r\n\r\n/)
      buffer = events.pop() || ""
      for (const event of events) {
        const lines = event.split(/\n|\r\n/)
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          const data = line.startsWith("data: ") ? line.slice(6) : line.slice(5)
          if (data === "[DONE]") { controller.enqueue(encoder.encode("data: [DONE]\n\n")); continue }
          try {
            const parsed = JSON.parse(data)
            const toolCalls = parsed?.choices?.[0]?.delta?.tool_calls
            if (Array.isArray(toolCalls)) {
              const filtered: any[] = []
              for (const tc of toolCalls) {
                if (!tc || !tc.function) { filtered.push(tc); continue }
                const idx = tc.index
                if (!toolBuffers.has(idx)) {
                  toolBuffers.set(idx, { id: tc.id, name: tc.function.name, arguments: tc.function.arguments || "" })
                } else {
                  const buf = toolBuffers.get(idx)!
                  if (tc.id) buf.id = tc.id
                  if (tc.function.name) buf.name = tc.function.name
                  buf.arguments += tc.function.arguments || ""
                }
                const buf = toolBuffers.get(idx)!
                if (!isParsableJson(buf.arguments)) continue
                const name = buf.name || ""
                const callArgs = JSON.parse(buf.arguments)
                toolBuffers.delete(idx)
                if (name === "load_tool") {
                  const loadName = callArgs.name
                  if (loadName) getTurnLoaded().add(loadName)
                  filtered.push({ index: idx, id: buf.id, type: "function", function: { name: "load_tool", arguments: buf.arguments } })
                } else {
                  if (originals.has(name) && !ALWAYS_VISIBLE.includes(name)) {
                    if (getTurnLoaded().has(name)) {
                      filtered.push({ index: idx, id: buf.id, type: "function", function: { name, arguments: buf.arguments } })
                    } else {
                      getTurnLoaded().add(name)
                      filtered.push({ index: idx, id: buf.id, type: "function", function: { name: "load_tool", arguments: JSON.stringify({ name }) } })
                    }
                  } else {
                    filtered.push({ index: idx, id: buf.id, type: "function", function: { name, arguments: buf.arguments } })
                  }
                }
              }
              if (filtered.length > 0) {
                parsed.choices[0].delta.tool_calls = filtered
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`))
              } else {
                delete parsed.choices[0].delta.tool_calls
                const delta = parsed.choices[0].delta
                if (delta.content || delta.reasoning || parsed.choices[0].finish_reason) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`))
                }
              }
            } else {
              const fr = parsed?.choices?.[0]?.finish_reason
              if (fr === "stop") turnLoaded.delete(sessionID)
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`))
            }
          } catch { controller.enqueue(encoder.encode(`data: ${data}\n\n`)) }
        }
      }
    },
    flush(controller) {
      for (const [idx, buf] of toolBuffers) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: idx, id: buf.id, type: "function", function: { name: buf.name || "load_tool", arguments: buf.arguments } }] } }] })}\n\n`))
      }
      if (buffer) controller.enqueue(encoder.encode(buffer))
    },
  })
}

const LazyLoadPlugin: Plugin = async (_input, _options) => {
  wrapFetch()
  return {
    tool: {
      load_tool: tool({
        description: [
          "Gateway tool — the only tool you can call directly.",
          "All other tools are accessed through this tool.",
          "",
          "Always visible (no load needed): bash, read, edit, write, task, glob, grep",
          "",
          "Usage:",
          '  Load instructions: call with {"name": "toolname"}',
          '  List all tools: call with {"name": "__list__"}',
          "  After loading, call the real tool directly on your next turn.",
        ].join("\n"),
        args: { name: tool.schema.string().describe("Tool name to load instructions for") },
        async execute(args, context) {
          if (args.name === "__list__") {
            const builtIn = Array.from(originals.keys()).sort()
            const mcp = Array.from(mcpOriginals.keys()).sort()
            const lines = [
              "=== Built-in tools (always visible) ===",
              builtIn.filter(n => !ALWAYS_VISIBLE.includes(n)).join(", "),
              "",
              "=== MCP tools (load with load_tool) ===",
              ...mcp.map(n => `- ${n}`),
              "",
              `Total: ${builtIn.length} built-in + ${mcp.length} MCP`,
            ]
            return { title: "Available tools", output: lines.join("\n") }
          }

          const full = originals.get(args.name) || mcpOriginals.get(args.name)
          const schema = originalSchemas.get(args.name) || mcpSchemas.get(args.name)
          if (!full) {
            const allKnown = Array.from(new Set([...originals.keys(), ...mcpOriginals.keys()])).sort()
            return { title: `Unknown tool: ${args.name}`, output: `No instructions found for "${args.name}". Call load_tool({name: "__list__"}) to see all available tools.` }
          }
          let output = full
          if (schema) {
            try { output += "\n\n--- Parameter schema ---\n" + JSON.stringify(schema, null, 2) } catch {}
          }
          return { title: `Loaded: ${args.name}`, output }
        },
      }),
    },
    async "tool.definition"(input, output) {
      if (input.toolID === "load_tool") return
      if (!originals.has(input.toolID)) originals.set(input.toolID, output.description)
      const outAny = output as any
      if (outAny.jsonSchema !== undefined && !originalSchemas.has(input.toolID)) originalSchemas.set(input.toolID, outAny.jsonSchema)
    },
  }
}

export default { id: "opencode-lazy-load", server: LazyLoadPlugin }
