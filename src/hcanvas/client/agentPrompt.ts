export interface AgentPromptContext {
  workspace: string;
  docId: string;
  title?: string;
  revision: number;
  pageId?: string;
  pageName?: string;
  pageMode?: string;
}

export function buildAgentPrompt(context: AgentPromptContext): string {
  return [
    'You are working on an hcanvas document.',
    'Workspace: ' + context.workspace,
    'Document: ' + context.docId + (context.title ? ' "' + context.title + '"' : '') + ' (revision ' + context.revision + ')',
    context.pageName ? 'Current page: ' + (context.pageId || '') + ' "' + context.pageName + '"' + (context.pageMode ? ' (' + context.pageMode + ')' : '') : 'Current page: none',
    '',
    'Before making changes, run:',
    '  hcanvas context --json',
    '  hcanvas read ' + context.docId + ' --format outline',
    '',
    'Apply changes with:',
    '  hcanvas apply ' + context.docId + ' --ops-file ops.json --base-revision ' + context.revision,
    '',
    'Always read the latest revision first and never overwrite a newer revision. If you want human review, use hcanvas propose and ask the user to accept it in Proposals.',
    'Optional: create a live presence session with hcanvas sessions create ' + context.docId + ' --actor <your-agent-name>.',
  ].join('\n');
}
