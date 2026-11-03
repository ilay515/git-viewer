<img src="assets/icon.svg" width="64" height="64" alt="GitBranch Lens Icon">

# GitBranch Lens

A client-only single-page web app for inspecting Git branches with **smart commit collapsing**. 

Standard Git graph viewers bury branch relationships under hundreds of linear commits. GitBranch Lens reduces visual clutter by keeping linear intermediate commits collapsed, highlighting only the **branch tips (HEADs)** and **anchors near branch diversions** (fork points / common ancestors, first commits on diverged branches, and merge commits).

By default, it focuses on comparing `main` and `dev`.

---

## Features

- **Client-Only Architecture**: Zero server requirements. Runs directly from `index.html` in any modern web browser or can be served via static file servers (`npm run dev`, `npx serve .`).
- **Focus on Diversions**:
  - Automatically identifies branch heads (`HEAD(main)`, `HEAD(dev)`).
  - Pinpoints common ancestors (merge base / fork point) where branches split.
  - Highlights initial diversion commits (first commit on a branch after branching off).
  - Automatically collapses intermediate linear commits into expandable summary badges (`··· 32 commits collapsed ···`).
- **Personal Access Token (PAT) Support**:
  - Direct integration with GitHub's REST API.
  - Stored strictly client-side (`sessionStorage` / optional `localStorage`).
  - Real-time API rate limit tracker (`4,980 / 5,000 req/hr`).
- **Interactive Offline Demo Mode**:
  - Includes built-in simulated Git graph data with `main`, `dev`, `feature/tokens`, and `v3-legacy` branches.
  - Allows immediate testing and exploration without requiring any GitHub token or network connection.
- **Dynamic Branch Multi-Select**:
  - Defaults to `main` and `dev` (or `master` and `develop`).
  - Searchable branch picker modal allows adding any arbitrary remote branch to the view.
- **Slide-Over Commit Inspector**:
  - Click any commit card or dot to view full commit message, author info, SHA copy button, parent commit navigation, and GitHub link.
- **Apple Fluid Design System**:
  - Frosted glassmorphism header (`backdrop-filter: blur(20px)`).
  - Smooth SVG Bézier curves connecting commits across branch tracks.
  - Spring-feel interactive feedback on buttons, cards, and modal dialogs.

---

## Getting Started

### 1. Direct Browser Usage (Zero Install)
Simply open `index.html` in your favorite web browser:
```bash
# Linux
xdg-open index.html

# macOS
open index.html
```

### 2. Local Dev Server (Optional)
```bash
# Start with Vite or any static server
npm run dev
# or
npx serve .
```

---

## Security & Privacy

- All GitHub API calls are made directly from the user's browser to `https://api.github.com`.
- No backend proxies, analytics, or third-party servers receive your PAT or repository code.
