import type { ToolCall } from '@fluxos/contracts/agentTypes'

/** Expand a model envelope only. Target lookup, authorization and effects belong to the normal tool lifecycle. */
export function decodeDeferredToolCall(call: ToolCall): ToolCall {
  if (call.name !== 'call_tool') return call
  const envelope = call.arguments
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('call_tool arguments must be an object containing name and arguments_json')
  }
  const unexpected = Object.keys(envelope).find(key => key !== 'name' && key !== 'arguments_json')
  if (unexpected) throw new Error(`Unexpected call_tool parameter: ${unexpected}`)
  if (typeof envelope.name !== 'string' || !envelope.name.trim()) throw new Error('call_tool name must be a nonempty tool name')
  if (envelope.name !== envelope.name.trim()) throw new Error('call_tool name must match the exact tool name without surrounding whitespace')
  if (envelope.name === 'call_tool' || envelope.name === 'tool_search') throw new Error(`call_tool cannot invoke ${envelope.name}`)
  if (typeof envelope.arguments_json !== 'string' || !envelope.arguments_json.trim()) {
    throw new Error('call_tool arguments_json must be a JSON-encoded object')
  }
  let args: unknown
  try { args = JSON.parse(envelope.arguments_json) }
  catch { throw new Error('call_tool arguments_json is not valid JSON') }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('call_tool arguments_json must decode to an object')
  return {
    ...call,
    name: envelope.name,
    arguments: args as Record<string, unknown>,
    modelInvocation: call.modelInvocation ?? { name: call.name, arguments: { ...envelope } },
  }
}
