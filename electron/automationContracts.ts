import { z } from 'zod';

export const valueSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.unknown() }),
  z.object({ kind: z.literal('variable'), key: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('template'), template: z.string().max(100_000) }),
  z.object({ kind: z.literal('resource'), key: z.string().min(1).max(200), property: z.string().max(200).optional() })
]);

export const selectionModeSchema = z.enum(['exact', 'first', 'last', 'nth', 'all', 'selected', 'new']);

export const semanticTargetSchema = z.object({
  surface: z.enum(['browser', 'desktop']),
  selection: selectionModeSchema.default('exact'),
  index: z.number().int().min(0).max(100_000).optional(),
  scope: z.object({
    url: z.string().max(10_000).optional(),
    title: z.string().max(1000).optional(),
    process: z.string().max(500).optional(),
    processId: z.number().int().positive().optional(),
    windowTitle: z.string().max(1000).optional(),
    frame: z.enum(['main', 'any']).optional()
  }).default({}),
  match: z.object({
    id: z.string().max(1000).optional(),
    role: z.string().max(200).optional(),
    controlType: z.string().max(200).optional(),
    name: z.string().max(2000).optional(),
    nameContains: z.string().max(2000).optional(),
    text: z.string().max(20_000).optional(),
    textContains: z.string().max(20_000).optional(),
    label: z.string().max(2000).optional(),
    placeholder: z.string().max(2000).optional(),
    tag: z.string().max(200).optional(),
    automationId: z.string().max(1000).optional(),
    className: z.string().max(1000).optional(),
    href: z.string().max(10_000).optional(),
    value: z.string().max(100_000).optional(),
    testId: z.string().max(1000).optional(),
    attributes: z.record(z.string(), z.string().max(20_000)).optional(),
    state: z.object({
      visible: z.boolean().optional(),
      enabled: z.boolean().optional(),
      selected: z.boolean().optional(),
      checked: z.boolean().optional(),
      expanded: z.boolean().optional(),
      editable: z.boolean().optional()
    }).optional()
  }),
  relativeTo: z.object({
    relation: z.enum(['inside', 'descendant', 'child', 'parent', 'ancestor', 'before', 'after', 'near']),
    match: z.record(z.string(), z.unknown())
  }).optional(),
  recordedFallback: z.object({
    x: z.number(),
    y: z.number(),
    process: z.string().max(500).optional(),
    windowTitle: z.string().max(1000).optional()
  }).optional()
});

export const automationSurfaceSchema = z.enum([
  'browser', 'desktop', 'filesystem', 'process', 'windows', 'document', 'network', 'code', 'model', 'vision'
]);

export const automationOperationSchema = z.enum([
  'query', 'read', 'extract', 'click', 'doubleClick', 'contextClick', 'focus', 'hover',
  'fill', 'type', 'clear', 'press', 'select', 'addToSelection', 'removeFromSelection', 'selectOption', 'setRange', 'check', 'uncheck', 'toggle',
  'expand', 'collapse', 'scroll', 'scrollIntoView', 'dragDrop', 'upload', 'download',
  'navigate', 'back', 'forward', 'reload', 'openTab', 'closeTab', 'switchTab',
  'screenshot', 'getCookies', 'setCookie', 'clearCookies',
  'getStorage', 'setStorage', 'clearStorage', 'saveSessionState', 'loadSessionState',
  'networkRequests', 'networkResponse', 'startHar', 'stopHar',
  'wait', 'assert', 'launch', 'move', 'resize', 'minimize', 'maximize',
  'list', 'search', 'stat', 'exists', 'readText', 'writeText', 'createDirectory', 'copy', 'rename', 'delete', 'trash', 'watch', 'open',
  'inspect', 'stop', 'captureOutput', 'listWindows', 'focusWindow',
  'createDocument', 'insertImage', 'replaceText', 'save', 'reopen',
  'request', 'webhook', 'execute',
  'generate', 'classify', 'extractData', 'transform', 'compare', 'critique',
  'locate', 'visualClick', 'visualAssert'
]);

const automationFallbackSchema = z.object({
  tool: z.string().min(3).max(200),
  surface: automationSurfaceSchema,
  operation: automationOperationSchema,
  target: semanticTargetSchema.optional(),
  value: valueSourceSchema.optional(),
  options: z.record(z.string(), z.unknown()).default({})
});

export const automationActionSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  dependsOn: z.array(z.string().min(1).max(200)).max(100).default([]),
  phase: z.enum(['beforeAi', 'afterAi']).default('beforeAi'),
  tool: z.string().min(3).max(200).optional(),
  surface: automationSurfaceSchema,
  operation: automationOperationSchema,
  target: semanticTargetSchema.optional(),
  value: valueSourceSchema.optional(),
  options: z.record(z.string(), z.unknown()).default({}),
  fallbacks: z.array(automationFallbackSchema).max(10).default([]),
  successCriteria: z.array(z.string().min(1).max(1000)).max(20).default([]),
  forEach: z.object({
    source: valueSourceSchema,
    itemVariable: z.string().min(1).max(200).default('item'),
    indexVariable: z.string().min(1).max(200).default('index'),
    targetEachMatch: z.boolean().default(false)
  }).optional(),
  output: z.object({
    key: z.string().min(1).max(200),
    type: z.enum(['string', 'number', 'boolean', 'json', 'list', 'file', 'folder']).default('json')
  }).optional()
});

export const postconditionSchema = z.object({
  kind: z.enum(['browser', 'desktop', 'filesystem', 'variable', 'artifact', 'document', 'image', 'process', 'network']),
  assertion: z.enum([
    'exists', 'notExists', 'equals', 'notEquals', 'contains', 'matches',
    'countEquals', 'countAtLeast', 'visible', 'hidden', 'enabled', 'disabled',
    'selected', 'checked', 'unchecked', 'urlEquals', 'urlContains',
    'fileExists', 'directoryExists', 'hashEquals', 'nonEmpty',
    'mimeTypeEquals', 'widthAtLeast', 'heightAtLeast', 'mediaCountEquals',
    'mediaCountAtLeast', 'reopenable', 'statusEquals', 'exitCodeEquals'
  ]),
  target: semanticTargetSchema.optional(),
  actual: valueSourceSchema.optional(),
  expected: valueSourceSchema.optional(),
  path: valueSourceSchema.optional(),
  property: z.string().max(200).optional(),
  timeoutMs: z.number().int().min(0).max(3_600_000).default(10_000),
  message: z.string().max(2000).optional()
});

export const aiContractSchema = z.object({
  instruction: z.string().min(1).max(100_000),
  inputs: z.array(z.object({
    name: z.string().min(1).max(200),
    source: valueSourceSchema,
    required: z.boolean().default(true)
  })).max(100).default([]),
  output: z.object({
    key: z.string().min(1).max(200),
    type: z.enum(['text', 'json', 'image', 'audio', 'files']),
    cardinality: z.enum(['once', 'perItem', 'perRow']).default('once'),
    behavior: z.enum(['create', 'replace', 'append', 'return']).default('return'),
    destination: valueSourceSchema.optional(),
    fileName: valueSourceSchema.optional(),
    minimumItems: z.number().int().min(1).max(10_000).optional(),
    maximumItems: z.number().int().min(1).max(10_000).optional()
  })
});

export const automationStepContractSchema = z.object({
  literals: z.record(z.string(), z.unknown()).default({}),
  resources: z.record(z.string(), z.object({
    kind: z.enum(['file', 'folder', 'application', 'browserTab', 'desktopSelection', 'browserSelection']),
    value: z.unknown().optional(),
    permission: z.enum(['read', 'write', 'readWrite', 'control']).default('control'),
    runtimeSelectable: z.boolean().default(false)
  })).default({}),
  actions: z.array(automationActionSchema).max(500).default([]),
  ai: aiContractSchema.optional(),
  postconditions: z.array(postconditionSchema).max(100).default([]),
  failure: z.object({
    mode: z.enum(['fail', 'retry', 'repair', 'askUser']).default('fail'),
    maximumAttempts: z.number().int().min(1).max(10).default(1),
    retryDelayMs: z.number().int().min(0).max(300_000).default(1000)
  }).default({ mode: 'fail', maximumAttempts: 1, retryDelayMs: 1000 }),
  flightCheck: z.object({
    status: z.enum(['passed', 'failed']),
    checkedAt: z.string(),
    registryHash: z.string(),
    toolCount: z.number().int().min(0),
    requiredCapabilities: z.array(z.string()),
    scenarios: z.array(z.object({
      name: z.string(),
      status: z.enum(['passed', 'notApplicable']),
      detail: z.string()
    })),
    issues: z.array(z.object({
      severity: z.enum(['error', 'warning']),
      code: z.string(),
      actionId: z.string().optional(),
      message: z.string()
    }))
  }).optional()
});

export type ValueSource = z.infer<typeof valueSourceSchema>;
export type SemanticTarget = z.infer<typeof semanticTargetSchema>;
export type AutomationAction = z.infer<typeof automationActionSchema>;
export type Postcondition = z.infer<typeof postconditionSchema>;export type AutomationStepContract = z.infer<typeof automationStepContractSchema>;

export function orderAutomationActions(actions: AutomationAction[]) {
  const normalized = actions.map((action, index) => ({ ...action, id: action.id || `action_${index + 1}` }));
  const byId = new Map(normalized.map((action) => [action.id!, action]));
  if (byId.size !== normalized.length) throw new Error('The automation action graph contains duplicate node IDs.');
  const output: AutomationAction[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`The automation action graph contains a cycle at ${id}.`);
    const action = byId.get(id);
    if (!action) throw new Error(`The automation action graph references an unknown dependency: ${id}.`);
    visiting.add(id);
    for (const dependency of action.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    output.push(action);
  };
  for (const action of normalized) visit(action.id!);
  return output;
}

function propertyAt(value: unknown, property?: string) {
  if (!property) return value;
  return property.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

export function resolveValueSource(
  source: ValueSource | undefined,
  context: Record<string, unknown>,
  literals: Record<string, unknown> = {},
  resources: Record<string, unknown> = {}
) {
  if (!source) return undefined;
  if (source.kind === 'literal') return source.value;
  if (source.kind === 'variable') {
    if (Object.prototype.hasOwnProperty.call(context, source.key)) return context[source.key];
    if (Object.prototype.hasOwnProperty.call(literals, source.key)) return literals[source.key];
    const nestedContext = propertyAt(context, source.key);
    if (nestedContext !== undefined) return nestedContext;
    const nestedLiteral = propertyAt(literals, source.key);
    if (nestedLiteral !== undefined) return nestedLiteral;
    return undefined;
  }
  if (source.kind === 'resource') return propertyAt(resources[source.key], source.property);
  return source.template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    const value = propertyAt(context, key) ?? propertyAt(literals, key) ?? propertyAt(resources, key);
    return value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  });
}
