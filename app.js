// GitBranch Lens: Client-Only Git Branch Divergence Viewer
// Pure client-side implementation with zero backend dependencies
// Supports GitHub and GitLab repositories directly

(function () {
  'use strict';

  // --- STATE ---
  const state = {
    gitSource: localStorage.getItem('git_source') || 'github',
    gitHost: localStorage.getItem('git_host') || '',
    pat: sessionStorage.getItem('git_pat') || localStorage.getItem('git_pat') || '',
    repo: localStorage.getItem('git_repo') || 'herdrdev/herdr',
    branches: [],
    selectedBranches: ['master', 'main'],
    commitsMap: new Map(), // sha -> commit object
    displayRows: [],       // computed list of render items (commits or collapsed chains)
    expandedChains: new Set(), // set of chain IDs currently expanded
    selectedCommit: null,
    loading: false,
    rateLimit: { remaining: null, limit: null },
    filterMode: 'smart',   // 'smart' (tips & diversions) | 'all'
    repoInfo: null,
    globalSearchQuery: '',
    globalSearchResults: [],
    currentSearchIndex: -1,
    branchSearchQueries: new Map(), // branchName -> query
    activeBranchSearch: new Set(),  // set of branchNames with visible search input
    commitsDepth: 50,               // default commits depth
    branchPages: new Map(),         // branchName -> page number
    branchLoadingMore: new Set(),   // set of branches currently fetching more
    branchReachedBottom: new Set(), // set of branches where root/bottom commit was reached
    branchOrigins: new Map(),       // branchName -> { commitSha, parentBranch }
  };

  // Branch Color Palette (Clean Developer-Grade Colors)
  const PALETTE = [
    { color: '#58a6ff', light: '#79c0ff', bg: 'rgba(56, 139, 253, 0.12)' }, // Blue (main/master)
    { color: '#3fb950', light: '#56d364', bg: 'rgba(46, 160, 67, 0.12)' },  // Green (dev/develop)
    { color: '#bc8cff', light: '#d2a8ff', bg: 'rgba(163, 113, 247, 0.12)' }, // Purple (features)
    { color: '#d29922', light: '#e3b341', bg: 'rgba(210, 153, 34, 0.12)' },  // Amber (divergence)
    { color: '#39c5cf', light: '#56d4dd', bg: 'rgba(57, 197, 207, 0.12)' }, // Cyan
    { color: '#f778ba', light: '#ff9bce', bg: 'rgba(247, 120, 186, 0.12)' }, // Pink
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

  // --- REPOSITORY INPUT PARSER ---
  function parseRepoInput(rawInput, defaultSource = 'github') {
    let input = (rawInput || '').trim();
    if (input.endsWith('.git')) {
      input = input.slice(0, -4);
    }
    input = input.replace(/\/+$/, '');

    let source = defaultSource;
    let host = source === 'gitlab' ? 'https://gitlab.com' : 'https://api.github.com';
    let repoPath = input;

    if (input.startsWith('http://') || input.startsWith('https://')) {
      try {
        const u = new URL(input);
        const pathname = u.pathname.replace(/^\/+/, '');
        if (u.hostname === 'github.com') {
          source = 'github';
          host = 'https://api.github.com';
          repoPath = pathname;
        } else if (u.hostname === 'gitlab.com' || u.hostname.includes('gitlab')) {
          source = 'gitlab';
          host = `${u.protocol}//${u.host}`;
          repoPath = pathname;
        } else {
          repoPath = pathname;
        }
      } catch (e) {}
    } else if (input.startsWith('github.com/')) {
      source = 'github';
      host = 'https://api.github.com';
      repoPath = input.replace(/^github\.com\/+/, '');
    } else if (input.startsWith('gitlab.com/')) {
      source = 'gitlab';
      host = 'https://gitlab.com';
      repoPath = input.replace(/^gitlab\.com\/+/, '');
    }

    return { source, host, repoPath };
  }

  // --- UNIFIED GIT API CLIENT (GitHub + GitLab) ---
  async function fetchGitSource(endpoint) {
    let url;
    const headers = {};

    if (state.gitSource === 'gitlab') {
      const baseHost = state.gitHost || 'https://gitlab.com';
      url = endpoint.startsWith('http') ? endpoint : `${baseHost}/api/v4${endpoint}`;
      headers['Accept'] = 'application/json';
      if (state.pat && state.pat.trim()) {
        headers['PRIVATE-TOKEN'] = state.pat.trim();
        headers['Authorization'] = `Bearer ${state.pat.trim()}`;
      }
    } else {
      url = endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`;
      headers['Accept'] = 'application/vnd.github.v3+json';
      if (state.pat && state.pat.trim()) {
        headers['Authorization'] = `Bearer ${state.pat.trim()}`;
      }
    }

    const resp = await fetch(url, { headers });

    // Capture rate limits (GitLab ratelimit-* or GitHub x-ratelimit-*)
    const rem = resp.headers.get('ratelimit-remaining') || resp.headers.get('x-ratelimit-remaining');
    const limit = resp.headers.get('ratelimit-limit') || resp.headers.get('x-ratelimit-limit');
    if (rem !== null) {
      state.rateLimit = {
        remaining: parseInt(rem, 10),
        limit: limit ? parseInt(limit, 10) : (state.gitSource === 'gitlab' ? 500 : 60),
      };
      renderRateLimit();
    }

    if (!resp.ok) {
      const sourceName = state.gitSource === 'gitlab' ? 'GitLab' : 'GitHub';
      let errMsg = `${sourceName} API error (${resp.status} ${resp.statusText})`;
      try {
        const errJson = await resp.json();
        if (errJson.message) {
          errMsg = typeof errJson.message === 'string' ? errJson.message : JSON.stringify(errJson.message);
          if (resp.status === 403 && errMsg.includes('rate limit')) {
            errMsg += ` — Please enter a Personal Access Token (PAT) above to increase API rate limits.`;
          }
        } else if (errJson.error) {
          errMsg = errJson.error;
        }
      } catch (e) {}
      throw new Error(errMsg);
    }

    return await resp.json();
  }

  // Paginated Branch Fetcher (Fetches ALL branches, not just the first 100)
  async function fetchAllBranches(repoPath) {
    const allBranches = [];
    let page = 1;
    const maxPages = 10; // Up to 1,000 branches

    while (page <= maxPages) {
      renderStatus(`Fetching branches for ${repoPath} (page ${page})...`);
      let endpoint;
      if (state.gitSource === 'gitlab') {
        const projectId = encodeURIComponent(repoPath);
        endpoint = `/projects/${projectId}/repository/branches?per_page=100&page=${page}`;
      } else {
        endpoint = `/repos/${repoPath}/branches?per_page=100&page=${page}`;
      }

      const data = await fetchGitSource(endpoint);
      if (!Array.isArray(data) || data.length === 0) break;
      allBranches.push(...data);
      if (data.length < 100) break;
      page++;
    }

    return allBranches;
  }

  async function fetchBranchCommits(repoPath, branchName, perPage, page) {
    if (state.gitSource === 'gitlab') {
      const projectId = encodeURIComponent(repoPath);
      return await fetchGitSource(`/projects/${projectId}/repository/commits?ref_name=${encodeURIComponent(branchName)}&per_page=${perPage}&page=${page}`);
    } else {
      return await fetchGitSource(`/repos/${repoPath}/commits?sha=${encodeURIComponent(branchName)}&per_page=${perPage}&page=${page}`);
    }
  }

  function formatCommit(c, branch) {
    if (!c) return null;
    const isGitLab = state.gitSource === 'gitlab' || Boolean(c.id && !c.sha);

    if (isGitLab) {
      const sha = c.id;
      return {
        sha: sha,
        shortSha: c.short_id || (sha ? sha.substring(0, 7) : ''),
        message: c.message || c.title || '',
        author: {
          name: c.author_name || 'Developer',
          login: c.author_email ? c.author_email.split('@')[0] : 'author',
          avatar: c.author_gravatar_url || 'https://assets.gitlab-static.net/assets/gitlab_logo-7ae504fe4f68fdebb3d2032e37952294f447f781808e3987163796a210209f6d.png',
        },
        date: c.committed_date || c.created_at || new Date().toISOString(),
        parents: c.parent_ids || [],
        branch: branch,
        stats: c.stats || { additions: 0, deletions: 0 },
        isHead: false,
        isForkPoint: false,
        isDiversionStart: false,
      };
    } else {
      return {
        sha: c.sha,
        shortSha: c.sha ? c.sha.substring(0, 7) : '',
        message: c.commit?.message || c.message || '',
        author: {
          name: c.commit?.author?.name || c.author?.login || 'Developer',
          login: c.author?.login || 'unknown',
          avatar: c.author?.avatar_url || 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
        },
        date: c.commit?.author?.date || c.created_at || new Date().toISOString(),
        parents: (c.parents || []).map(p => typeof p === 'string' ? p : p.sha),
        branch: branch,
        stats: c.stats || { additions: 0, deletions: 0 },
        isHead: false,
        isForkPoint: false,
        isDiversionStart: false,
      };
    }
  }

  // Resolve default branches: main, master, dev, develop
  function resolveDefaultBranches(repoInfo, branches) {
    const names = branches.map(b => b.name);
    const repoDefault = repoInfo?.default_branch || branches.find(b => b.default)?.name;

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

  async function loadRepository(repoInputVal) {
    const parsed = parseRepoInput(repoInputVal, state.gitSource);
    state.gitSource = parsed.source;
    state.gitHost = parsed.host;
    state.repo = parsed.repoPath;
    localStorage.setItem('git_source', state.gitSource);
    localStorage.setItem('git_repo', state.repo);
    localStorage.setItem('git_host', state.gitHost);
    updateSourceUI();

    state.loading = true;
    state.branchReachedBottom.clear();
    state.commitsMap.clear();
    state.branchOrigins.clear();
    state.expandedChains.clear();
    state.selectedCommit = null;
    renderStatus(`Fetching repository ${state.repo} from ${state.gitSource === 'gitlab' ? 'GitLab' : 'GitHub'}...`);

    try {
      // 1. Fetch repo info (default_branch, web_url, etc.)
      let repoInfo = null;
      try {
        if (state.gitSource === 'gitlab') {
          const projectId = encodeURIComponent(state.repo);
          repoInfo = await fetchGitSource(`/projects/${projectId}`);
        } else {
          repoInfo = await fetchGitSource(`/repos/${state.repo}`);
        }
        state.repoInfo = repoInfo;
      } catch (e) {
        console.warn('Could not fetch repo metadata directly:', e);
      }

      // 2. Fetch all branches with pagination
      const branchesData = await fetchAllBranches(state.repo);
      if (branchesData.length === 0) {
        throw new Error('No branches found in this repository.');
      }
      state.branches = branchesData;

      // 3. Resolve default branches (prioritizes default_branch, master, main, dev, develop)
      state.selectedBranches = resolveDefaultBranches(repoInfo, branchesData);

      // 4. Fetch commits and branch divergence
      await fetchCommitsForBranches(state.repo, state.selectedBranches);

      state.loading = false;
      renderStatus(`Loaded ${branchesData.length} branches from ${state.repo}. Comparing: ${state.selectedBranches.join(' vs ')}`);
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
    if (!selectedBranchNames || selectedBranchNames.length === 0) return;

    const base = selectedBranchNames[0];
    const otherBranches = selectedBranchNames.slice(1);

    // 1. Analyze divergence: Compare all secondary branches with base branch
    for (const head of otherBranches) {
      renderStatus(`Analyzing divergence: ${base}...${head}...`);
      try {
        let mergeBase = null;
        let diffCommits = [];

        if (state.gitSource === 'gitlab') {
          const projectId = encodeURIComponent(ownerRepo);
          try {
            const mb = await fetchGitSource(`/projects/${projectId}/repository/merge_base?refs[]=${encodeURIComponent(base)}&refs[]=${encodeURIComponent(head)}`);
            if (mb && mb.id) mergeBase = mb;
          } catch (e) {
            console.warn(`GitLab merge_base failed between ${base} and ${head}:`, e);
          }
          try {
            const comp = await fetchGitSource(`/projects/${projectId}/repository/compare?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}`);
            if (comp && Array.isArray(comp.commits)) diffCommits = comp.commits;
          } catch (e) {
            console.warn(`GitLab compare failed between ${base} and ${head}:`, e);
          }
        } else {
          // GitHub compare API
          const compare = await fetchGitSource(`/repos/${ownerRepo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
          if (compare) {
            mergeBase = compare.merge_base_commit;
            diffCommits = compare.commits || [];
          }
        }

        // Common Ancestor / Fork Point
        if (mergeBase) {
          const mbObj = formatCommit(mergeBase, base);
          mbObj.isForkPoint = true;
          if (!mbObj.forkChildren) mbObj.forkChildren = [];
          if (!mbObj.forkChildren.includes(head)) mbObj.forkChildren.push(head);
          if (!mbObj.forkChildren.includes(base)) mbObj.forkChildren.push(base);
          state.commitsMap.set(mbObj.sha, mbObj);

          state.branchOrigins.set(head, {
            commitSha: mbObj.sha,
            parentBranch: base,
          });
        }

        // Commits unique to head branch
        if (diffCommits && diffCommits.length > 0) {
          diffCommits.forEach((c, idx) => {
            const commitObj = formatCommit(c, head);
            if (idx === 0) commitObj.isDiversionStart = true;
            if (idx === diffCommits.length - 1) commitObj.isHead = true;
            state.commitsMap.set(commitObj.sha, commitObj);
          });
        }
      } catch (e) {
        console.warn(`Divergence analysis failed between ${base} and ${head}:`, e);
      }
    }

    // 2. Fetch configured depth of commits for each selected branch
    for (const bName of selectedBranchNames) {
      state.branchPages.set(bName, 1);
      try {
        const list = await fetchBranchCommits(ownerRepo, bName, state.commitsDepth, 1);
        if (!Array.isArray(list) || list.length === 0) {
          state.branchReachedBottom.add(bName);
        } else {
          list.forEach((c, idx) => {
            const commitObj = formatCommit(c, bName);
            if (idx === 0) commitObj.isHead = true;
            if (!state.commitsMap.has(commitObj.sha)) {
              state.commitsMap.set(commitObj.sha, commitObj);
            } else {
              const existing = state.commitsMap.get(commitObj.sha);
              if (idx === 0) existing.isHead = true;
            }
          });

          // Check if root commit was reached (fewer commits than requested, or commit with no parents)
          const hasRootCommit = list.some(c => {
            const p = (state.gitSource === 'gitlab' || c.id) ? c.parent_ids : c.parents;
            return !p || p.length === 0;
          });
          if (list.length < state.commitsDepth || hasRootCommit) {
            state.branchReachedBottom.add(bName);
          }
        }
      } catch (e) {
        console.error(`Error loading commits for branch ${bName}:`, e);
      }
    }
  }

  async function loadMoreCommits(branchName) {
    if (state.branchReachedBottom.has(branchName) || state.branchLoadingMore.has(branchName)) return;
    state.branchLoadingMore.add(branchName);
    renderGraph();

    const nextPage = (state.branchPages.get(branchName) || 1) + 1;
    renderStatus(`Fetching page ${nextPage} of commits for ${branchName}...`);

    try {
      const list = await fetchBranchCommits(state.repo, branchName, state.commitsDepth, nextPage);
      if (Array.isArray(list) && list.length > 0) {
        list.forEach(c => {
          const commitObj = formatCommit(c, branchName);
          if (!state.commitsMap.has(commitObj.sha)) {
            state.commitsMap.set(commitObj.sha, commitObj);
          }
        });
        state.branchPages.set(branchName, nextPage);
        renderStatus(`Loaded ${list.length} more commits for ${branchName} (page ${nextPage}).`);

        const hasRootCommit = list.some(c => {
          const p = (state.gitSource === 'gitlab' || c.id) ? c.parent_ids : c.parents;
          return !p || p.length === 0;
        });
        if (list.length < state.commitsDepth || hasRootCommit) {
          state.branchReachedBottom.add(branchName);
          renderStatus(`Reached branch root for ${branchName}.`);
        }
      } else {
        state.branchReachedBottom.add(branchName);
        renderStatus(`Reached earliest available commit for ${branchName}.`);
      }
    } catch (e) {
      console.error(`Error loading more commits for ${branchName}:`, e);
      renderStatus(`Could not load more commits: ${e.message}`);
    } finally {
      state.branchLoadingMore.delete(branchName);
      renderGraph();
    }
  }

  // --- DIVERSION & MULTI-COLUMN BRANCH ENGINE ---
  function computeBranchDisplayRows(branchName) {
    const allCommits = Array.from(state.commitsMap.values());
    const bCommits = allCommits.filter(c => c.branch === branchName);
    bCommits.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (bCommits.length === 0) return [];

    // Collect active origin commit SHAs so fork points are never collapsed
    const activeOriginShas = new Set();
    state.selectedBranches.forEach(b => {
      if (state.branchOrigins.has(b)) {
        activeOriginShas.add(state.branchOrigins.get(b).commitSha);
      }
    });

    bCommits.forEach((c, idx) => {
      if (idx === 0) c.isHead = true;
      if (c.parents && c.parents.length > 1) c.isMerge = true;
      c.isAnchor = Boolean(c.isHead || c.isForkPoint || c.isDiversionStart || c.isMerge || activeOriginShas.has(c.sha));
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
    if (!branchName) return null;

    // 1. Check persistent branchOrigins map
    if (state.branchOrigins.has(branchName)) {
      const orig = state.branchOrigins.get(branchName);
      if (orig && orig.commitSha && state.commitsMap.has(orig.commitSha)) {
        const parentCommit = state.commitsMap.get(orig.commitSha);
        const parentBranch = parentCommit.branch || orig.parentBranch;
        if (state.selectedBranches.includes(parentBranch)) {
          return {
            commit: parentCommit,
            parentBranch,
          };
        }
      }
    }

    // Base branch (index 0) is the reference root, does not originate from other branches unless explicitly recorded above
    if (state.selectedBranches.length > 0 && branchName === state.selectedBranches[0]) {
      return null;
    }

    const allCommits = Array.from(state.commitsMap.values());
    const bCommits = allCommits.filter(c => c.branch === branchName);

    // 2. Check if any commit in state is a fork point that has this branch in forkChildren
    const forkCommit = allCommits.find(c =>
      c.isForkPoint &&
      c.forkChildren &&
      c.forkChildren.includes(branchName) &&
      c.branch !== branchName &&
      state.selectedBranches.includes(c.branch)
    );
    if (forkCommit) {
      const parentBranch = forkCommit.branch || state.selectedBranches[0];
      state.branchOrigins.set(branchName, { commitSha: forkCommit.sha, parentBranch });
      return { commit: forkCommit, parentBranch };
    }

    // 3. Check for any commit on this branch that is marked as diversion start
    const divCommit = bCommits.find(c => c.isDiversionStart);
    if (divCommit && divCommit.parents && divCommit.parents.length > 0) {
      for (const pSha of divCommit.parents) {
        const parent = state.commitsMap.get(pSha);
        if (parent && parent.branch !== branchName && state.selectedBranches.includes(parent.branch)) {
          state.branchOrigins.set(branchName, { commitSha: parent.sha, parentBranch: parent.branch });
          return { commit: parent, parentBranch: parent.branch };
        }
      }
    }

    // 4. Check all commits on this branch (oldest to newest) whose parent belongs to another branch
    const chronologicalCommits = [...bCommits].sort((a, b) => new Date(a.date) - new Date(b.date));
    for (const c of chronologicalCommits) {
      if (c.parents && c.parents.length > 0) {
        for (const pSha of c.parents) {
          const parentCommit = state.commitsMap.get(pSha);
          if (parentCommit && parentCommit.branch !== branchName && state.selectedBranches.includes(parentCommit.branch)) {
            state.branchOrigins.set(branchName, { commitSha: parentCommit.sha, parentBranch: parentCommit.branch });
            return {
              commit: parentCommit,
              parentBranch: parentCommit.branch,
            };
          }
        }
      }
    }

    return null;
  }

  // --- SEARCH ENGINE (Global & Per-Branch) ---
  function matchCommit(commit, query) {
    if (!query || !commit) return false;
    const q = query.toLowerCase().trim();
    if (!q) return false;
    if (commit.sha && commit.sha.toLowerCase().includes(q)) return true;
    if (commit.shortSha && commit.shortSha.toLowerCase().includes(q)) return true;
    if (commit.message && commit.message.toLowerCase().includes(q)) return true;
    if (commit.author?.name && commit.author.name.toLowerCase().includes(q)) return true;
    if (commit.author?.login && commit.author.login.toLowerCase().includes(q)) return true;
    return false;
  }

  function applyGlobalSearch(query) {
    state.globalSearchQuery = (query || '').trim();
    if (!state.globalSearchQuery) {
      state.globalSearchResults = [];
      state.currentSearchIndex = -1;
      updateSearchNavUI();
      renderGraph();
      return;
    }

    // Auto-expand any collapsed chains containing matches
    state.selectedBranches.forEach(bName => {
      const rows = computeBranchDisplayRows(bName);
      rows.forEach(row => {
        if (row.type === 'collapsed') {
          const hasMatchInChain = row.commits.some(c => matchCommit(c, state.globalSearchQuery));
          if (hasMatchInChain) {
            state.expandedChains.add(row.chainId);
          }
        }
      });
    });

    // Collect all matches in selected branches in display order
    const allCommits = Array.from(state.commitsMap.values());
    const matches = [];
    state.selectedBranches.forEach(bName => {
      const bCommits = allCommits.filter(c => c.branch === bName);
      bCommits.sort((a, b) => new Date(b.date) - new Date(a.date));
      bCommits.forEach(c => {
        if (matchCommit(c, state.globalSearchQuery)) {
          matches.push(c.sha);
        }
      });
    });

    state.globalSearchResults = matches;
    state.currentSearchIndex = matches.length > 0 ? 0 : -1;
    updateSearchNavUI();
    renderGraph();

    if (state.currentSearchIndex >= 0) {
      focusCurrentSearchMatch();
    }
  }

  function updateSearchNavUI() {
    const clearBtn = document.getElementById('btn-clear-global-search');
    const navControls = document.getElementById('search-nav-controls');
    const countEl = document.getElementById('search-match-count');

    if (!clearBtn || !navControls || !countEl) return;

    if (state.globalSearchQuery) {
      clearBtn.style.display = 'inline-block';
      navControls.style.display = 'inline-flex';
      const total = state.globalSearchResults.length;
      if (total === 0) {
        countEl.textContent = '0 matches';
        countEl.style.color = 'var(--text-tertiary)';
      } else {
        countEl.textContent = `${state.currentSearchIndex + 1} of ${total} match${total > 1 ? 'es' : ''}`;
        countEl.style.color = 'var(--branch-amber)';
      }
    } else {
      clearBtn.style.display = 'none';
      navControls.style.display = 'none';
    }
  }

  function navigateSearchMatch(direction = 1) {
    const total = state.globalSearchResults.length;
    if (total === 0) return;
    state.currentSearchIndex = (state.currentSearchIndex + direction + total) % total;
    updateSearchNavUI();
    renderGraph();
    focusCurrentSearchMatch();
  }

  function focusCurrentSearchMatch() {
    if (state.currentSearchIndex < 0 || state.currentSearchIndex >= state.globalSearchResults.length) return;
    const targetSha = state.globalSearchResults[state.currentSearchIndex];
    requestAnimationFrame(() => {
      const el = document.querySelector(`.column-timeline-item[data-sha="${targetSha}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
    });
  }

  function clearGlobalSearch() {
    state.globalSearchQuery = '';
    state.globalSearchResults = [];
    state.currentSearchIndex = -1;
    const input = document.getElementById('global-search-input');
    if (input) input.value = '';
    updateSearchNavUI();
    renderGraph();
  }

  function toggleBranchSearch(branchName) {
    if (state.activeBranchSearch.has(branchName)) {
      state.activeBranchSearch.delete(branchName);
      state.branchSearchQueries.delete(branchName);
    } else {
      state.activeBranchSearch.add(branchName);
    }
    renderGraph();
    if (state.activeBranchSearch.has(branchName)) {
      setTimeout(() => {
        const inp = document.querySelector(`.column-search-input[data-branch="${branchName}"]`);
        if (inp) {
          inp.focus();
          inp.select();
        }
      }, 50);
    }
  }

  function setBranchSearchQuery(branchName, query) {
    const q = (query || '').trim();
    if (q) {
      state.branchSearchQueries.set(branchName, q);
      // Auto-expand any collapsed chains in this branch containing matches
      const rows = computeBranchDisplayRows(branchName);
      rows.forEach(row => {
        if (row.type === 'collapsed') {
          const hasMatch = row.commits.some(c => matchCommit(c, q));
          if (hasMatch) state.expandedChains.add(row.chainId);
        }
      });
    } else {
      state.branchSearchQueries.delete(branchName);
    }
    renderGraph();
    const inp = document.querySelector(`.column-search-input[data-branch="${branchName}"]`);
    if (inp) {
      inp.focus();
      const len = inp.value.length;
      inp.setSelectionRange(len, len);
    }
  }

  // --- RENDER FUNCTIONS ---
  function renderApp() {
    renderHeader();
    renderSubToolbar();
    renderGraph();
    renderInspector();
  }

  function updateSourceUI() {
    const sourceSelect = document.getElementById('source-select');
    const repoInput = document.getElementById('repo-input');
    const patLabel = document.getElementById('pat-label');
    const patInput = document.getElementById('pat-input');

    if (sourceSelect) sourceSelect.value = state.gitSource;
    if (patLabel) patLabel.textContent = state.gitSource === 'gitlab' ? 'Token' : 'Token';
    if (patInput) {
      patInput.placeholder = state.gitSource === 'gitlab' ? 'GitLab Token (optional)' : 'GitHub PAT (optional)';
    }
    if (repoInput && !repoInput.value) {
      repoInput.placeholder = state.gitSource === 'gitlab' ? 'group/project (or GitLab URL)' : 'owner/repo (or GitHub URL)';
    }
  }

  function renderHeader() {
    const sourceSelect = document.getElementById('source-select');
    const repoInput = document.getElementById('repo-input');
    const patInput = document.getElementById('pat-input');

    if (sourceSelect) sourceSelect.value = state.gitSource;
    if (repoInput && document.activeElement !== repoInput) repoInput.value = state.repo;
    if (patInput && document.activeElement !== patInput) patInput.value = state.pat;
    updateSourceUI();
  }

  function renderRateLimit() {
    const pill = document.getElementById('rate-limit-pill');
    if (!pill) return;
    if (state.rateLimit.remaining !== null) {
      pill.style.display = 'inline-flex';
      const label = state.gitSource === 'gitlab' ? 'GitLab API' : 'GitHub API';
      pill.innerHTML = `<span>${label}:</span> <strong>${state.rateLimit.remaining.toLocaleString()} / ${state.rateLimit.limit.toLocaleString()}</strong>`;
      if (state.rateLimit.remaining < 50) {
        pill.style.borderColor = '#f43f5e';
        pill.style.color = '#fecdd3';
      } else {
        pill.style.borderColor = '';
        pill.style.color = '';
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
    fetchCommitsForBranches(state.repo, state.selectedBranches).then(renderGraph);
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

      const isBranchSearchActive = state.activeBranchSearch.has(bName);
      const branchQuery = state.branchSearchQueries.get(bName) || '';
      const branchMatchCount = branchQuery ? bCommits.filter(c => matchCommit(c, branchQuery)).length : 0;

      boardHtml += `
        <div class="branch-column" data-branch="${escapeHtml(bName)}" style="--branch-accent:${color.color}; --rail-line-bg:linear-gradient(180deg, ${color.color}, rgba(255,255,255,0.06));">
          
          <!-- Column Header -->
          <div class="branch-column-header">
            <div class="column-header-top">
              <div class="column-header-title">
                <div class="column-header-dot" style="background:${color.color};"></div>
                <span class="column-branch-name" title="${escapeHtml(bName)}">${escapeHtml(bName)}</span>
                ${bIdx === 0 ? '<span class="badge badge-head-main" style="font-size:9px;">Base</span>' : ''}
              </div>
              <div class="column-header-actions">
                <button class="column-search-toggle ${isBranchSearchActive ? 'active' : ''}" data-branch="${escapeHtml(bName)}" title="Find commit on ${escapeHtml(bName)}">
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                    <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"></path>
                  </svg>
                  <span>Find</span>
                </button>
                <span class="column-commits-badge">${bCommits.length} commits</span>
                <button class="column-close-btn" data-branch="${escapeHtml(bName)}" title="${canDisable ? `Disable ${escapeHtml(bName)} column` : 'At least one branch must remain visible'}" ${canDisable ? '' : 'disabled'}>&times;</button>
              </div>
            </div>

            ${isBranchSearchActive ? `
              <div class="column-inline-search">
                <svg class="search-icon" viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                  <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"></path>
                </svg>
                <input type="text" class="column-search-input" data-branch="${escapeHtml(bName)}" placeholder="Find in ${escapeHtml(bName)}..." value="${escapeHtml(branchQuery)}">
                ${branchQuery ? `<span class="column-search-matches">${branchMatchCount} match${branchMatchCount !== 1 ? 'es' : ''}</span>` : ''}
                <button class="column-search-close" data-branch="${escapeHtml(bName)}" title="Close branch search">&times;</button>
              </div>
            ` : ''}\n
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

          const isGlobalQuery = Boolean(state.globalSearchQuery);
          const isBranchQuery = Boolean(branchQuery);
          const globalMatches = isGlobalQuery && matchCommit(c, state.globalSearchQuery);
          const branchMatches = isBranchQuery && matchCommit(c, branchQuery);
          const isCurrentGlobalMatch = state.currentSearchIndex >= 0 && state.globalSearchResults[state.currentSearchIndex] === c.sha;

          let isDimmed = false;
          if (isBranchQuery && !branchMatches) {
            isDimmed = true;
          } else if (isGlobalQuery && !globalMatches) {
            isDimmed = true;
          }

          let cardSearchClass = '';
          if (isCurrentGlobalMatch) {
            cardSearchClass = 'search-current';
          } else if (globalMatches || branchMatches) {
            cardSearchClass = 'search-match';
          }

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
            <div class="column-timeline-item commit-item ${isSelected ? 'selected' : ''} ${isDimmed ? 'dimmed-by-search' : ''}" data-sha="${c.sha}">
              <div class="column-dot-wrapper">
                <div class="column-commit-dot ${c.isHead ? 'is-head-dot' : ''} ${c.isForkPoint ? 'is-fork-dot' : ''}"
                     data-sha="${c.sha}"
                     data-branch="${escapeHtml(bName)}"
                     style="background:${color.color};"
                     title="${escapeHtml(c.message.split('\n')[0])}">
                </div>
              </div>

              <div class="column-commit-card ${isSelected ? 'active-selected' : ''} ${cardSearchClass}"
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
          const isGlobalQuery = Boolean(state.globalSearchQuery);
          const isBranchQuery = Boolean(branchQuery);
          const hasChainMatch = (isGlobalQuery && row.commits.some(c => matchCommit(c, state.globalSearchQuery)))
                             || (isBranchQuery && row.commits.some(c => matchCommit(c, branchQuery)));
          const isChainDimmed = (isGlobalQuery || isBranchQuery) && !hasChainMatch;

          boardHtml += `
            <div class="column-timeline-item collapsed-item ${isChainDimmed ? 'dimmed-by-search' : ''}" data-chain-id="${row.chainId}">
              <div class="column-dot-wrapper">
                <div class="column-collapsed-marker" style="border-color:${color.color};" title="${row.count} commits collapsed"></div>
              </div>

              <div class="column-collapsed-card ${hasChainMatch ? 'has-search-match' : ''}" data-chain-id="${row.chainId}" style="border-left: 3px dashed ${color.color}; background: #0d1117;">
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
              const innerGlobalMatches = isGlobalQuery && matchCommit(innerCommit, state.globalSearchQuery);
              const innerBranchMatches = isBranchQuery && matchCommit(innerCommit, branchQuery);
              const isCurrentInnerMatch = state.currentSearchIndex >= 0 && state.globalSearchResults[state.currentSearchIndex] === innerCommit.sha;
              let isInnerDimmed = false;
              if (isBranchQuery && !innerBranchMatches) isInnerDimmed = true;
              else if (isGlobalQuery && !innerGlobalMatches) isInnerDimmed = true;

              let innerCardSearchClass = '';
              if (isCurrentInnerMatch) innerCardSearchClass = 'search-current';
              else if (innerGlobalMatches || innerBranchMatches) innerCardSearchClass = 'search-match';

              boardHtml += `
                <div class="column-timeline-item commit-item expanded-subcommit ${isInnerDimmed ? 'dimmed-by-search' : ''}" data-sha="${innerCommit.sha}">
                  <div class="column-dot-wrapper">
                    <div class="column-commit-dot" style="background:${color.color}; width:10px; height:10px;" data-sha="${innerCommit.sha}"></div>
                  </div>
                  <div class="column-commit-card subcommit-card ${innerCardSearchClass}" data-sha="${innerCommit.sha}" style="border-left-color:${color.color};">
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

      const isReachedBottom = state.branchReachedBottom.has(bName);
      const isLoadingMore = state.branchLoadingMore.has(bName);

      let footerBtnHtml = '';
      if (isReachedBottom) {
        footerBtnHtml = `
          <button class="btn-load-more-commits reached-bottom" data-branch="${escapeHtml(bName)}" disabled title="Branch root reached. No earlier commits exist.">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" style="margin-right:6px;">
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path>
            </svg>
            <span>Branch Root Reached</span>
          </button>
        `;
      } else {
        footerBtnHtml = `
          <button class="btn-load-more-commits" data-branch="${escapeHtml(bName)}" ${isLoadingMore ? 'disabled' : ''}>
            ${isLoadingMore ? '<span>Loading commits...</span>' : `<span>&darr; Load More Commits (+${state.commitsDepth})</span>`}
          </button>
        `;
      }

      boardHtml += `
            <div class="column-footer-actions">
              ${footerBtnHtml}
            </div>
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
    setTimeout(() => renderInterColumnSvg(), 60);
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

      // Find parent dot element with resilient fallbacks
      let parentDot = board.querySelector(`.column-commit-dot[data-sha="${parentCommit.sha}"]`);
      if (!parentDot) {
        const parentCard = board.querySelector(`.column-commit-card[data-sha="${parentCommit.sha}"]`);
        if (parentCard) {
          parentDot = parentCard.closest('.column-timeline-item')?.querySelector('.column-dot-wrapper') || parentCard;
        } else {
          parentDot = board.querySelector(`.branch-column[data-branch="${parentCommit.branch}"] .column-rail-line`);
        }
      }
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

    // Inline branch search toggle button
    document.querySelectorAll('.column-search-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bName = btn.getAttribute('data-branch');
        if (bName) toggleBranchSearch(bName);
      });
    });

    // Inline branch search input
    document.querySelectorAll('.column-search-input').forEach(input => {
      input.addEventListener('input', (e) => {
        const bName = input.getAttribute('data-branch');
        if (bName) setBranchSearchQuery(bName, e.target.value);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          const bName = input.getAttribute('data-branch');
          if (bName) toggleBranchSearch(bName);
        }
      });
      input.addEventListener('click', (e) => e.stopPropagation());
    });

    // Inline branch search close button
    document.querySelectorAll('.column-search-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bName = btn.getAttribute('data-branch');
        if (bName) toggleBranchSearch(bName);
      });
    });

    // Load More Commits button click (ignore if reached bottom)
    document.querySelectorAll('.btn-load-more-commits:not(.reached-bottom)').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bName = btn.getAttribute('data-branch');
        if (bName && !state.branchReachedBottom.has(bName)) {
          loadMoreCommits(bName);
        }
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
    const isGitLab = state.gitSource === 'gitlab';
    const commitUrl = isGitLab
      ? `${state.repoInfo?.web_url || (state.gitHost || 'https://gitlab.com') + '/' + state.repo}/-/commit/${c.sha}`
      : `https://github.com/${state.repo}/commit/${c.sha}`;
    const sourceLabel = isGitLab ? 'GitLab' : 'GitHub';

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
        <a class="btn btn-primary" style="width:100%; justify-content:center;" 
           href="${escapeHtml(commitUrl)}" target="_blank" rel="noopener">
          View on ${sourceLabel} &rarr;
        </a>
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
        const isPrimaryDefault = ['master', 'main'].includes(b.name.toLowerCase()) || b.default;
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
    const sourceSelect = document.getElementById('source-select');
    const repoInput = document.getElementById('repo-input');
    const patInput = document.getElementById('pat-input');
    const btnLoadRepo = document.getElementById('btn-load-repo');
    const btnExpandAll = document.getElementById('btn-expand-all');
    const btnCollapseAll = document.getElementById('btn-collapse-all');

    if (sourceSelect) {
      sourceSelect.value = state.gitSource;
      sourceSelect.addEventListener('change', (e) => {
        const newSource = e.target.value;
        state.gitSource = newSource;
        localStorage.setItem('git_source', newSource);
        updateSourceUI();

        // If repository field matches default of opposite source, switch to reasonable default
        if (newSource === 'gitlab' && (!repoInput?.value || repoInput.value === 'herdrdev/herdr')) {
          state.repo = 'gitlab-org/gitlab-runner';
          if (repoInput) repoInput.value = state.repo;
        } else if (newSource === 'github' && (!repoInput?.value || repoInput.value === 'gitlab-org/gitlab-runner')) {
          state.repo = 'herdrdev/herdr';
          if (repoInput) repoInput.value = state.repo;
        }

        if (state.repo) {
          loadRepository(state.repo);
        }
      });
    }

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
        if (!repoVal) {
          alert('Please enter a repository (e.g. "owner/repo" or full URL)');
          return;
        }
        loadRepository(repoVal);
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

    // Filter mode buttons: Smart vs All Commits
    const btnModeSmart = document.getElementById('btn-mode-smart');
    const btnModeAll = document.getElementById('btn-mode-all');

    if (btnModeSmart && btnModeAll) {
      btnModeSmart.addEventListener('click', () => {
        state.filterMode = 'smart';
        btnModeSmart.classList.add('active');
        btnModeAll.classList.remove('active');
        renderGraph();
      });

      btnModeAll.addEventListener('click', () => {
        state.filterMode = 'all';
        btnModeAll.classList.add('active');
        btnModeSmart.classList.remove('active');
        renderGraph();
      });
    }

    // Depth Selector
    const commitDepthSelect = document.getElementById('commit-depth-select');
    if (commitDepthSelect) {
      commitDepthSelect.value = state.commitsDepth.toString();
      commitDepthSelect.addEventListener('change', (e) => {
        state.commitsDepth = parseInt(e.target.value, 10);
        if (state.repo) {
          fetchCommitsForBranches(state.repo, state.selectedBranches).then(renderGraph);
        } else {
          renderGraph();
        }
      });
    }

    // Global Find Commit Tool Listeners
    const globalSearchInput = document.getElementById('global-search-input');
    const btnClearGlobalSearch = document.getElementById('btn-clear-global-search');
    const btnPrevMatch = document.getElementById('btn-prev-match');
    const btnNextMatch = document.getElementById('btn-next-match');

    if (globalSearchInput) {
      globalSearchInput.addEventListener('input', (e) => {
        applyGlobalSearch(e.target.value);
      });
      globalSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) {
            navigateSearchMatch(-1);
          } else {
            navigateSearchMatch(1);
          }
        } else if (e.key === 'Escape') {
          clearGlobalSearch();
          globalSearchInput.blur();
        }
      });
    }

    if (btnClearGlobalSearch) {
      btnClearGlobalSearch.addEventListener('click', () => {
        clearGlobalSearch();
        globalSearchInput?.focus();
      });
    }

    if (btnPrevMatch) {
      btnPrevMatch.addEventListener('click', () => {
        navigateSearchMatch(-1);
      });
    }

    if (btnNextMatch) {
      btnNextMatch.addEventListener('click', () => {
        navigateSearchMatch(1);
      });
    }

    // Global keyboard shortcut '/' to focus find
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        if (globalSearchInput) {
          globalSearchInput.focus();
          globalSearchInput.select();
        }
      }
    });

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

    updateSourceUI();

    // Directly fetch from Git source
    if (state.repo) {
      loadRepository(state.repo);
    }
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
