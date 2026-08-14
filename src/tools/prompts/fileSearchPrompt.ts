export function globPrompt(_options?: unknown): string {
  return `## Glob
- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like \`**/*.js\` or \`src/**/*.ts\`
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead
- Prefer Glob over Bash \`find\` / \`ls\` / \`dir\` / \`Get-ChildItem\` for filename searches
- NEVER invoke find or ls as a Bash command when Glob can list the same files`;
}

export function grepPrompt(_options?: unknown): string {
  return `## Grep
- A file-content search tool using JavaScript regular expression syntax
- ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command
- Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+")
- Filter files with glob parameter (e.g. "*.js", "**/*.tsx") or type parameter (e.g. "js", "py", "rust")
- Output modes: "content" shows matching lines, "files_with_matches" shows file paths (default), "count" shows match counts
- Use Agent tool for open-ended searches requiring multiple rounds
- Pattern syntax: JavaScript RegExp syntax
- Multiline matching: By default patterns match within single lines only. For cross-line patterns use \`multiline: true\`
- Prefer Grep over Bash \`grep\`, \`rg\`, or \`findstr\` even for one-off searches
- If you are searching for a keyword or file and are not confident that you will find the right match in the first few tries, keep searching with different patterns`;
}

/** @deprecated Use globPrompt / grepPrompt. Kept for callers that still import the shared blob. */
export function fileSearchPrompt(_options?: unknown): string {
  return `${globPrompt()}\n\n${grepPrompt()}`;
}
