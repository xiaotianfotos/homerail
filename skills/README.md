# HomeRail Agent Skills

This directory contains HomeRail Agent Skills for agents that understand
`SKILL.md` directories.

## Core Install Rule

Install these skills by linking each `skills/homerail-*` directory from this
source checkout into the agent's skill directory. Do not copy skill directories
for normal installs. A linked install keeps the active skills updated when the
HomeRail repository is pulled or switched to a newer commit.

Supported target directories:

- Codex: `${CODEX_HOME:-$HOME/.codex}/skills`
- Claude Code: `$HOME/.claude/skills`
- HomeRail Manager Agent: `${HOMERAIL_HOME:-$HOME/.homerail}/skills`

Manager automatically creates the HomeRail Manager Agent skill directory and
links missing built-in `homerail-*` skills from the active checkout. Existing
entries are never replaced, so a user-owned skill with the same directory id
overrides the built-in version. Every directory containing `SKILL.md` under
this root is exposed to all Manager Agent harnesses on the next turn.

## macOS / Linux

```bash
repo=/path/to/HomeRail

for root in "${CODEX_HOME:-$HOME/.codex}/skills" "$HOME/.claude/skills"; do
  mkdir -p "$root"

  for skill in "$repo"/skills/homerail-*; do
    [ -d "$skill" ] || continue
    name="$(basename "$skill")"
    [ "$name" = "homerail-dag-patterns" ] && continue  # legacy compatibility entry
    dst="$root/$name"

    if [ -L "$dst" ]; then
      rm "$dst"
    elif [ -e "$dst" ]; then
      echo "Refusing to replace existing non-symlink skill: $dst" >&2
      continue
    fi

    ln -s "$skill" "$dst"
  done
done
```

## Windows PowerShell

Run PowerShell with Developer Mode enabled, or as Administrator if directory
symlinks are blocked by Windows policy.

```powershell
$repo = "C:\path\to\HomeRail"
$roots = @(
  "$env:USERPROFILE\.codex\skills",
  "$env:USERPROFILE\.claude\skills"
)

foreach ($root in $roots) {
  New-Item -ItemType Directory -Force -Path $root | Out-Null

  Get-ChildItem (Join-Path $repo "skills") -Directory -Filter "homerail-*" | ForEach-Object {
    if ($_.Name -eq "homerail-dag-patterns") { return } # legacy compatibility entry
    $dst = Join-Path $root $_.Name

    if ((Test-Path $dst) -and ((Get-Item $dst).LinkType)) {
      Remove-Item $dst
    } elseif (Test-Path $dst) {
      Write-Warning "Refusing to replace existing non-link skill: $dst"
      $dst = $null
    }

    if ($dst) {
      New-Item -ItemType SymbolicLink -Path $dst -Target $_.FullName | Out-Null
    }
  }
}
```

If Windows cannot create directory symlinks, use a junction as the local
fallback. It still points at the checkout and updates with the repository:

```powershell
cmd /c mklink /J "%USERPROFILE%\.claude\skills\homerail-install-ops" "C:\path\to\HomeRail\skills\homerail-install-ops"
```

Repeat the junction command for each `homerail-*` skill that should be
available.

## After Installing

Restart or reload the agent host if it only discovers skills on startup.

Direct invocation examples:

- Codex: `$homerail-install-ops`
- Claude Code: `/homerail-install-ops`
- DAG design, execution and supervision in Codex: `$homerail-dag-ops`
- DAG design, execution and inspection in Claude Code: `/homerail-dag-ops`

For DAG work, install only `homerail-dag-ops`; its references and scripts contain
pattern design, event listening, decisions, and verification. The old
`homerail-dag-patterns` name is a compatibility entry for existing integrations,
not another skill required by the unified workflow. The separate
`homerail-dag-supervision` skill has been merged into `homerail-dag-ops`.

When upgrading, link `homerail-dag-ops` first, then remove obsolete DAG skill
links only if they point into this checkout. Preserve user-owned directories or
custom links. Existing frozen observer runtimes and journals remain valid;
consume their callbacks through `homerail-dag-ops` without recreating DAG runs.

A link in `~/.codex/skills` is available across this user's project directories.
The source checkout must remain available. Other operating-system users or
isolated Codex homes need their own link.
