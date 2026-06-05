Run the full quality gate, then commit, push, and open a PR for the current branch.

## Steps

1. **Lint** — run `npm run lint`. Fix any errors before continuing. Do not proceed with lint failures.

2. **Unit tests** — run `npm run test:unit`. Fix any failures before continuing.

3. **Build** — run `npm run build`. Fix any build errors before continuing.

4. **Commit** — stage and commit all uncommitted changes with a clear, descriptive message summarising *why* the changes were made (not just what).

5. **Push** — push the current branch to origin with `-u`.

6. **Open PR** — create a pull request against `main` with:
   - A short title (under 70 chars)
   - A body that lists what changed and includes a test plan checklist

7. **Enable auto-merge** — call `mcp__github__enable_pr_auto_merge` (owner: `dataders`, repo: `james-river-gooners`, mergeMethod: `SQUASH`) for the new PR. This lets GitHub merge the branch automatically once all required checks pass, so no manual merge step is needed.

8. **Subscribe and watch for failures** — call `mcp__github__subscribe_pr_activity` for the new PR. You do not need to poll CI continuously — auto-merge handles the merge. However, actively respond to every `<github-webhook-activity>` event that arrives:
   - CI failure → diagnose, fix, push; auto-merge will re-trigger once checks go green
   - Review comment → address it or ask the user if ambiguous
   - Do NOT just say "I'm watching" and go silent — each event requires a visible response and action

If any step fails, stop, explain what failed, and wait for the user to decide how to proceed. Do not skip or bypass any step.
