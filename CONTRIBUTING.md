# Contributing

Thanks for helping. By sending a pull request you agree that your contribution is licensed under the project's [GPL-3.0](LICENSE). Brand files (name, logo, mascot) follow [TRADEMARKS.md](TRADEMARKS.md) — please don't change them in PRs unless asked.

A few rules keep the project healthy:

1. **No DRM circumvention.** PRs that decrypt or bypass protected streams will be closed.
2. **Strings:** add every user-facing string to `scripts/strings.mjs` in both Arabic and English, then run `node scripts/gen-locales.mjs`. Helper messages use `tr(ar, en)` in `helper/lang.go`.
3. **RTL first:** the UI is designed right-to-left. Use logical CSS properties (`margin-inline-start`, `inset-inline-end`) and wrap mixed-direction values (sizes, filenames, URLs) in `<bdi>`.
4. **Theme tokens:** use the CSS variables in `extension/ui/theme.css` — never hard-coded colors. They mirror the Figma "Hudhud / Theme" variables.
5. **Tests:** `tests/run-all.sh` must pass. If you touch downloading, converting or the helper, also run `tests/run-all.sh --full` locally (see `docs/TESTING.md`).
6. **Go:** `gofmt` and `go vet` for linux, windows and darwin.

Commit messages: short imperative subject line, details in the body if needed.
