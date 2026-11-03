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

    // Common Ancestor (Fork Point on master)
    const forkCommit = {
      sha: '241b99cd397bb642',
      shortSha: '241b99c',
      message: 'refactor: share cli and api command contracts (#5212)\n\nUnify protocol dispatch between client and daemon.',
      author: { name: 'Ilay', login: 'ilay', avatar: 'https://avatars.githubusercontent.com/u/1000' },
      date: new Date(now - 7 * day).toISOString(),
      parents: ['10a9b11'],
      branch: 'master',
      stats: { additions: 154, deletions: 42 },
      isForkPoint: true,
      forkChildren: ['master', 'dev'],
    };

    // Commits on master
    const masterIntermediate = [];
    for (let i = 1; i <= 14; i++) {
      masterIntermediate.push({
        sha: `m${i}a01f83c9${i}`,
        shortSha: `m${i}a01f8`,
        message: `chore: maintenance patchline #${1040 + i}`,
        author: { name: 'Adam Wathan', login: 'adamwathan', avatar: 'https://avatars.githubusercontent.com/u/4323180' },
        date: new Date(now - (6 * day) + (i * 8 * hour)).toISOString(),
        parents: [i === 1 ? forkCommit.sha : `m${i-1}a01f83c9${i-1}`],
        branch: 'master',
        stats: { additions: 12 + i, deletions: 3 },
      });
    }

    const masterHead = {
      sha: 'ee5bfb5041bb3e4a',
      shortSha: 'ee5bfb5',
      message: 'chore: point agents at the source instead of agent-guide and llms.txt\n\nSimplifies prompt context ingestion across provider delegates.',
      author: { name: 'Adam Wathan', login: 'adamwathan', avatar: 'https://avatars.githubusercontent.com/u/4323180' },
      date: new Date(now - 1 * day).toISOString(),
      parents: [masterIntermediate[masterIntermediate.length - 1].sha],
      branch: 'master',
      stats: { additions: 18, deletions: 4 },
      isHead: true,
    };

    // Commits on dev after fork point
    const devDiversionStart = {
      sha: '289f3d79f03d881',
      shortSha: '289f3d7',
      message: 'fix: retry a reconnecting machine immediately when selected\n\nBypasses the reconnect delay when the user clicks.',
      author: { name: 'Jordan Pittman', login: 'reinink', avatar: 'https://avatars.githubusercontent.com/u/882133' },
      date: new Date(now - 5 * day).toISOString(),
      parents: [forkCommit.sha],
      branch: 'dev',
      stats: { additions: 64, deletions: 8 },
      isDiversionStart: true,
    };

    const devIntermediate = [];
    for (let i = 1; i <= 28; i++) {
      devIntermediate.push({
        sha: `d${i}b48f912e${i}`,
        shortSha: `d${i}b48f9`,
        message: `feat(core): client streaming optimization step ${i}`,
        author: { name: 'Jordan Pittman', login: 'reinink', avatar: 'https://avatars.githubusercontent.com/u/882133' },
        date: new Date(now - (4 * day) + (i * 3 * hour)).toISOString(),
        parents: [i === 1 ? devDiversionStart.sha : `d${i-1}b48f912e${i-1}`],
        branch: 'dev',
        stats: { additions: 25 + i, deletions: 10 },
      });
    }

    const devHead = {
      sha: '870b92c63d890ac',
      shortSha: '870b92c',
      message: 'fix: retry the active SSH machine when selected\n\nEnsures reconnect state refreshes immediately upon active tab focus.',
      author: { name: 'Adam Wathan', login: 'adamwathan', avatar: 'https://avatars.githubusercontent.com/u/4323180' },
      date: new Date(now - 2 * hour).toISOString(),
      parents: [devIntermediate[devIntermediate.length - 1].sha],
      branch: 'dev',
      stats: { additions: 142, deletions: 18 },
      isHead: true,
    };

    return {
      branches: [
        { name: 'master', commit: { sha: masterHead.sha } },
        { name: 'dev', commit: { sha: devHead.sha } },
        { name: 'main', commit: { sha: masterHead.sha } },
        { name: 'akbash/828-remote-drag-image-path', commit: { sha: '3cad23e' } },
        { name: '4721', commit: { sha: devHead.sha } },
      ],
      commits: [
        devHead,
        ...devIntermediate.reverse(),
        devDiversionStart,
        masterHead,
        ...masterIntermediate.reverse(),
        forkCommit,
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

  // --- DIVERSION & COLLAPSE ALGORITHM ---
  function computeDisplayRows() {
    const commits = Array.from(state.commitsMap.values());
    if (commits.length === 0) return [];

    // Sort chronologically newest first
    commits.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Identify merge commits
    commits.forEach(c => {
      if (c.parents && c.parents.length > 1) {
        c.isMerge = true;
      }
    });

    // Mark anchors: HEADs, Fork points, Diversion starts, Merges
    commits.forEach(c => {
      c.isAnchor = Boolean(c.isHead || c.isForkPoint || c.isDiversionStart || c.isMerge);
    });

    if (state.filterMode === 'all') {
      return commits.map(c => ({ type: 'commit', commit: c, branch: c.branch }));
    }

    // Collapse linear chains between anchors
    const rows = [];
    let currentChain = [];

    function flushChain() {
      if (currentChain.length === 0) return;

      if (currentChain.length <= 1) {
        currentChain.forEach(c => rows.push({ type: 'commit', commit: c, branch: c.branch }));
      } else {
        const chainId = `chain-${currentChain[0].sha}-${currentChain[currentChain.length - 1].sha}`;
        const isExpanded = state.expandedChains.has(chainId);
        const branchName = currentChain[0].branch || state.selectedBranches[0];

        let totalAdd = 0;
        let totalDel = 0;
        const authors = new Set();
        currentChain.forEach(c => {
          if (c.stats) {
            totalAdd += c.stats.additions || 0;
            totalDel += c.stats.deletions || 0;
          }
          if (c.author?.name) authors.add(c.author.name);
        });

        rows.push({
          type: 'collapsed',
          chainId,
          commits: [...currentChain],
          count: currentChain.length,
          branch: branchName,
          startSha: currentChain[0].shortSha,
          endSha: currentChain[currentChain.length - 1].shortSha,
          totalAdd,
          totalDel,
          authorsCount: authors.size,
          isExpanded,
        });
      }
      currentChain = [];
    }

    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];

      if (c.isAnchor) {
        flushChain();
        rows.push({ type: 'commit', commit: c, branch: c.branch });
      } else {
        if (currentChain.length > 0 && currentChain[0].branch !== c.branch) {
          flushChain();
        }
        currentChain.push(c);
      }
    }

    flushChain();

    // If compare reported behind_by commits on base branch that weren't individually downloaded,
    // ensure a clean collapsed marker is present between base HEAD and merge_base
    if (state.behindByCount && state.behindByCount > 0 && state.selectedBranches.length === 2) {
      const baseBranch = state.selectedBranches[0];
      const hasBaseCollapsed = rows.some(r => r.type === 'collapsed' && r.branch === baseBranch);
      const hasBaseHead = rows.some(r => r.type === 'commit' && r.commit.isHead && r.commit.branch === baseBranch);
      const hasFork = rows.some(r => r.type === 'commit' && r.commit.isForkPoint);

      if (!hasBaseCollapsed && hasBaseHead && hasFork) {
        // Find position of fork commit and inject behind_by collapsed block right above it
        const forkIdx = rows.findIndex(r => r.type === 'commit' && r.commit.isForkPoint);
        if (forkIdx > 0) {
          const synthChainId = `chain-synth-behind-${baseBranch}`;
          rows.splice(forkIdx, 0, {
            type: 'collapsed',
            chainId: synthChainId,
            commits: [],
            count: state.behindByCount,
            branch: baseBranch,
            startSha: 'HEAD',
            endSha: 'fork',
            totalAdd: 0,
            totalDel: 0,
            authorsCount: 1,
            isExpanded: state.expandedChains.has(synthChainId),
          });
        }
      }
    }

    return rows;
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

  function renderSubToolbar() {
    const container = document.getElementById('branch-chips-area');
    if (!container) return;

    container.innerHTML = `<span class="branch-chips-label">Visible:</span>`;

    state.selectedBranches.forEach((branchName, idx) => {
      const color = getBranchColor(branchName, idx);
      const pill = document.createElement('div');
      pill.className = 'branch-pill active';
      pill.style.background = color.bg;
      pill.style.borderColor = color.color;
      pill.style.color = color.light;
      pill.innerHTML = `<div class="pill-dot" style="background:${color.color}"></div><span>${escapeHtml(branchName)}</span>`;
      container.appendChild(pill);
    });

    const pickerBtn = document.createElement('button');
    pickerBtn.className = 'btn-branch-picker';
    const totalCount = state.branches.length || (state.isDemo ? 5 : 0);
    pickerBtn.innerHTML = `<span>+ Add branch (${totalCount})</span>`;
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

    state.displayRows = computeDisplayRows();

    if (state.displayRows.length === 0) {
      viewport.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">&#x2442;</div>
          <h3>No commits loaded</h3>
          <p>Enter a repository name &amp; PAT above or click "Load Demo" to explore.</p>
        </div>
      `;
      return;
    }

    // Dynamic Rail Width based on number of active branches
    const railWidth = Math.max(90, state.selectedBranches.length * 36 + 24);
    const branchCols = new Map();
    state.selectedBranches.forEach((name, idx) => {
      branchCols.set(name, 24 + idx * 36);
    });

    let html = `<div class="git-graph-view" id="graph-nodes-container" style="--rail-width:${railWidth}px;">`;
    html += `<svg class="graph-track-svg" id="graph-track-svg" style="width:${railWidth}px;"></svg>`;

    state.displayRows.forEach((row, rowIndex) => {
      const branchName = row.branch || state.selectedBranches[0];
      const color = getBranchColor(branchName, state.selectedBranches.indexOf(branchName));
      const colX = branchCols.get(branchName) || 24;

      if (row.type === 'commit') {
        const c = row.commit;
        const isSelected = state.selectedCommit && state.selectedCommit.sha === c.sha;

        let badgeHtml = '';
        if (c.isHead) {
          const isDevOrSecondary = c.branch === 'dev' || c.branch !== state.selectedBranches[0];
          const badgeClass = isDevOrSecondary ? 'badge-head-dev' : 'badge-head-main';
          badgeHtml = `<span class="badge ${badgeClass}">${escapeHtml(c.branch)} HEAD</span>`;
        } else if (c.isForkPoint) {
          badgeHtml = `<span class="badge badge-fork">&#x2934; Common Ancestor (Fork Point)</span>`;
        } else if (c.isDiversionStart) {
          badgeHtml = `<span class="badge badge-diverge">First commit on ${escapeHtml(c.branch)}</span>`;
        } else if (c.isMerge) {
          badgeHtml = `<span class="badge badge-merge">&#x2935; Merge Commit</span>`;
        }

        const dateStr = formatRelativeDate(c.date);

        html += `
          <div class="graph-node-row" data-row-idx="${rowIndex}" data-branch="${escapeHtml(branchName)}" data-sha="${c.sha}">
            <div class="graph-rails-cell">
              <div class="commit-dot" 
                   data-sha="${c.sha}"
                   data-branch="${escapeHtml(branchName)}"
                   style="background:${color.color}; left:${colX - 7}px;"
                   title="${escapeHtml(c.message.split('\n')[0])}">
              </div>
            </div>
            <div class="commit-card ${isSelected ? 'active-selected' : ''}" data-sha="${c.sha}">
              <div class="commit-main-info">
                <div class="commit-top-line">
                  <span class="commit-message">${escapeHtml(c.message.split('\n')[0])}</span>
                  ${badgeHtml}
                </div>
                <div class="commit-meta">
                  <span class="sha-code">${c.shortSha}</span>
                  <span class="author-chip">
                    <img class="avatar-mini" src="${escapeHtml(c.author?.avatar)}" alt="" onerror="this.style.display='none'">
                    <span>${escapeHtml(c.author?.name || c.author?.login)}</span>
                  </span>
                  <span>&bull;</span>
                  <span>${dateStr}</span>
                </div>
              </div>
              <div class="diff-stats">
                ${c.stats?.additions ? `<span class="diff-add">+${c.stats.additions}</span>` : ''}
                ${c.stats?.deletions ? `<span class="diff-del">-${c.stats.deletions}</span>` : ''}
              </div>
            </div>
          </div>
        `;
      } else if (row.type === 'collapsed') {
        html += `
          <div class="graph-collapsed-row" data-row-idx="${rowIndex}" data-branch="${escapeHtml(branchName)}" data-chain-id="${row.chainId}">
            <div class="graph-rails-cell">
              <div class="collapsed-rail-marker" 
                   data-chain-id="${row.chainId}"
                   data-branch="${escapeHtml(branchName)}"
                   style="border-color:${color.color}; left:${colX - 6}px;"
                   title="${row.count} commits collapsed on ${escapeHtml(branchName)}">
              </div>
            </div>
            <div class="collapsed-chain-container" data-chain-id="${row.chainId}">
              <div class="collapsed-pill" data-chain-id="${row.chainId}">
                <div class="collapsed-pill-left">
                  <div class="collapsed-icon">&#x21C5;</div>
                  <div>
                    <span class="collapsed-count">${row.count} commits collapsed</span>
                    <span>on <code>${escapeHtml(row.branch)}</code> (linear progression)</span>
                    <span style="color:#64748b; font-size:10px; margin-left:4px;">(${row.startSha} &larr; ${row.endSha})</span>
                  </div>
                </div>
                <div class="collapsed-pill-right">
                  ${row.totalAdd || row.totalDel ? `<span style="font-family:var(--font-mono); font-size:10px;">+${row.totalAdd} / -${row.totalDel}</span>` : ''}
                  <span>${row.isExpanded ? 'Fold &uarr;' : 'Expand &darr;'}</span>
                </div>
              </div>
        `;

        if (row.isExpanded && row.commits.length > 0) {
          html += `<div class="expanded-commits-group">`;
          row.commits.forEach(innerCommit => {
            html += `
              <div class="commit-card" data-sha="${innerCommit.sha}" style="border-style:dashed;">
                <div class="commit-main-info">
                  <div class="commit-top-line">
                    <span class="commit-message">${escapeHtml(innerCommit.message.split('\n')[0])}</span>
                  </div>
                  <div class="commit-meta">
                    <span class="sha-code">${innerCommit.shortSha}</span>
                    <span>${escapeHtml(innerCommit.author?.name)}</span>
                    <span>&bull;</span>
                    <span>${formatRelativeDate(innerCommit.date)}</span>
                  </div>
                </div>
              </div>
            `;
          });
          html += `</div>`;
        }

        html += `
            </div>
          </div>
        `;
      }
    });

    html += `</div>`;
    viewport.innerHTML = html;

    attachGraphListeners();

    // Render SVG connecting rails
    requestAnimationFrame(() => renderSvgRails(branchCols, railWidth));
  }

  // --- SVG GRAPH RAILS & DIVERSION ENGINE ---
  function renderSvgRails(branchCols, railWidth) {
    const svg = document.getElementById('graph-track-svg');
    const container = document.getElementById('graph-nodes-container');
    if (!svg || !container) return;

    const totalHeight = container.offsetHeight;
    if (totalHeight === 0) return;

    svg.setAttribute('width', railWidth.toString());
    svg.setAttribute('height', totalHeight.toString());

    let svgContent = '';
    const containerRect = container.getBoundingClientRect();

    // 1. Collect markers for each branch (both commit dots and collapsed markers)
    state.selectedBranches.forEach((bName, bIdx) => {
      const colX = branchCols.get(bName);
      if (colX === undefined) return;
      const bColor = getBranchColor(bName, bIdx);

      // Find all rows belonging to this branch
      const rows = container.querySelectorAll(`[data-branch="${CSS.escape(bName)}"]`);
      const markers = [];

      rows.forEach(r => {
        const dot = r.querySelector('.commit-dot') || r.querySelector('.collapsed-rail-marker');
        if (!dot) return;
        const dotRect = dot.getBoundingClientRect();
        const cy = (dotRect.top + dotRect.height / 2) - containerRect.top + container.scrollTop;
        const isCollapsed = dot.classList.contains('collapsed-rail-marker');
        const sha = dot.getAttribute('data-sha');
        markers.push({ cy, isCollapsed, sha, dot });
      });

      // Sort vertically top to bottom
      markers.sort((a, b) => a.cy - b.cy);

      // Draw continuous vertical rail line connecting markers on this branch
      for (let i = 0; i < markers.length - 1; i++) {
        const m1 = markers[i];
        const m2 = markers[i + 1];
        const isDashed = m1.isCollapsed || m2.isCollapsed;

        svgContent += `
          <line x1="${colX}" y1="${m1.cy}" 
                x2="${colX}" y2="${m2.cy}" 
                stroke="${bColor.color}" 
                stroke-width="2.5" 
                stroke-linecap="round"
                ${isDashed ? 'stroke-dasharray="4 3"' : ''} />
        `;
      }
    });

    // 2. Draw Branch Diversion Curves
    // Find the Common Ancestor (Fork Point)
    const forkDot = container.querySelector('.badge-fork')?.closest('.graph-node-row')?.querySelector('.commit-dot')
                 || container.querySelector('[data-sha]')?.closest('.graph-node-row')?.querySelector('.commit-dot');

    const forkCommit = Array.from(state.commitsMap.values()).find(c => c.isForkPoint);

    if (forkCommit) {
      const forkEl = container.querySelector(`.commit-dot[data-sha="${forkCommit.sha}"]`);
      if (forkEl) {
        const forkRect = forkEl.getBoundingClientRect();
        const forkBranch = forkCommit.branch || state.selectedBranches[0];
        const forkColX = branchCols.get(forkBranch) || 24;
        const forkCy = (forkRect.top + forkRect.height / 2) - containerRect.top + container.scrollTop;

        // Connect each diverged branch to this fork point
        state.selectedBranches.forEach((bName, bIdx) => {
          if (bName === forkBranch) return; // skip base branch itself

          const colX = branchCols.get(bName);
          if (colX === undefined) return;
          const bColor = getBranchColor(bName, bIdx);

          // Find the diversion start or bottom-most node of this diverged branch
          const branchRows = container.querySelectorAll(`[data-branch="${CSS.escape(bName)}"]`);
          if (branchRows.length === 0) return;

          let targetMarker = null;
          // Prefer diversion start commit dot
          const divRow = container.querySelector(`.badge-diverge`)?.closest(`[data-branch="${CSS.escape(bName)}"]`);
          if (divRow) {
            targetMarker = divRow.querySelector('.commit-dot');
          }

          if (!targetMarker) {
            // Pick lowest marker on this branch
            const lastRow = branchRows[branchRows.length - 1];
            targetMarker = lastRow.querySelector('.commit-dot') || lastRow.querySelector('.collapsed-rail-marker');
          }

          if (targetMarker) {
            const targetRect = targetMarker.getBoundingClientRect();
            const targetCy = (targetRect.top + targetRect.height / 2) - containerRect.top + container.scrollTop;

            // Draw smooth Bézier curve from fork point to diverged branch
            const midY = (forkCy + targetCy) / 2;
            svgContent += `
              <path d="M ${forkColX} ${forkCy} C ${forkColX} ${midY}, ${colX} ${midY}, ${colX} ${targetCy}" 
                    fill="none" 
                    stroke="${bColor.color}" 
                    stroke-width="2.5" 
                    stroke-linecap="round" 
                    stroke-dasharray="4 3" />
            `;
          }
        });
      }
    }

    // 3. Draw direct parent-child lines for visible commits if across branches or merges
    const visibleDots = container.querySelectorAll('.commit-dot');
    visibleDots.forEach(dot => {
      const sha = dot.getAttribute('data-sha');
      const c = state.commitsMap.get(sha);
      if (!c || !c.parents) return;

      const dotRect = dot.getBoundingClientRect();
      const dotCy = (dotRect.top + dotRect.height / 2) - containerRect.top + container.scrollTop;
      const dotColX = branchCols.get(c.branch) || 24;

      c.parents.forEach(pSha => {
        const parentDot = container.querySelector(`.commit-dot[data-sha="${pSha}"]`);
        if (parentDot) {
          const parentC = state.commitsMap.get(pSha);
          if (parentC && parentC.branch !== c.branch) {
            const pRect = parentDot.getBoundingClientRect();
            const pCy = (pRect.top + pRect.height / 2) - containerRect.top + container.scrollTop;
            const pColX = branchCols.get(parentC.branch) || 24;

            const midY = (dotCy + pCy) / 2;
            const color = getBranchColor(c.branch).color;

            svgContent += `
              <path d="M ${dotColX} ${dotCy} C ${dotColX} ${midY}, ${pColX} ${midY}, ${pColX} ${pCy}" 
                    fill="none" 
                    stroke="${color}" 
                    stroke-width="2" 
                    stroke-linecap="round" />
            `;
          }
        }
      });
    });

    svg.innerHTML = svgContent;
  }

  function attachGraphListeners() {
    // Commit click -> open inspector
    document.querySelectorAll('.commit-card').forEach(card => {
      card.addEventListener('click', () => {
        const sha = card.getAttribute('data-sha');
        if (sha && state.commitsMap.has(sha)) {
          state.selectedCommit = state.commitsMap.get(sha);
          renderInspector();
          renderGraph();
        }
      });
    });

    // Collapsed pill click -> toggle chain expansion
    document.querySelectorAll('.collapsed-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        const chainId = pill.getAttribute('data-chain-id');
        if (state.expandedChains.has(chainId)) {
          state.expandedChains.delete(chainId);
        } else {
          state.expandedChains.add(chainId);
        }
        renderGraph();
      });
    });
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
          if (state.selectedBranches.includes(name)) {
            if (state.selectedBranches.length > 1) {
              state.selectedBranches = state.selectedBranches.filter(b => b !== name);
            } else {
              alert('At least one branch must remain visible.');
              return;
            }
          } else {
            state.selectedBranches.push(name);
          }
          renderList(searchInput ? searchInput.value : '');
          renderSubToolbar();
          if (!state.isDemo) {
            fetchCommitsForBranches(state.repo, state.selectedBranches).then(renderGraph);
          } else {
            renderGraph();
          }
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
        state.displayRows.forEach(row => {
          if (row.type === 'collapsed') state.expandedChains.add(row.chainId);
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

    // Redraw SVG rails on window resize or viewport scroll
    window.addEventListener('resize', () => {
      const railWidth = Math.max(90, state.selectedBranches.length * 36 + 24);
      const branchCols = new Map();
      state.selectedBranches.forEach((name, idx) => {
        branchCols.set(name, 24 + idx * 36);
      });
      renderSvgRails(branchCols, railWidth);
    });

    const viewport = document.querySelector('.viewport');
    if (viewport) {
      viewport.addEventListener('scroll', () => {
        const railWidth = Math.max(90, state.selectedBranches.length * 36 + 24);
        const branchCols = new Map();
        state.selectedBranches.forEach((name, idx) => {
          branchCols.set(name, 24 + idx * 36);
        });
        renderSvgRails(branchCols, railWidth);
      });
    }

    // Start with offline demo data initially
    loadDemoMode();
  }

  function loadDemoMode() {
    state.isDemo = true;
    state.repo = 'herdrdev/herdr (Demo)';
    const demo = generateDemoData();
    state.branches = demo.branches;
    state.selectedBranches = ['master', 'dev'];
    state.commitsMap.clear();
    demo.commits.forEach(c => state.commitsMap.set(c.sha, c));
    state.expandedChains.clear();
    state.selectedCommit = null;
    renderStatus('Loaded interactive demo comparing master and dev with full diversion curves and commit collapse');
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
