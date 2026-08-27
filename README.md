# c

Pick a Claude Code account and launch it, showing each account's 5-hour and
weekly usage, each with the time until its own reset. One command in place of
a drawer full of `CLAUDE_CONFIG_DIR=... claude` aliases.

[![npm](https://img.shields.io/npm/v/@tonoid/c?logo=npm)](https://www.npmjs.com/package/@tonoid/c)
[![License MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Test](https://github.com/tonoid/c/actions/workflows/test.yml/badge.svg)](https://github.com/tonoid/c/actions/workflows/test.yml)

**Who it's for**: anyone running Claude Code across more than one account,
personal and work, or a couple of Max subscriptions, who is tired of guessing
which one still has quota left before starting a session.

> ⚠️ **Disclaimer**: the code in this project was generated with
> [Claude Code](https://claude.com/claude-code) (Anthropic), then **tested and
> reviewed manually** by a human. It is provided as is, without warranty. It
> reads the OAuth tokens Claude Code already wrote into your config
> directories, so before running it: read the code (one ~300-line file) and
> check for yourself that no credential leaves the machine except as the
> `authorization` header on the usage call. It is short on purpose, precisely
> so that reading it stays practical. Issues and PRs welcome.

```
$ c

   account   plan       5h  resets   week  resets
→1 personal  max 20x   26%  2h 27m     3%  4d 6h
 2 work      max 5x    71%  41m       44%  2d 11h
 3 team      pro        4%  3h 12m     1%  6d 0h

  yolo on · worktree off  ·  [enter] personal   ↑↓ move   1-3 pick   y yolo   w worktree   r refresh   q quit
```

## Install

```bash
npm install -g @tonoid/c
```

Or run it without installing: `npx @tonoid/c`. Node 18 or newer, no
dependencies. Linux and macOS.

npm is the only distribution channel: no Homebrew tap, no apt repo, no
install script. It is one file, so a checkout on your `PATH` works just as
well (see [Development](#development)).

`c`, not `cc`, because `cc` is the C compiler. A real command on `PATH` rather
than a shell alias, so it works from scripts and from any shell, not just an
interactive one. If the single letter collides with something of yours, rename
the installed binary and set `CMD` at the top of `c.mjs` to match: every
message reads from it.

## Commands

| Command | Description |
|---|---|
| `c` | Usage table, pick an account. Enter takes the top row, which is the one used last. |
| `c <args...>` | Skip the menu: last-used account, everything passed through to `claude`. `c --resume`, `c --worktree`, `c "fix the failing test"`. |
| `c -a <id> [args...]` | A specific account, by id or display name. |
| `c status` | Table only. Also `c ls`. |
| `c add <id>` | Create `~/.claude-<id>` and log in to it. |
| `c remove <id>` | Delete `~/.claude-<id>` and the keychain item it owns. Asks first; `--yes` skips the question. Also `c rm`. |
| `c yolo [on\|off]` | Toggle the `--dangerously-skip-permissions` default. On. |
| `c worktree [on\|off]` | Toggle the `--worktree` default, a git worktree per session. Off. |
| `c version`, `c help` | |

In the menu: ↑↓ move the arrow (wrapping at both ends), enter launches the
marked account, 1-9 pick a row outright, `y` toggles yolo, `w` toggles
worktree, `r` refetches usage, `q` quits. Every key redraws the block in
place instead of printing another copy of it.

Both defaults are remembered, and both are skipped when you type the flag
yourself, so `c --worktree` with the default already on still passes it once.

## How it works

Every `~/.claude*` directory a login left behind is an account, so there is
nothing to register. `c add work`, or any manual `CLAUDE_CONFIG_DIR` login,
just shows up. A directory counts when it holds a `.credentials.json`, or the
profile of whoever logged in, or a matching keychain item on macOS. Plugin
caches such as `~/.claude-mem` hold none of those and are ignored.

On macOS the token is in the login keychain instead of `.credentials.json`, so
`c` reads it with `security find-generic-password`. The first read pops the
standard keychain dialog; Always Allow makes it the last one. Items are matched
to config dirs by name, and Claude Code names them for the dir rather than the
account: `Claude Code-credentials` is the default `~/.claude`, and every other
`CLAUDE_CONFIG_DIR` gets the first 8 hex of `sha256(dir)` appended. An item
named some other way is still matched on the id in `~/.claude-<id>`, and only
an account matching neither lists with `no token` instead of usage.

Rows sort most-recently-used first, so `c` then enter is always the account you
were just in.

Usage comes from `GET https://api.anthropic.com/api/oauth/usage`, authenticated
with the OAuth token Claude Code already wrote into each config directory. Same
data as `/usage` inside a session. It is an undocumented endpoint: if Anthropic
changes it, the usage columns show an error and picking and launching still
work.

Launching sets `CLAUDE_CONFIG_DIR` for the child process only, so two terminals
can run two accounts at once.

Removing is the mirror of `c add`, and the only thing here that destroys
anything, so it is deliberately narrow:

- It asks before it deletes, and refuses outright when stdin is not a terminal
  unless you pass `--yes`. A piped `c remove work` deletes nothing.
- It will not delete `~/.claude`. That directory holds your settings, projects
  and history, not just a login; log out from inside `claude` instead.
- It deletes a keychain item only when the name says that item belongs to this
  directory. Reading a token tolerates a guess, because the worst case is a
  misreported percentage. Deleting does not: the guess could belong to another
  account, and logging that one out is not undoable.

## State

`~/.config/c/db.json`: `order` (most-recently-used ids), the `yolo` and
`worktree` flag defaults, and cached `usage`. Refetched when older than 60s, or
on `r`. Delete the file to reset. Nothing else is written, and no credential
ever leaves the machine except as the `authorization` header on the usage call.

Another remembered claude flag is one line: add it to `FLAGS` in `c.mjs` and it
gets a `c <name> [on|off]` subcommand and a db field for free.

## Limitations

- Subcommand names shadow prompts. `c status` prints the table; to send that
  word as a prompt use `c -a main status`.
- On macOS, whether two accounts can coexist depends on Claude Code giving each
  `CLAUDE_CONFIG_DIR` its own keychain item. Versions that hash the dir into the
  item name do; one that reuses a single item would have `c add` overwrite the
  login you already had rather than add to it.
- The menu assumes its footer fits on one terminal line; a very narrow window
  can leave a stale line behind on redraw.

## Development

```bash
git clone https://github.com/tonoid/c
cd c
npm test
```

The suite is `node:test` and `node:assert` only. It builds throwaway `HOME`
directories with fake config dirs, so it never reads or writes real accounts
and never calls the network.

To run the checkout as the real command, so `git pull` updates it:

```bash
ln -s "$PWD/c.mjs" ~/.local/bin/c
```

## Releasing

Versions come from the commit messages, so land work on `main` with
[conventional commits](https://www.conventionalcommits.org):

| Prefix | Effect |
|---|---|
| `fix: ...` | patch, 1.0.0 to 1.0.1 |
| `feat: ...` | minor, 1.0.0 to 1.1.0 |
| `feat!: ...` or a `BREAKING CHANGE:` footer | major, 1.0.0 to 2.0.0 |
| `docs:`, `chore:`, `test:`, `refactor:` | no release |

The `release` workflow runs release-please on every push to `main`. It keeps a
single release PR open ("chore(main): release X.Y.Z") holding the version bump
in `package.json` and the new `CHANGELOG.md` section. Nothing publishes while
that PR sits there. Merging it tags `vX.Y.Z`, cuts the GitHub release, and
triggers the publish job, which runs the suite and then `npm publish` with the
`NPM_TOKEN` repository secret.

`release-please-config.json` and `.release-please-manifest.json` hold the
release type and the current version. The manifest is the source of truth for
what ships next, so let release-please edit it rather than bumping
`package.json` by hand.

Published releases carry npm [provenance](https://docs.npmjs.com/generating-provenance-statements),
which links the tarball to the workflow run that built it. That needs the
`id-token: write` permission the publish job already declares, and a public
repository.

## Contributing

Issues and pull requests are welcome:
[github.com/tonoid/c/issues](https://github.com/tonoid/c/issues).

Another remembered claude flag is one line: add it to `FLAGS` in `c.mjs`. Land
work with [conventional commits](https://www.conventionalcommits.org) so the
release notes write themselves, and run `npm test` before opening the pull
request.

## Credits

**Created and maintained by [tonoid](https://www.tonoid.com)** - A microstartup
studio building services like [2sync.com](https://2sync.com) or
[refurb.me](https://www.refurb.me).

| | |
|---|---|
| 💼 All tonoïd projects | [tonoid.com/projects](https://www.tonoid.com/projects) |
| 📬 Contact | hello@tonoid.com |
| 🐙 GitHub | [github.com/tonoid](https://github.com/tonoid) |

## License

[MIT](./LICENSE) © [tonoid.com](https://tonoid.com).

---

**GitHub topics**: `claude` `claude-code` `cli` `accounts` `account-switcher` `usage` `quota` `anthropic` `developer-tools` `nodejs`
