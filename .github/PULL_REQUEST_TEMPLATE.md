<!--
English or Russian — both are fine.
The repo history is written in short Russian one-line commit messages;
follow the existing style (see below).
-->

## What & why

<!-- What changes and why. Link the issue: Fixes #N -->

## How it was checked

<!-- Which probes / manual checks prove it works. CI runs them again. -->

- [ ] `npm run typecheck` and `npm run typecheck:gui` pass
- [ ] `npm run probe` passes (add the probe you relied on)
- [ ] UI strings: new user-facing strings are wrapped in `t()`/`tf()` and
      present in `src/locales/en.ts` and `src/locales/zh.ts`
- [ ] README ×3 updated if behavior/commands/settings changed
