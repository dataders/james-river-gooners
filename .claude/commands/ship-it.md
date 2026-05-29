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

If any step fails, stop, explain what failed, and wait for the user to decide how to proceed. Do not skip or bypass any step.
