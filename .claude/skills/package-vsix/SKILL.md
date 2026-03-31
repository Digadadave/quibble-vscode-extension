---
name: package-vsix
description: Compile and package this VS Code extension to a .vsix file
allowed-tools: Bash
---

Package the extension to a VSIX:

1. Run `npm run compile` — fix any TypeScript errors before proceeding (do not continue if compile fails)
2. Run `npm run package` — this calls `@vscode/vsce package`
3. Report the output VSIX filename and size from the command output

No git commit needed — packaging is not a code change.
