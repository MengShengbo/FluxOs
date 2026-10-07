import { describe, expect, it } from 'vitest'
import { builtInToolAccess, declaredBuiltInToolNames } from './toolAccess'
import { getAllTools } from './toolRegistry'

describe('declared tool catalog contracts', () => {
  it('covers every registered tool exactly and fails closed on unknown resources', () => {
    expect(declaredBuiltInToolNames()).toEqual(getAllTools().map(tool => tool.name).sort())
    expect(() => builtInToolAccess('future_undeclared_tool')).toThrow('Missing tool access')
    for (const tool of getAllTools()) {
      expect(tool.access.output).toBe('ToolResult')
      expect(tool.access.resources.length).toBeGreaterThan(0)
      for (const resource of tool.access.resources) {
        if (resource.argument) expect(tool.parameters.map(parameter => parameter.name)).toContain(resource.argument)
      }
    }
  })
  it('declares shell and delegated effects as unknown instead of inferring read safety', () => {
    expect(builtInToolAccess('run_command').resources).toContainEqual({ kind: 'filesystem', access: 'unknown', scope: 'unknown' })
    expect(builtInToolAccess('spawn_agent').resources).toContainEqual({ kind: 'external', access: 'unknown', scope: 'unknown' })
  })
})
