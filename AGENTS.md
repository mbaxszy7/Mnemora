# Repository Guidelines

## Project Structure & Module Organization

- `src/` holds the React + Vite renderer (components, pages, hooks, router, i18n, assets).
- `electron/` contains the Electron main process, preload, IPC, and services (entry: `main.ts`, `preload.ts`).
- `shared/` is cross-process types and utilities; many tests live here.
- `public/` is static assets served by Vite.
- `externals/` contains native/Python tooling like the window inspector build.
- `docs/`, `scripts/` store design notes and helper scripts.
- `dist/`, `dist-electron/`, `release/` are build outputs.

## Build, Test, and Development Commands

- `pnpm dev`: build the window inspector, then start the Vite dev server.
- `pnpm dev:rebuild`: rebuild native SQLite modules, then start Vite.
- `pnpm build`: full production build (window inspector, native rebuild, `tsc`, Vite build, electron-builder).
- `pnpm lint`: run ESLint across the repo.
- `pnpm format` / `pnpm format:check`: Prettier write/check for `src/` and `electron/`.
- `pnpm preview`: preview the Vite production build.
- `pnpm db:generate`, `pnpm db:studio`, `pnpm db:push`: Drizzle workflows (migrations run at app startup).
- `pnpm test`: run the test suite using Vitest config in `vitest.config.ts`.
- `pnpm test:coverage`: run tests with coverage report (outputs to `./coverage/`).

## Coding Style & Naming Conventions

- TypeScript + React with ESLint and Prettier.
- Formatting rules: 2-space indentation, semicolons, double quotes, print width 100.
- Test files use `*.test.*` or `*.spec.*` naming (see Vitest include pattern).

## Testing Guidelines

- Framework: Vitest (node environment), with Testing Library available for UI tests.
- Tests are colocated near source (for example `shared/*.test.ts`).
- Run a focused test: `pnpm vitest shared/ipc-types.test.ts`.

## Commit & Pull Request Guidelines

- Conventional Commits enforced by commitlint and Husky. Examples from history: `chore: ...`, `refactor: ...`.
- Use `type: summary` with optional scope (for example `feat(ui): add search bar`).
- PRs should include a clear summary, testing notes (commands run or not run), and screenshots or recordings for UI changes. Link related issues when applicable.
