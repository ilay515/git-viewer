// GitBranch Lens: Client-Only Git Branch Divergence Viewer
// Pure client-side implementation with zero backend dependencies

(function () {
  'use strict';

  // --- STATE ---
  const state = {
    pat: sessionStorage.getItem('git_pat') || localStorage.getItem('git_pat') || '',
    repo: localStorage.getItem('git_repo') || 'herdrdev/herdr',
    branches: [],
    selectedBranches: ['master', 'main'],
    commitsMap: new Map(), // sha -> commit object
    displayRows: [],       // computed list of render items (commits or collapsed chains)
    expandedChains: new Set(), // set of chain IDs currently expanded
    selectedCommit: null,
    isDemo: false,
    loading: false,
    rateLimit: { remaining: null, limit: null },
    filterMode: 'smart',   // 'smart' (tips & diversions) | 'all'
    repoInfo: null,
  };

  // Branch Color Palette
  const PALETTE = [
    { color: '#6366f1', light: '#a5b4fc', bg: 'rgba(99, 102, 241, 0.15)' }, // Indigo (main/master)
    { color: '#10b981', light: '#6ee7b7', bg: 'rgba(16, 185, 129, 0.15)' }, // Emerald (dev/develop)
    { color: '#f59e0b', light: '#fde68a', bg: 'rgba(245, 158, 11, 0.15)' }, // Amber
    { color: '#06b6d4', light: '#67e8f9', bg: 'rgba(6, 182, 212, 0.15)' }, // Cyan
    { color: '#f43f5e', light: '#fecdd3', bg: 'rgba(244, 63, 94, 0.15)' }, // Rose
    { color: '#a855f7', light: '#e9d5ff', bg: 'rgba(168, 85, 247, 0.15)' }, // Purple
    { color: '#84cc16', light: '#d9f99d', bg: 'rgba(132, 204, 22, 0.15)' }, // Lime
    { color: '#ec4899', light: '#fbcfe8', bg: 'rgba(236, 72, 153, 0.15)' }, // Pink
  ];

  function getBranchColor(branchName, index = 0) {
    if (!branchName) return PALETTE[0];
    const lower = branchName.toLowerCase();
    if (lower === 'main' || lower === 'master') {
      return PALETTE[0]; // Always Indigo
    }
    if (lower === 'dev' || lower === 'develop') {
      return PALETTE[1]; // Always Emerald
    }
    const idx = Math.abs(hashCode(branchName)) % (PALETTE.length - 2) + 2;
    return PALETTE[idx];
  }

  function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  // --- DEMO FIXTURE GENERATOR ---
  function generateDemoData() {
    const now = Date.now();
    const hour = 3600 * 1000;
    const day = 24 * hour;

    // Common Ancestor (Fork Point: Commit 10 on main)
    const forkCommit = {
      sha: '056af4c8b21901a',
      shortSha: '056af4c',
      message: 'feat(core): commit 10 on main branch\n\nStable release milestone where develop diverged.',
      author: { name: 'Demo Developer', login: 'developer', avatar: 'https://avatars.githubusercontent.com/u/1000' },
      date: new Date(now - 10 * day).toISOString(),
      parents: ['3e1dedd9'],
      branch: 'main',
      stats: { additions: 140, deletions: 32 },
      isForkPoint: true,
      forkChildren: ['main', 'develop'],
    };

    // Commits on main after fork point (commits 11 to 19: 9 intermediate commits)
    const mainIntermediate = [];
    for (let i = 11; i <= 19; i++) {
      mainIntermediate.push({
        sha: `m${i}c01f83c9${i}`,
        shortSha: `m${i}c01f8`,
        message: `feat(core): commit ${i} on main branch`,
        author: { name: 'Demo Developer', login: 'developer', avatar: 'https://avatars.githubusercontent.com/u/1000' },
        date: new Date(now - (10 * day) + ((i - 10) * 8 * hour)).toISOString(),
        parents: [i === 11 ? forkCommit.sha : `m${i-1}c01f83c9${i-1}`],
        branch: 'main',
        stats: { additions: 15 + i, deletions: 4 },
      });
    }

    // Commit 20 on main (HEAD)
    const mainHead = {
      sha: 'b721c5e9a01f844',
      shortSha: 'b721c5e',
      message: 'feat(core): commit 20 on main branch\n\nLatest stable production deployment on main.',
      author: { name: 'Demo Developer', login: 'developer', avatar: 'https://avatars.githubusercontent.com/u/1000' },
      date: new Date(now - 1 * day).toISOString(),
      parents: [mainIntermediate[mainIntermediate.length - 1].sha],
      branch: 'main',
      stats: { additions: 24, deletions: 6 },
      isHead: true,
    };

    // Commits on main before fork point (commits 1 to 9: 9 base commits)
    const mainBase = [];
    for (let i = 1; i <= 9; i++) {
      mainBase.push({
        sha: `b${i}a60b2c1${i}`,
        shortSha: `b${i}a60b2`,
        message: `feat(core): commit ${i} on main branch`,
        author: { name: 'Demo Developer', login: 'developer', avatar: 'https://avatars.githubusercontent.com/u/1000' },
        date: new Date(now - (15 * day) + (i * 8 * hour)).toISOString(),
        parents: [i === 1 ? 'initial' : `b${i-1}a60b2c1${i-1}`],
        branch: 'main',
        stats: { additions: 20 + i, deletions: 2 },
      });
    }

    // 20 Additional commits on develop (Commit 1: Diversion start)
    const devDiversionStart = {
      sha: 'b9845ba023819e1',
      shortSha: 'b9845ba',
      message: 'feat(develop): additional commit 1 on develop branch\n\nFirst commit branched off main fork point.',
      author: { name: 'Demo Developer', login: 'developer', avatar: 'https://avatars.githubusercontent.com/u/1000' },
      date: new Date(now - 9 * day).toISOString(),
      parents: [forkCommit.sha],
      branch: 'develop',
      stats: { additions: 55, deletions: 12 },
      isDiversionStart: true,
    };

    // Additional commits 2 to 19 on develop (18 intermediate commits)
    const devIntermediate = [];
    let devForkForAuth = null;
    for (let i = 2; i <= 19; i++) {
      const isForkForAuth = (i === 10);
      const commitObj = {
        sha: `d${i}6c78f5e${i}`,
        shortSha: `d${i}6c78f`,
        message: isForkForAuth
          ? 'feat(develop): additional commit 10 on develop branch\n\nBranch point for feature/auth token subsystem.'
          : `feat(develop): additional commit ${i} on develop branch`,
        author: { name: 'Demo Developer', login: 'developer', avatar: 'https://avatars.githubusercontent.com/u/1000' },
        date: new Date(now - (9 * day) + ((i - 1) * 8 * hour)).toISOString(),
        parents: [i === 2 ? devDiversionStart.sha : `d${i-1}6c78f5e${i-1}`],
        branch: 'develop',
        stats: { additions: 30 + i, deletions: 5 },
        isForkPoint: isForkForAuth,
        forkChildren: isForkForAuth ? ['develop', 'feature/auth'] : undefined,
      };
      if (isForkForAuth) devForkForAuth = commitObj;
      devIntermediate.push(commitObj);
    }

    // Additional commit 20 on develop (HEAD)
    const devHead = {
      sha: '6c78f5e93d8101a',
      shortSha: '6c78f5e',
      message: 'feat(develop): additional commit 20 on develop branch\n\nLatest staging feature implementation on develop.',
      author: { name: 'Demo Developer', login: 'developer', avatar: 'https://avatars.githubusercontent.com/u/1000' },
      date: new Date(now - 2 * hour).toISOString(),
      parents: [devIntermediate[devIntermediate.length - 1].sha],
      branch: 'develop',
      stats: { additions: 110, deletions: 14 },
      isHead: true,
    };

    // 3rd Branch: feature/auth (8 commits branching off commit 10 on develop)
    const authDiversionStart = {
      sha: '4fa439e9a1102b1',
      shortSha: '4fa439e',
      message: 'feat(auth): implement token authentication step 1\n\nInitial diversion from develop for OAuth2 token validation.',
      author: { name: 'Demo Developer', login: 'developer', avatar: 'https://avatars.githubusercontent.com/u/1000' },
      date: new Date(now - 4 * day).toISOString(),
      parents: [devForkForAuth ? devForkForAuth.sha : forkCommit.sha],
      branch: 'feature/auth',
      stats: { additions: 75, deletions: 10 },
      isDiversionStart: true,
    };

    const authIntermediate = [];
    for (let i = 2; i <= 7; i++) {
      authIntermediate.push({
        sha: `a${i}4fa439e${i}`,
        shortSha: `a${i}4fa43`,
        message: `feat(auth): implement token authentication step ${i}`,
        author: { name: 'Demo Developer', login: 'developer', avatar: 'https://avatars.githubusercontent.com/u/1000' },
        date: new Date(now - (4 * day) + ((i - 1) * 6 * hour)).toISOString(),
        parents: [i === 2 ? authDiversionStart.sha : `a${i-1}4fa439e${i-1}`],
        branch: 'feature/auth',
        stats: { additions: 35 + i, deletions: 4 },
      });
    }

    const authHead = {
      sha: 'bb48b139384bc12',
      shortSha: 'bb48b13',
      message: 'feat(auth): implement token authentication step 8\n\nComplete OAuth2 session refresh integration.',
      author: { name: 'Demo Developer', login: 'developer', avatar: 'https://avatars.githubusercontent.com/u/1000' },
      date: new Date(now - 1 * hour).toISOString(),
      parents: [authIntermediate[authIntermediate.length - 1].sha],
      branch: 'feature/auth',
      stats: { additions: 92, deletions: 11 },
      isHead: true,
    };

    return {
      branches: [
        { name: 'main', commit: { sha: mainHead.sha } },
        { name: 'develop', commit: { sha: devHead.sha } },
        { name: 'feature/auth', commit: { sha: authHead.sha } },
      ],
      commits: [
        authHead,
        ...authIntermediate.reverse(),
        authDiversionStart,
        devHead,
        ...devIntermediate.reverse(),
        devDiversionStart,
        mainHead,
        ...mainIntermediate.reverse(),
        forkCommit,
        ...mainBase.reverse(),
      ],
    };
  }

  // --- GITHUB API CLIENT ---
  async function fetchGitHub(endpoint) {
    const url = endpoint.startsWith('https://') ? endpoint : `https://api.github.com${endpoint}`;
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
    };
    if (state.pat && state.pat.trim()) {
      headers['Authorization'] = `Bearer ${state.pat.trim()}`;
    }

    const resp = await fetch(url, { headers });

    // Capture rate limit
    const rem = resp.headers.get('x-ratelimit-remaining');
    const limit = resp.headers.get('x-ratelimit-limit');
    if (rem !== null) {
      state.rateLimit = { remaining: parseInt(rem, 10), limit: parseInt(limit, 10) };
      renderRateLimit();
    }

    if (!resp.ok) {
      let errMsg = `GitHub API error (${resp.status} ${resp.statusText})`;
      try {
        const errJson = await resp.json();
        if (errJson.message) {
          errMsg = errJson.message;
          if (resp.status === 403 && errMsg.includes('rate limit')) {
            errMsg += ' — Please enter a Personal Access Token (PAT) above to increase rate limits to 5,000 req/hr.';
          }
        }
      } catch (e) {}
      throw new Error(errMsg);
    }

    return await resp.json();
  }

  // Paginated Branch Fetcher (Fetches ALL branches, not just the first 100)
  async function fetchAllBranches(ownerRepo) {
    const allBranches = [];
    let page = 1;
    const maxPages = 10; // Up to 1,000 branches

    while (page <= maxPages) {
      renderStatus(`Fetching branches for ${ownerRepo} (page ${page})...`);
      const data = await fetchGitHub(`/repos/${ownerRepo}/branches?per_page=100&page=${page}`);
      if (!Array.isArray(data) || data.length === 0) break;
      allBranches.push(...data);
      if (data.length < 100) break;
      page++;
    }

    return allBranches;
  }

  // Resolve default branches: main, master, dev, develop
  function resolveDefaultBranches(repoInfo, branches) {
    const names = branches.map(b => b.name);
    const repoDefault = repoInfo?.default_branch;

    // 1. Primary branch candidate: repo default_branch, or master, or main
    const primaryCandidates = [repoDefault, 'master', 'main'].filter(Boolean);
    const primary = primaryCandidates.find(n => names.includes(n)) || names[0] || 'master';

    // 2. Secondary candidate: dev, develop, or alternate master/main
    const secondaryCandidates = ['dev', 'develop'];
    if (primary === 'master') {
      secondaryCandidates.push('main');
    } else if (primary === 'main') {
      secondaryCandidates.push('master');
    }

    let secondary = secondaryCandidates.find(n => names.includes(n) && n !== primary);

    // If still no secondary, pick the first other branch in the repo
    if (!secondary && names.length > 1) {
      secondary = names.find(n => n !== primary);
    }

    const selected = [primary];
    if (secondary) selected.push(secondary);
    return selected;
  }

  async function loadRepository(ownerRepo) {
    state.loading = true;
    renderStatus(`Fetching repository ${ownerRepo}...`);

    try {
      // 1. Fetch repo info (to get default_branch)
      let repoInfo = null;
      try {
        repoInfo = await fetchGitHub(`/repos/${ownerRepo}`);
        state.repoInfo = repoInfo;
      } catch (e) {
        console.warn('Could not fetch repo metadata directly:', e);
      }

      // 2. Fetch all branches with pagination
      const branchesData = await fetchAllBranches(ownerRepo);
      if (branchesData.length === 0) {
        throw new Error('No branches found in this repository.');
      }
      state.branches = branchesData;

      // 3. Resolve default branches (prioritizes master, main, dev, develop)
      state.selectedBranches = resolveDefaultBranches(repoInfo, branchesData);

      // 4. Fetch commits and branch divergence
      await fetchCommitsForBranches(ownerRepo, state.selectedBranches);

      state.isDemo = false;
      state.loading = false;
      renderStatus(`Loaded ${branchesData.length} branches from ${ownerRepo}. Comparing: ${state.selectedBranches.join(' vs ')}`);
      renderApp();
    } catch (err) {
      state.loading = false;
      console.error(err);
      alert(`Could not load repo: ${err.message}`);
      renderStatus(`Error: ${err.message}`);
      renderApp();
    }
  }

  async function fetchCommitsForBranches(ownerRepo, selectedBranchNames) {
    state.commitsMap.clear();

    if (selectedBranchNames.length === 2) {
      const [base, head] = selectedBranchNames;
      renderStatus(`Comparing ${base}...${head}...`);

      try {
        const compare = await fetchGitHub(`/repos/${ownerRepo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);

        // 1. Merge Base (Common Ancestor / Fork Point)
        const mergeBase = compare.merge_base_commit;
        if (mergeBase) {
          const mbObj = formatGitHubCommit(mergeBase, base);
          mbObj.isForkPoint = true;
          mbObj.forkChildren = [base, head];
          state.commitsMap.set(mbObj.sha, mbObj);
        }

        // 2. Commits on head branch
        if (compare.commits && compare.commits.length > 0) {
          compare.commits.forEach((c, idx) => {
            const commitObj = formatGitHubCommit(c, head);
            if (idx === 0) commitObj.isDiversionStart = true;
            if (idx === compare.commits.length - 1) commitObj.isHead = true;
            state.commitsMap.set(commitObj.sha, commitObj);
          });
        }

        // 3. Store behind_by count to synthesize collapsed stretch on base
        state.behindByCount = compare.behind_by || 0;
      } catch (e) {
        console.warn('Compare API failed or diverged too far, falling back to direct commit fetch:', e);
      }
    }

    // Always fetch recent commits for each selected branch to ensure HEAD and recent linear chain are present
    for (const bName of selectedBranchNames) {
      try {
        const list = await fetchGitHub(`/repos/${ownerRepo}/commits?sha=${encodeURIComponent(bName)}&per_page=15`);
        list.forEach((c, idx) => {
          if (!state.commitsMap.has(c.sha)) {
            const commitObj = formatGitHubCommit(c, bName);
            if (idx === 0) commitObj.isHead = true;
            state.commitsMap.set(commitObj.sha, commitObj);
          } else {
            const existing = state.commitsMap.get(c.sha);
            if (idx === 0) existing.isHead = true;
          }
        });
      } catch (e) {
        console.error(`Error loading commits for branch ${bName}:`, e);
      }
    }
  }

  function formatGitHubCommit(c, branch) {
    return {
      sha: c.sha,
      shortSha: c.sha.substring(0, 7),
      message: c.commit.message,
      author: {
        name: c.commit.author?.name || c.author?.login || 'Developer',
        login: c.author?.login || 'unknown',
        avatar: c.author?.avatar_url || 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
      },
      date: c.commit.author?.date || new Date().toISOString(),
      parents: (c.parents || []).map(p => p.sha),
      branch: branch,
      stats: c.stats || { additions: 0, deletions: 0 },
      isHead: false,
      isForkPoint: false,
      isDiversionStart: false,
    };
  }

  // --- DIVERSION & MULTI-COLUMN BRANCH ENGINE ---
  function computeBranchDisplayRows(branchName) {
    const allCommits = Array.from(state.commitsMap.values());
    const bCommits = allCommits.filter(c => c.branch === branchName);
    bCommits.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (bCommits.length === 0) return [];

    bCommits.forEach((c, idx) => {
      if (idx === 0) c.isHead = true;
      if (c.parents && c.parents.length > 1) c.isMerge = true;
      c.isAnchor = Boolean(c.isHead || c.isForkPoint || c.isDiversionStart || c.isMerge);
    });

    if (state.filterMode === 'all') {
      return bCommits.map(c => ({ type: 'commit', commit: c, branch: branchName }));
    }

    const rows = [];
    let chain = [];

    function flushChain() {
      if (chain.length === 0) return;
      if (chain.length <= 1) {
        chain.forEach(c => rows.push({ type: 'commit', commit: c, branch: branchName }));
      } else {
        const chainId = `chain-${branchName}-${chain[0].sha}-${chain[chain.length - 1].sha}`;
        const isExpanded = state.expandedChains.has(chainId);
        let totalAdd = 0;
        let totalDel = 0;
        const authors = new Set();
        chain.forEach(c => {
          if (c.stats) {
            totalAdd += c.stats.additions || 0;
            totalDel += c.stats.deletions || 0;
          }
          if (c.author?.name) authors.add(c.author.name);
        });
        rows.push({
          type: 'collapsed',
          chainId,
          commits: [...chain],
          count: chain.length,
          branch: branchName,
          startSha: chain[0].shortSha,
          endSha: chain[chain.length - 1].shortSha,
          totalAdd,
          totalDel,
          authorsCount: authors.size,
          isExpanded,
        });
      }
      chain = [];
    }

    bCommits.forEach(c => {
      if (c.isAnchor) {
        flushChain();
        rows.push({ type: 'commit', commit: c, branch: branchName });
      } else {
        chain.push(c);
      }
    });
    flushChain();

    return rows;
  }

  function findBranchOrigin(branchName) {
    const allCommits = Array.from(state.commitsMap.values());
    const bCommits = allCommits
      .filter(c => c.branch === branchName)
      .sort((a, b) => new Date(a.date) - new Date(b.date)); // oldest first

    if (bCommits.length === 0) return null;
    const oldest = bCommits[0];

    if (oldest.parents && oldest.parents.length > 0) {
      for (const pSha of oldest.parents) {
        const parentCommit = state.commitsMap.get(pSha);
        if (parentCommit && parentCommit.branch !== branchName) {
          return {
            commit: parentCommit,
            parentBranch: parentCommit.branch,
          };
        }
      }
    }

    if (oldest.isDiversionStart) {
      const forkCommit = allCommits.find(c => c.isForkPoint && c.branch !== branchName);
      if (forkCommit) {
        return {
          commit: forkCommit,
          parentBranch: forkCommit.branch || state.selectedBranches[0],
        };
      }
    }

    return null;
  }

  // --- RENDER FUNCTIONS ---
  function renderApp() {
    renderHeader();
    renderSubToolbar();
    renderGraph();
    renderInspector();
  }

  function renderHeader() {
    const repoInput = document.getElementById('repo-input');
    const patInput = document.getElementById('pat-input');
    if (repoInput && document.activeElement !== repoInput) repoInput.value = state.repo;
    if (patInput && document.activeElement !== patInput) patInput.value = state.pat;
  }

  function renderRateLimit() {
    const pill = document.getElementById('rate-limit-pill');
    if (!pill) return;
    if (state.rateLimit.remaining !== null) {
      pill.style.display = 'inline-flex';
      pill.innerHTML = `<span>API Quota:</span> <strong>${state.rateLimit.remaining.toLocaleString()} / ${state.rateLimit.limit.toLocaleString()}</strong>`;
      if (state.rateLimit.remaining < 50) {
        pill.style.borderColor = '#f43f5e';
        pill.style.color = '#fecdd3';
      }
    } else {
      pill.style.display = 'none';
    }
  }

  function renderStatus(text) {
    const el = document.getElementById('status-text');
    if (el) el.textContent = text;
  }

  function toggleBranch(branchName) {
    if (state.selectedBranches.includes(branchName)) {
      if (state.selectedBranches.length > 1) {
        state.selectedBranches = state.selectedBranches.filter(b => b !== branchName);
      } else {
        alert('At least one branch must remain visible.');
        return;
      }
    } else {
      state.selectedBranches.push(branchName);
    }
    renderSubToolbar();
    if (!state.isDemo) {
      fetchCommitsForBranches(state.repo, state.selectedBranches).then(renderGraph);
    } else {
      renderGraph();
    }
  }

  function renderSubToolbar() {
    const container = document.getElementById('branch-chips-area');
    if (!container) return;

    container.innerHTML = `<span class="branch-chips-label">Branches:</span>`;

    // 1. Render active branches with interactive disable '×' button
    state.selectedBranches.forEach((branchName, idx) => {
      const color = getBranchColor(branchName, idx);
      const pill = document.createElement('div');
      pill.className = 'branch-pill active';
      pill.style.background = color.bg;
      pill.style.borderColor = color.color;
      pill.style.color = color.light;

      const canDisable = state.selectedBranches.length > 1;
      pill.innerHTML = `
        <div class="pill-dot" style="background:${color.color}"></div>
        <span>${escapeHtml(branchName)}</span>
        <button class="pill-remove-btn" title="${canDisable ? `Disable ${escapeHtml(branchName)}` : 'At least one branch must remain visible'}" ${canDisable ? '' : 'disabled'}>&times;</button>
      `;

      const removeBtn = pill.querySelector('.pill-remove-btn');
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleBranch(branchName);
      });

      container.appendChild(pill);
    });

    // 2. Render quick-add chips for inactive branches directly on main screen
    const inactiveBranches = state.branches
      .map(b => b.name)
      .filter(name => !state.selectedBranches.includes(name));

    inactiveBranches.slice(0, 3).forEach(inactiveName => {
      const chip = document.createElement('div');
      chip.className = 'branch-pill inactive';
      chip.title = `Enable ${escapeHtml(inactiveName)}`;
      chip.innerHTML = `<span>+ ${escapeHtml(inactiveName)}</span>`;
      chip.addEventListener('click', () => {
        toggleBranch(inactiveName);
      });
      container.appendChild(chip);
    });

    // 3. More branches button
    const pickerBtn = document.createElement('button');
    pickerBtn.className = 'btn-branch-picker';
    const totalCount = state.branches.length;
    pickerBtn.innerHTML = `<span>+ All (${totalCount})</span>`;
    pickerBtn.onclick = () => openBranchPickerModal();
    container.appendChild(pickerBtn);
  }

  function renderGraph() {
    const viewport = document.getElementById('graph-viewport');
    if (!viewport) return;

    if (state.loading) {
      viewport.innerHTML = `
        <div class="empty-state">
          <div class="spinner"></div>
          <div>Loading branches and calculating divergence graph...</div>
        </div>
      `;
      return;
    }

    if (state.selectedBranches.length === 0) {
      viewport.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">&#x2442;</div>
          <h3>No branches selected</h3>
          <p>Click "+ All" or enable branches in the toolbar above to view.</p>
        </div>
      `;
      return;
    }

    let boardHtml = `<div class="branch-columns-board" id="branch-columns-board">`;
    boardHtml += `<svg class="inter-column-svg" id="inter-column-svg"></svg>`;

    state.selectedBranches.forEach((bName, bIdx) => {
      const color = getBranchColor(bName, bIdx);
      const rows = computeBranchDisplayRows(bName);
      const bCommits = Array.from(state.commitsMap.values()).filter(c => c.branch === bName);
      const headCommit = bCommits.find(c => c.isHead) || bCommits[0];
      const canDisable = state.selectedBranches.length > 1;
      const origin = findBranchOrigin(bName);

      boardHtml += `
        <div class="branch-column" data-branch="${escapeHtml(bName)}" style="--branch-accent:${color.color}; --rail-line-bg:linear-gradient(180deg, ${color.color}, rgba(255,255,255,0.06));">
          
          <!-- Column Header -->
          <div class="branch-column-header">
            <div class="column-header-top">
              <div class="column-header-title">
                <div class="column-header-dot" style="background:${color.color}; box-shadow:0 0 10px ${color.color};"></div>
                <span class="column-branch-name">${escapeHtml(bName)}</span>
                ${bIdx === 0 ? '<span class="badge badge-head-main" style="font-size:9px;">Base</span>' : ''}
              </div>
              <div class="column-header-actions">
                <span class="column-commits-badge">${bCommits.length} commits</span>
                <button class="column-close-btn" data-branch="${escapeHtml(bName)}" title="${canDisable ? `Disable ${escapeHtml(bName)} column` : 'At least one branch must remain visible'}" ${canDisable ? '' : 'disabled'}>&times;</button>
              </div>
            </div>
            <div class="column-header-sub">
              ${headCommit ? `<span>HEAD: <code class="sha-mini">${headCommit.shortSha}</code></span> &bull; <span>${formatRelativeDate(headCommit.date)}</span>` : ''}
            </div>
          </div>

          <!-- Column Timeline -->
          <div class="branch-column-timeline">
            <div class="column-rail-line"></div>
      `;

      rows.forEach((row) => {
        if (row.type === 'commit') {
          const c = row.commit;
          const isSelected = state.selectedCommit && state.selectedCommit.sha === c.sha;

          let badgeHtml = '';
          if (c.isHead) {
            badgeHtml = `<span class="badge ${bIdx === 0 ? 'badge-head-main' : 'badge-head-dev'}">HEAD</span>`;
          } else if (c.isForkPoint) {
            badgeHtml = `<span class="badge badge-fork">&#x2934; Fork Point</span>`;
          } else if (c.isDiversionStart) {
            badgeHtml = `<span class="badge badge-diverge">Branch Start</span>`;
          } else if (c.isMerge) {
            badgeHtml = `<span class="badge badge-merge">&#x2935; Merge</span>`;
          }

          // Check if other branches diverged from this commit
          let forkNoteHtml = '';
          if (c.forkChildren && c.forkChildren.length > 0) {
            const visibleChildren = c.forkChildren.filter(ch => state.selectedBranches.includes(ch));
            if (visibleChildren.length > 0) {
              forkNoteHtml = `<div class="branch-forked-note">&bull; Diverged to: ${visibleChildren.join(', ')} &rarr;</div>`;
            }
          }

          let diversionNoteHtml = '';
          if (c.isDiversionStart && origin) {
            diversionNoteHtml = `<div class="branch-diversion-note">&bull; Branched off ${escapeHtml(origin.parentBranch)}</div>`;
          }

          boardHtml += `
            <div class="column-timeline-item commit-item ${isSelected ? 'selected' : ''}" data-sha="${c.sha}">
              <div class="column-dot-wrapper">
                <div class="column-commit-dot ${c.isHead ? 'is-head-dot' : ''} ${c.isForkPoint ? 'is-fork-dot' : ''}"
                     data-sha="${c.sha}"
                     data-branch="${escapeHtml(bName)}"
                     style="background:${color.color}; ${c.isHead ? `box-shadow: 0 0 0 3px rgba(255,255,255,0.15), 0 0 10px ${color.color};` : ''}"
                     title="${escapeHtml(c.message.split('\n')[0])}">
                </div>
              </div>

              <div class="column-commit-card ${isSelected ? 'active-selected' : ''}"
                   data-sha="${c.sha}"
                   style="border-left-color:${color.color};">
                <div class="column-card-title-row">
                  <span class="column-commit-message">${escapeHtml(c.message.split('\n')[0])}</span>
                  ${badgeHtml}
                </div>

                ${forkNoteHtml}
                ${diversionNoteHtml}

                <div class="column-card-meta">
                  <span class="sha-code">${c.shortSha}</span>
                  <span class="author-chip">
                    <img class="avatar-mini" src="${escapeHtml(c.author?.avatar)}" alt="" onerror="this.style.display='none'">
                    <span>${escapeHtml(c.author?.name || c.author?.login)}</span>
                  </span>
                  <span>&bull;</span>
                  <span>${formatRelativeDate(c.date)}</span>
                  <div class="diff-stats" style="margin-left:auto;">
                    ${c.stats?.additions ? `<span class="diff-add">+${c.stats.additions}</span>` : ''}
                    ${c.stats?.deletions ? `<span class="diff-del">-${c.stats.deletions}</span>` : ''}
                  </div>
                </div>
              </div>
            </div>
          `;
        } else if (row.type === 'collapsed') {
          boardHtml += `
            <div class="column-timeline-item collapsed-item" data-chain-id="${row.chainId}">
              <div class="column-dot-wrapper">
                <div class="column-collapsed-marker" style="border-color:${color.color};" title="${row.count} commits collapsed"></div>
              </div>

              <div class="column-collapsed-card" data-chain-id="${row.chainId}" style="border-left: 3px dashed ${color.color}; background: linear-gradient(90deg, ${color.bg}, rgba(15, 23, 42, 0.45));">
                <div class="collapsed-card-left">
                  <span class="collapsed-pill-icon">&ctdot;</span>
                  <span class="collapsed-count-text">${row.count} commits collapsed</span>
                  <span class="collapsed-sha-range">(${row.startSha} &hellip; ${row.endSha})</span>
                </div>
                <div class="collapsed-card-right">
                  ${row.totalAdd || row.totalDel ? `<span style="font-family:var(--font-mono); font-size:10px;">+${row.totalAdd} / -${row.totalDel}</span>` : ''}
                  <button class="btn-toggle-expand" style="color:${color.light};">
                    ${row.isExpanded ? 'Fold &uarr;' : 'Expand &darr;'}
                  </button>
                </div>
              </div>
            </div>
          `;

          if (row.isExpanded && row.commits.length > 0) {
            boardHtml += `<div class="expanded-subcommits-container">`;
            row.commits.forEach(innerCommit => {
              boardHtml += `
                <div class="column-timeline-item commit-item expanded-subcommit" data-sha="${innerCommit.sha}">
                  <div class="column-dot-wrapper">
                    <div class="column-commit-dot" style="background:${color.color}; width:10px; height:10px;" data-sha="${innerCommit.sha}"></div>
                  </div>
                  <div class="column-commit-card subcommit-card" data-sha="${innerCommit.sha}" style="border-left-color:${color.color};">
                    <div class="column-card-title-row">
                      <span class="column-commit-message">${escapeHtml(innerCommit.message.split('\n')[0])}</span>
                    </div>
                    <div class="column-card-meta">
                      <span class="sha-code">${innerCommit.shortSha}</span>
                      <span>${escapeHtml(innerCommit.author?.name)}</span>
                      <span>&bull;</span>
                      <span>${formatRelativeDate(innerCommit.date)}</span>
                    </div>
                  </div>
                </div>
              `;
            });
            boardHtml += `</div>`;
          }
        }
      });

      // Branch Origin Banner at the bottom if it branched off an ancestor
      if (origin && origin.commit) {
        const parentColor = getBranchColor(origin.parentBranch);
        boardHtml += `
          <div class="column-origin-banner" 
               data-parent-sha="${origin.commit.sha}" 
               data-child-branch="${escapeHtml(bName)}"
               style="border-color:${parentColor.color}; background:${parentColor.bg}; color:${parentColor.light};"
               title="Click to view origin commit in ${escapeHtml(origin.parentBranch)}">
            <div class="origin-icon">&#x21B3;</div>
            <div style="flex:1; min-width:0;">
              <div class="origin-label">Branched from <strong>${escapeHtml(origin.parentBranch)}</strong></div>
              <div class="origin-commit-desc">
                <code class="sha-mini">${origin.commit.shortSha}</code>: ${escapeHtml(origin.commit.message.split('\n')[0])}
              </div>
            </div>
          </div>
        `;
      }

      boardHtml += `
          </div>
        </div>
      `;
    });

    // If there are inactive branches, add quick "+ Add Branch Column" card
    const inactiveBranches = state.branches
      .map(b => b.name)
      .filter(name => !state.selectedBranches.includes(name));

    if (inactiveBranches.length > 0) {
      boardHtml += `
        <div class="add-branch-column-card" id="btn-add-column-card">
          <div style="font-size:24px; color:var(--color-main);">&#x002B;</div>
          <div style="font-weight:600; font-size:13px; color:var(--text-main);">Add Branch Column</div>
          <div style="font-size:11px; color:var(--text-muted); text-align:center;">
            ${inactiveBranches.length} more available (${inactiveBranches.slice(0, 2).join(', ')}${inactiveBranches.length > 2 ? '...' : ''})
          </div>
        </div>
      `;
    }

    boardHtml += `</div>`;
    viewport.innerHTML = boardHtml;

    attachGraphListeners();

    // Render inter-column connecting SVG Bézier arcs
    requestAnimationFrame(() => renderInterColumnSvg());
  }

  // --- SVG INTER-COLUMN CONNECTORS ---
  function renderInterColumnSvg() {
    const svg = document.getElementById('inter-column-svg');
    const board = document.getElementById('branch-columns-board');
    if (!svg || !board) return;

    const boardRect = board.getBoundingClientRect();
    if (boardRect.width === 0 || boardRect.height === 0) return;

    svg.setAttribute('width', board.scrollWidth.toString());
    svg.setAttribute('height', board.scrollHeight.toString());

    let svgContent = '';

    state.selectedBranches.forEach((childBranch, childIdx) => {
      const childColor = getBranchColor(childBranch, childIdx);
      const origin = findBranchOrigin(childBranch);
      if (!origin || !origin.commit) return;

      const parentCommit = origin.commit;
      if (!state.selectedBranches.includes(parentCommit.branch)) return;

      // Find parent dot element
      const parentDot = board.querySelector(`.column-commit-dot[data-sha="${parentCommit.sha}"]`);
      // Find child origin banner or first commit dot
      const childOriginEl = board.querySelector(`.column-origin-banner[data-child-branch="${childBranch}"]`)
                         || board.querySelector(`.branch-column[data-branch="${childBranch}"] .column-commit-dot`);

      if (parentDot && childOriginEl) {
        const pRect = parentDot.getBoundingClientRect();
        const cRect = childOriginEl.getBoundingClientRect();

        const x1 = (pRect.left + pRect.width / 2) - boardRect.left + board.scrollLeft;
        const y1 = (pRect.top + pRect.height / 2) - boardRect.top + board.scrollTop;

        const x2 = cRect.left - boardRect.left + board.scrollLeft;
        const y2 = (cRect.top + cRect.height / 2) - boardRect.top + board.scrollTop;

        const midX = (x1 + x2) / 2;

        svgContent += `
          <path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}"
                fill="none"
                stroke="${childColor.color}"
                stroke-width="2.5"
                stroke-dasharray="5 4"
                opacity="0.85" />
        `;
      }
    });

    svg.innerHTML = svgContent;
  }

  function attachGraphListeners() {
    // Commit click -> select commit & open inspector
    document.querySelectorAll('.column-commit-card').forEach(card => {
      card.addEventListener('click', () => {
        const sha = card.getAttribute('data-sha');
        if (sha && state.commitsMap.has(sha)) {
          state.selectedCommit = state.commitsMap.get(sha);
          renderInspector();
          renderGraph();
        }
      });
    });

    // Collapsed card click -> toggle chain expansion
    document.querySelectorAll('.column-collapsed-card').forEach(card => {
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        const chainId = card.getAttribute('data-chain-id');
        if (state.expandedChains.has(chainId)) {
          state.expandedChains.delete(chainId);
        } else {
          state.expandedChains.add(chainId);
        }
        renderGraph();
      });
    });

    // Column header close button click -> disable branch column
    document.querySelectorAll('.column-close-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bName = btn.getAttribute('data-branch');
        if (bName) toggleBranch(bName);
      });
    });

    // Origin card click -> smooth scroll & focus parent commit
    document.querySelectorAll('.column-origin-banner').forEach(banner => {
      banner.addEventListener('click', () => {
        const parentSha = banner.getAttribute('data-parent-sha');
        if (parentSha && state.commitsMap.has(parentSha)) {
          state.selectedCommit = state.commitsMap.get(parentSha);
          renderInspector();
          renderGraph();
          const targetCard = document.querySelector(`.column-commit-card[data-sha="${parentSha}"]`);
          if (targetCard) {
            targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      });
    });

    // Add Column Card click -> open branch picker modal
    const addColCard = document.getElementById('btn-add-column-card');
    if (addColCard) {
      addColCard.addEventListener('click', () => {
        openBranchPickerModal();
      });
    }
  }

  function renderInspector() {
    const drawer = document.getElementById('inspector-drawer');
    if (!drawer) return;

    if (!state.selectedCommit) {
      drawer.classList.remove('open');
      return;
    }

    const c = state.selectedCommit;
    const color = getBranchColor(c.branch || state.selectedBranches[0]);

    drawer.innerHTML = `
      <div class="drawer-header">
        <div class="drawer-title">Commit Inspector</div>
        <button class="btn-close" id="btn-close-drawer">&times;</button>
      </div>

      <div class="detail-section">
        <div class="detail-label">Commit Message</div>
        <div class="detail-msg-box">${escapeHtml(c.message)}</div>
      </div>

      <div class="meta-grid">
        <div class="meta-box">
          <div class="meta-box-label">SHA Hash</div>
          <div class="meta-box-value" style="display:flex; align-items:center; justify-content:space-between;">
            <span>${c.shortSha}</span>
            <button class="btn btn-secondary" style="padding:2px 6px; font-size:10px;" id="btn-copy-sha">Copy</button>
          </div>
        </div>

        <div class="meta-box">
          <div class="meta-box-label">Branch Rail</div>
          <div class="meta-box-value" style="color:${color.light}">
            ${escapeHtml(c.branch || 'main')}
          </div>
        </div>
      </div>

      <div class="detail-section">
        <div class="detail-label">Author Information</div>
        <div class="meta-box" style="display:flex; align-items:center; gap:10px;">
          <img class="avatar-mini" style="width:32px; height:32px;" src="${escapeHtml(c.author?.avatar)}" alt="">
          <div>
            <div style="font-size:13px; font-weight:600;">${escapeHtml(c.author?.name)}</div>
            <div style="font-size:11px; color:var(--text-muted);">@${escapeHtml(c.author?.login)}</div>
          </div>
        </div>
      </div>

      <div class="detail-section">
        <div class="detail-label">Parent Commits</div>
        <div style="display:flex; flex-direction:column; gap:4px;">
          ${(c.parents || []).map(p => `
            <div class="sha-code" style="padding:4px 8px; cursor:pointer;" onclick="window.gitViewerSelectSha('${p}')">
              &larr; ${p.substring(0, 10)}
            </div>
          `).join('') || '<span style="font-size:12px; color:var(--text-dim)">Initial Root Commit</span>'}
        </div>
      </div>

      <div style="margin-top:auto; padding-top:16px;">
        ${!state.isDemo ? `
          <a class="btn btn-primary" style="width:100%; justify-content:center;" 
             href="https://github.com/${state.repo}/commit/${c.sha}" target="_blank" rel="noopener">
            View on GitHub &rarr;
          </a>
        ` : `
          <div style="font-size:11px; text-align:center; color:var(--text-dim);">Offline Demo Mode &bull; Simulated Commit</div>
        `}
      </div>
    `;

    drawer.classList.add('open');

    const closeBtn = document.getElementById('btn-close-drawer');
    if (closeBtn) closeBtn.onclick = () => {
      state.selectedCommit = null;
      drawer.classList.remove('open');
      renderGraph();
    };

    const copyBtn = document.getElementById('btn-copy-sha');
    if (copyBtn) copyBtn.onclick = () => {
      navigator.clipboard.writeText(c.sha);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    };
  }

  window.gitViewerSelectSha = function(sha) {
    if (state.commitsMap.has(sha)) {
      state.selectedCommit = state.commitsMap.get(sha);
      renderInspector();
      renderGraph();
    }
  };

  // --- BRANCH PICKER MODAL ---
  function openBranchPickerModal() {
    const modal = document.getElementById('branch-modal');
    if (!modal) return;

    const listContainer = document.getElementById('modal-branch-list');
    const searchInput = document.getElementById('modal-branch-search');
    if (!listContainer) return;

    function renderList(query = '') {
      const q = query.toLowerCase();
      const allBranches = state.branches.length > 0 ? state.branches : [
        { name: 'master' }, { name: 'main' }, { name: 'dev' }, { name: 'develop' }
      ];

      const filtered = allBranches.filter(b => b.name.toLowerCase().includes(q));

      // Separate common defaults (master, main, dev) to the top of list
      filtered.sort((a, b) => {
        const isDefA = ['master', 'main', 'dev', 'develop'].includes(a.name.toLowerCase());
        const isDefB = ['master', 'main', 'dev', 'develop'].includes(b.name.toLowerCase());
        if (isDefA && !isDefB) return -1;
        if (!isDefA && isDefB) return 1;
        return a.name.localeCompare(b.name);
      });

      listContainer.innerHTML = filtered.map(b => {
        const isSelected = state.selectedBranches.includes(b.name);
        const isPrimaryDefault = ['master', 'main'].includes(b.name.toLowerCase());
        const isSecondaryDefault = ['dev', 'develop'].includes(b.name.toLowerCase());
        let badge = '';
        if (isPrimaryDefault) badge = '<span class="badge badge-head-main" style="margin-left:6px; font-size:9px;">Default</span>';
        if (isSecondaryDefault) badge = '<span class="badge badge-head-dev" style="margin-left:6px; font-size:9px;">Dev</span>';

        return `
          <div class="branch-item-row ${isSelected ? 'selected' : ''}" data-name="${escapeHtml(b.name)}">
            <div style="display:flex; align-items:center;">
              <span style="font-weight:500; font-size:12px;">${escapeHtml(b.name)}</span>
              ${badge}
            </div>
            <span style="font-size:12px; font-weight:500; color:${isSelected ? 'var(--color-dev-light)' : 'var(--text-muted)'};">
              ${isSelected ? '&#x2714; Visible' : '+ Add'}
            </span>
          </div>
        `;
      }).join('');

      listContainer.querySelectorAll('.branch-item-row').forEach(row => {
        row.addEventListener('click', () => {
          const name = row.getAttribute('data-name');
          toggleBranch(name);
          renderList(searchInput ? searchInput.value : '');
        });
      });
    }

    renderList();
    modal.classList.add('open');

    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
      searchInput.oninput = (e) => renderList(e.target.value);
    }

    const closeBtn = document.getElementById('modal-close-btn');
    if (closeBtn) closeBtn.onclick = () => modal.classList.remove('open');
  }

  // --- INITIALIZATION ---
  function init() {
    const repoInput = document.getElementById('repo-input');
    const patInput = document.getElementById('pat-input');
    const btnLoadRepo = document.getElementById('btn-load-repo');
    const btnLoadDemo = document.getElementById('btn-load-demo');
    const btnExpandAll = document.getElementById('btn-expand-all');
    const btnCollapseAll = document.getElementById('btn-collapse-all');

    if (patInput) {
      patInput.addEventListener('change', (e) => {
        state.pat = e.target.value.trim();
        sessionStorage.setItem('git_pat', state.pat);
        localStorage.setItem('git_pat', state.pat);
      });
    }

    if (repoInput) {
      repoInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnLoadRepo?.click();
      });
    }

    if (btnLoadRepo) {
      btnLoadRepo.addEventListener('click', () => {
        const repoVal = repoInput ? repoInput.value.trim() : '';
        if (!repoVal || !repoVal.includes('/')) {
          alert('Please enter a valid GitHub repository in "owner/repo" format (e.g. herdrdev/herdr)');
          return;
        }
        state.repo = repoVal;
        localStorage.setItem('git_repo', state.repo);
        loadRepository(state.repo);
      });
    }

    if (btnLoadDemo) {
      btnLoadDemo.addEventListener('click', () => {
        loadDemoMode();
      });
    }

    if (btnExpandAll) {
      btnExpandAll.addEventListener('click', () => {
        state.selectedBranches.forEach(bName => {
          const rows = computeBranchDisplayRows(bName);
          rows.forEach(r => {
            if (r.type === 'collapsed') state.expandedChains.add(r.chainId);
          });
        });
        renderGraph();
      });
    }

    if (btnCollapseAll) {
      btnCollapseAll.addEventListener('click', () => {
        state.expandedChains.clear();
        renderGraph();
      });
    }

    const modal = document.getElementById('branch-modal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('open');
      });
    }

    // Redraw inter-column SVG connectors on window resize or viewport scroll
    window.addEventListener('resize', () => {
      renderInterColumnSvg();
    });

    const viewport = document.querySelector('.viewport');
    if (viewport) {
      viewport.addEventListener('scroll', () => {
        renderInterColumnSvg();
      });
    }

    // Start with offline demo data initially
    loadDemoMode();
  }

  function loadDemoMode() {
    state.isDemo = true;
    state.repo = 'ilay515/demo-repo';
    const demo = generateDemoData();
    state.branches = demo.branches;
    state.selectedBranches = ['main', 'develop', 'feature/auth'];
    state.commitsMap.clear();
    demo.commits.forEach(c => state.commitsMap.set(c.sha, c));
    state.expandedChains.clear();
    state.selectedCommit = null;
    renderStatus('Loaded demo repository with 3 branches: main (20), develop (20), feature/auth (8)');
    renderApp();
  }

  // --- HELPERS ---
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
  }

  function formatRelativeDate(isoDate) {
    if (!isoDate) return '';
    const diff = (Date.now() - new Date(isoDate).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(isoDate).toLocaleDateString();
  }

  // Run on DOM load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
