import type { ComposeScene } from './composeScene.js';

export interface ComposeTemplate {
  id: string;
  name: string;
  description: string;
  scene: ComposeScene;
}

const templates: ComposeTemplate[] = [
  {
    id: 'cover',
    name: 'Cover',
    description: 'Title slide with a statement and rule.',
    scene: {
      title: 'Cover',
      pages: [{
        name: 'Cover',
        layout: 'stack',
        padding: 80,
        gap: 28,
        blocks: [
          { type: 'heading', level: 1, text: 'A clear, confident title' },
          { type: 'paragraph', text: 'Add a short subtitle or the one sentence that explains this deck.', fontSize: 20 },
          { type: 'divider' },
          { type: 'caption', text: 'Presented by · Team / date' },
        ],
      }],
    },
  },
  {
    id: 'section',
    name: 'Section',
    description: 'Section divider with a short framing paragraph.',
    scene: {
      title: 'Section',
      pages: [{
        name: 'Section',
        layout: 'stack',
        padding: 88,
        gap: 26,
        blocks: [
          { type: 'heading', level: 1, text: 'Part two' },
          { type: 'divider' },
          { type: 'paragraph', text: 'Use this page to reset attention before the next idea.' },
        ],
      }],
    },
  },
  {
    id: 'two-column',
    name: 'Two columns',
    description: 'A heading plus left/right content blocks.',
    scene: {
      title: 'Two columns',
      pages: [{
        name: 'Two columns',
        layout: 'grid',
        columns: 2,
        padding: 64,
        gap: 28,
        blocks: [
          { type: 'heading', level: 2, text: 'Compare two ideas', span: 2 },
          { type: 'markdown', markdown: '### Left\n\n- First point\n- Second point' },
          { type: 'markdown', markdown: '### Right\n\n- First point\n- Second point' },
        ],
      }],
    },
  },
  {
    id: 'quote',
    name: 'Quote',
    description: 'A large pull quote with attribution.',
    scene: {
      title: 'Quote',
      pages: [{
        name: 'Quote',
        layout: 'stack',
        padding: 100,
        gap: 32,
        blocks: [
          { type: 'text', text: '“The best way to predict the future is to invent it.”', fontSize: 34, fontWeight: 600, color: '#1f2430' },
          { type: 'caption', text: '— Alan Kay', align: 'right' },
        ],
      }],
    },
  },
  {
    id: 'agenda',
    name: 'Agenda',
    description: 'A simple agenda with an ordered list.',
    scene: {
      title: 'Agenda',
      pages: [{
        name: 'Agenda',
        layout: 'stack',
        padding: 72,
        gap: 26,
        blocks: [
          { type: 'heading', level: 2, text: 'Agenda' },
          { type: 'divider' },
          { type: 'markdown', markdown: '1. Context\n2. What we learned\n3. The proposal\n4. Next steps' },
        ],
      }],
    },
  },
];

export function listComposeTemplates(): Array<Pick<ComposeTemplate, 'id' | 'name' | 'description'>> {
  return templates.map(({ id, name, description }) => ({ id, name, description }));
}

export function getComposeTemplate(id: string): ComposeTemplate | null {
  return templates.find(template => template.id === id) || null;
}
