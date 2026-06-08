# Backblaze exclusions

Version-controlled record of paths Backblaze Personal Backup should **not** back
up. The list itself is [`exclusions.txt`](./exclusions.txt).

## Why this isn't a symlink

Backblaze stores its exclusion rules as plain-text XML, but its background
service (`bzserv`, running as root/SYSTEM) **owns and rewrites those files in
place** — often by replacing the file rather than editing it. That breaks any
symlink pointing at it and leaves your repo copy silently stale. The files also
live in privileged, machine-global directories, not your home dir. So we keep
`exclusions.txt` as the source of truth and *apply* it to each machine rather
than symlinking.

## Where Backblaze keeps its real exclusion file

| OS      | Path |
| ------- | ---- |
| macOS   | `/Library/Backblaze.bzpkg/bzdata/bzexcluderules_editable.xml` |
| Windows | `C:\ProgramData\Backblaze\bzdata\bzexcluderules_editable.xml` |

`bzexcluderules_mandatory.xml` sits alongside it and is Backblaze-managed —
don't edit that one.

## Applying the exclusions

Easiest and safest: add each path from `exclusions.txt` via the Backblaze app
(**Settings → Exclusions → Add Exclusion**). Restart the Backblaze service (or
reboot) so it re-reads the rules.

## Current exclusions

- `~/.local/share/moonlander-keylog` — Moonlander keyboard keystroke log. Stays
  local; must never be backed up off-machine.
