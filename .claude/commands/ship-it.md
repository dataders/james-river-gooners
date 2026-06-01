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

7. **Subscribe and monitor CI** — call `mcp__github__subscribe_pr_activity` for the new PR, then immediately start a Monitor to actively poll CI results (do not rely on webhooks alone). Use this script (note: `gh pr checks` on this version does NOT support `--json`):

   ```bash
   PR=<number>
   while true; do
     out=$(gh pr checks $PR --repo dataders/james-river-gooners 2>/dev/null) || { sleep 15; continue; }
     if ! echo "$out" | grep -q "pending"; then
       echo "$out" | awk '{print $1 ": " $2}'
       echo "Done"
       break
     fi
     sleep 30
   done
   ```

   Then actively respond to every `<github-webhook-activity>` event that arrives:
   - CI failure → diagnose, fix, push, re-check; do not stop until all checks are green
   - Review comment → address it or ask the user if ambiguous
   - Do NOT just say "I'm watching" and go silent — each event requires a visible response and action

If any step fails, stop, explain what failed, and wait for the user to decide how to proceed. Do not skip or bypass any step.
