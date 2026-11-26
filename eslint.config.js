import tseslint from 'typescript-eslint'

export default tseslint.config(
  // .agents/skills/*/scripts are the org's shared workflow skill scripts (AGENTS.md
  // names the tag), not qare code: skills.yml parse-checks them instead.
  { ignores: ['**/dist/**', '**/coverage/**', '.agents/skills/*/scripts/**'] },
  tseslint.configs.recommended,
)
