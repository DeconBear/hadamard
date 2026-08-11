# Plugin bundle recipes

Recipes are inert, reviewable installation instructions. Hadamard never executes a recipe automatically.

The Qwen-MM core recipe is pinned to an exact upstream commit and starts disabled. After checking out that commit, run its `install.hadamard` command, then review and activate it explicitly:

```text
/plugin inspect qwen-mm-plugins-core
/plugin trust qwen-mm-plugins-core
/plugin enable qwen-mm-plugins-core
```

Trust is bound to the package tree integrity, version, and full capability set. The runtime loads only the declared Skill path and MCP configuration; it does not import a JavaScript entry from a Skill+MCP bundle.
