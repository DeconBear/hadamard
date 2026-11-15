export const SCENE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Hcanvas Compose Scene',
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Document title when composing a new document.' },
    width: { type: 'number', minimum: 100 },
    height: { type: 'number', minimum: 100 },
    background: { type: 'string' },
    pages: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          mode: { enum: ['canvas', 'infinite', 'html'] },
          width: { type: 'number', minimum: 100 },
          height: { type: 'number', minimum: 100 },
          background: { type: 'string' },
          layout: { enum: ['stack', 'grid', 'free'] },
          padding: { type: 'number', minimum: 0 },
          gap: { type: 'number', minimum: 0 },
          columns: { type: 'number', minimum: 1, maximum: 12 },
          autoHeight: { type: 'boolean' },
          html: { type: 'string', description: 'HTML page source when mode=html.' },
          markdown: { type: 'string', description: 'Markdown document source when mode=html.' },
          notes: { type: 'string' },
          blocks: { type: 'array', items: { $ref: '#/$defs/block' } },
        },
      },
    },
  },
  required: ['pages'],
  $defs: {
    block: {
      type: 'object',
      required: ['type'],
      properties: {
        type: { enum: ['heading', 'text', 'paragraph', 'caption', 'markdown', 'code', 'math', 'formula', 'image', 'shape', 'html', 'spacer', 'divider', 'arrow'] },
        id: { type: 'string' },
        name: { type: 'string' },
        text: { type: 'string' },
        markdown: { type: 'string' },
        code: { type: 'string' },
        language: { type: 'string' },
        tex: { type: 'string' },
        src: { type: 'string' },
        alt: { type: 'string' },
        shape: { type: 'string' },
        html: { type: 'string' },
        level: { type: 'number', minimum: 1, maximum: 6 },
        fontSize: { type: 'number', minimum: 6 },
        fontWeight: { type: 'number' },
        color: { type: 'string' },
        fill: { type: 'string' },
        stroke: { type: 'string' },
        align: { enum: ['left', 'center', 'right'] },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number', minimum: 1 },
        h: { type: 'number', minimum: 1 },
        span: { type: 'number', minimum: 1 },
        autoFit: { type: 'boolean' },
        srcFile: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        route: { enum: ['straight', 'orthogonal'] },
        style: { type: 'object', additionalProperties: true },
      },
    },
  },
} as const;

export const SCENE_EXAMPLE = {
  title: 'Maxwell 方程',
  width: 1280,
  height: 720,
  background: '#ffffff',
  pages: [
    {
      name: '封面',
      layout: 'stack',
      padding: 64,
      gap: 24,
      blocks: [
        { type: 'heading', level: 1, text: '经典 Maxwell 方程组' },
        { type: 'paragraph', text: '电磁学的四条基本方程。' },
        { type: 'divider' },
        { type: 'markdown', markdown: '## 四条方程\n\n- 电的高斯定律\n- 磁的高斯定律\n- 法拉第定律\n- 安培–麦克斯韦定律' },
      ],
    },
  ],
} as const;

export const LAYOUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Hcanvas Layout Read',
  type: 'object',
  properties: {
    ok: { const: true },
    format: { const: 'layout' },
    docId: { type: 'string' },
    revision: { type: 'number' },
    limit: { type: 'number' },
    page: { type: 'object' },
    pages: { type: 'array' },
    issues: { type: 'array' },
  },
} as const;

export const OPS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Hcanvas Operations',
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'object', required: ['op', 'page'], properties: { op: { const: 'add_page' }, page: { type: 'object' }, index: { type: 'number' } } },
          { type: 'object', required: ['op', 'pageId', 'patch'], properties: { op: { const: 'update_page' }, pageId: { type: 'string' }, patch: { type: 'object' } } },
          { type: 'object', required: ['op', 'pageId'], properties: { op: { const: 'delete_page' }, pageId: { type: 'string' } } },
          { type: 'object', required: ['op', 'pageId', 'block'], properties: { op: { const: 'add_block' }, pageId: { type: 'string' }, block: { type: 'object' }, index: { type: 'number' } } },
          { type: 'object', required: ['op', 'pageId', 'blockId', 'patch'], properties: { op: { const: 'update_block' }, pageId: { type: 'string' }, blockId: { type: 'string' }, patch: { type: 'object' } } },
          { type: 'object', required: ['op', 'pageId', 'blockId'], properties: { op: { const: 'delete_block' }, pageId: { type: 'string' }, blockId: { type: 'string' } } },
          { type: 'object', required: ['op', 'pageId', 'patches'], properties: { op: { const: 'html_patch' }, pageId: { type: 'string' }, blockId: { type: 'string' }, patches: { type: 'array' } } },
          { type: 'object', required: ['op', 'pageId', 'html'], properties: { op: { const: 'set_page_html' }, pageId: { type: 'string' }, html: { type: 'string' } } },
          { type: 'object', required: ['op', 'pageId', 'markdown'], properties: { op: { const: 'set_page_markdown' }, pageId: { type: 'string' }, markdown: { type: 'string' } } },
          { type: 'object', required: ['op', 'pageId', 'blockId', 'html'], properties: { op: { const: 'set_block_html' }, pageId: { type: 'string' }, blockId: { type: 'string' }, html: { type: 'string' } } },
          { type: 'object', required: ['op', 'pageId', 'blockId', 'text'], properties: { op: { const: 'set_block_text' }, pageId: { type: 'string' }, blockId: { type: 'string' }, text: { type: 'string' } } },
          { type: 'object', required: ['op', 'pageId', 'blockId', 'markdown'], properties: { op: { const: 'set_block_markdown' }, pageId: { type: 'string' }, blockId: { type: 'string' }, markdown: { type: 'string' } } },
          { type: 'object', required: ['op', 'pageId', 'blockId', 'code'], properties: { op: { const: 'set_block_code' }, pageId: { type: 'string' }, blockId: { type: 'string' }, code: { type: 'string' }, language: { type: 'string' } } },
          { type: 'object', required: ['op', 'pageId', 'blockId', 'direction'], properties: { op: { const: 'reorder_block' }, pageId: { type: 'string' }, blockId: { type: 'string' }, direction: { enum: ['up', 'down'] } } },
          { type: 'object', required: ['op', 'pageId', 'direction'], properties: { op: { const: 'reorder_page' }, pageId: { type: 'string' }, direction: { enum: ['up', 'down'] } } },
        ],
      },
    },
  },
  required: ['ops'],
} as const;

export const AGENT_SCHEMAS = {
  scene: SCENE_SCHEMA,
  ops: OPS_SCHEMA,
  layout: LAYOUT_SCHEMA,
} as const;

export type AgentSchemaName = keyof typeof AGENT_SCHEMAS;
