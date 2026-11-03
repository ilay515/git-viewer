// GitBranch Lens: Client-Only Git Branch Divergence Viewer
// Pure client-side implementation with zero backend dependencies

(function () {
  'use strict';

  // --- STATE ---
  const state = {
    pat: sessionStorage.getItem('git_pat') || localStorage.getItem('git_pat') || '',
    repo: localStorage.getItem('git_repo') || 'tailwindlabs/tailwindcss',
    branches: [],
    selectedBranches: ['main', 'dev'],
    commitsMap: new Map(), // sha -> commit object
    displayRows: [],       // computed list of render items (commits or collapsed chains)
    expandedChains: new Set(), // set of chain IDs currently expanded
    selectedCommit: null,
    isDemo: false,
    loading: false,
    rateLimit: { remaining: null, limit: null },
    filterMode: 'smart', // 'smart' (tips & diversions) | 'all'
  };

  // Branch Color Palette
  const BRANCH_COLORS = [
    { name: 'main', color: '#6366f1', light: '#a5b4fc', bg: 'rgba(99, 102, 241, 0.15)' },
    { name: 'master', color: '#6366f1', light: '#a5b4fc', bg: 'rgba(99, 102, 241, 0.15)' },
    { name: 'dev', color: '#10b981', light: '#6ee7b7', bg: 'rgba(16, 185, 129, 0.15)' },
    { name: 'develop', color: '#10b981', light: '#6ee7b7', bg: 'rgba(16, 185, 129, 0.15)' },
    { name: 'staging', color: '#06b6d4', light: '#67e8f9', bg: 'rgba(6, 182, 212, 0.15)' },
    { name: 'feature', color: '#f59e0b', light: '#fde68a', bg: 'rgba(245, 158, 11, 0.15)' },
    { name: 'hotfix', color: '#f43f5e', light: '#fecdd3', bg: 'rgba(244, 63, 94, 0.15)' },
    { name: 'default', color: '#a855f7', light: '#e9d5ff', bg: 'rgba(168, 85, 247, 0.15)' },
  ];

  function getBranchColor(branchName) {
    const lower = branchName.toLowerCase();
    for (const b of BRANCH_COLORS) {
      if (lower === b.name || lower.startsWith(b.name + '/') || lower.includes(b.name)) {
        return b;
      }
    }
    return BRANCH_COLORS[BRANCH_COLORS.length - 1];
  }

  // --- DEMO FIXTURE GENERATOR ---
  function generateDemoData() {
    const commits = [];
    const now = Date.now();
    const hour = 3600 * 1000;
    const day = 24 * hour;

    // Common Ancestor (Fork Point)
    const forkCommit = {
      sha: '7e91ac4d52e1b89',
      shortSha: '7e91ac4',
      message: 'release: v3.4.15 stable tag\n\nOfficial maintenance release with core stability improvements.',
      author: { name: 'Robin Malfait', login: 'robin-m', avatar: 'https://avatars.githubusercontent.com/u/1834467' },
      date: new Date(now - 8 * day).toISOString(),
      parents: ['3a09b11'],
      branch: 'main',
      stats: { additions: 154, deletions: 42 },
      isForkPoint: true,
      forkChildren: ['main', 'dev'],
    };

    // Commits on main after fork point
    const mainIntermediate = [];
    for (let i = 1; i <= 14; i++) {
      mainIntermediate.push({
        sha: `m${i}a01f83c9${i}`,
        shortSha: `m${i}a01f8`,
        message: `fix(core): patch patchline regression #${1040 + i}`,
        author: { name: 'Adam Wathan', login: 'adamwathan', avatar: 'https://avatars.githubusercontent.com/u/4323180' },
        date: new Date(now - (7 * day) + (i * 8 * hour)).toISOString(),
        parents: [i === 1 ? forkCommit.sha : `m${i-1}a01f83c9${i-1}`],
        branch: 'main',
        stats: { additions: 12 + i, deletions: 3 + (i % 4) },
      });
    }

    const mainHead = {
      sha: '9a01f83b271d440',
      shortSha: '9a01f83',
      message: 'fix(types): correct TypeScript declaration for arbitrary variants\n\nFixes #12940 where arbitrary variable modifiers failed type checking.',
      author: { name: 'Adam Wathan', login: 'adamwathan', avatar: 'https://avatars.githubusercontent.com/u/4323180' },
      date: new Date(now - 1 * day).toISOString(),
      parents: [mainIntermediate[mainIntermediate.length - 1].sha],
      branch: 'main',
      stats: { additions: 18, deletions: 4 },
      isHead: true,
    };

    // Commits on dev after fork point
    const devDiversionStart = {
      sha: 'c310ad59f03d881',
      shortSha: 'c310ad5',
      message: 'refactor(oxide): initialize next-gen engine parser core\n\nFirst milestone commit for the Oxide Rust pipeline integration.',
      author: { name: 'Jordan Pittman', login: 'reinink', avatar: 'https://avatars.githubusercontent.com/u/882133' },
      date: new Date(now - 6 * day).toISOString(),
      parents: [forkCommit.sha],
      branch: 'dev',
      stats: { additions: 640, deletions: 80 },
      isDiversionStart: true,
    };

    const devIntermediate = [];
    for (let i = 1; i <= 32; i++) {
      devIntermediate.push({
        sha: `d${i}b48f912e${i}`,
        shortSha: `d${i}b48f9`,
        message: `feat(v4): internal transformer optimization step ${i}`,
        author: { name: 'Jordan Pittman', login: 'reinink', avatar: 'https://avatars.githubusercontent.com/u/882133' },
        date: new Date(now - (5 * day) + (i * 3 * hour)).toISOString(),
        parents: [i === 1 ? devDiversionStart.sha : `d${i-1}b48f912e${i-1}`],
        branch: 'dev',
        stats: { additions: 25 + (i * 2), deletions: 10 },
      });
    }

    const devHead = {
      sha: 'b48f91263d890ac',
      shortSha: 'b48f912',
      message: 'feat(v4): add container query native utility syntax\n\nSupports `@container (min-width: 400px)` directly in className bindings.',
      author: { name: 'Adam Wathan', login: 'adamwathan', avatar: 'https://avatars.githubusercontent.com/u/4323180' },
      date: new Date(now - 2 * hour).toISOString(),
      parents: [devIntermediate[devIntermediate.length - 1].sha],
      branch: 'dev',
      stats: { additions: 142, deletions: 18 },
      isHead: true,
    };

    return {
      branches: [
        { name: 'main', commit: { sha: mainHead.sha } },
        { name: 'dev', commit: { sha: devHead.sha } },
        { name: 'feature/tokens', commit: { sha: 'f991ac4' } },
        { name: 'v3-legacy', commit: { sha: '3a09b11' } },
      ],
      commits: [
        devHead,
        ...devIntermediate.reverse(),
        devDiversionStart,
        mainHead,
        ...mainIntermediate.reverse(),
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
        if (errJson.message) errMsg = errJson.message;
      } catch (e) {}
      throw new Error(errMsg);
    }

    return await resp.json();
  }

  async function loadRepository(ownerRepo) {
    state.loading = true;
    renderStatus(`Fetching repository ${ownerRepo}...`);

    try {
      // 1. Fetch branches
      const branchesData = await fetchGitHub(`/repos/${ownerRepo}/branches?per_page=100`);
      state.branches = branchesData;

      // 2. Default branches: select main/master and dev/develop
      const names = branchesData.map(b => b.name);
      const defaultPrimary = names.find(n => n === 'main' || n === 'master') || names[0];
      const defaultSecondary = names.find(n => n === 'dev' || n === 'develop') || (names.length > 1 ? names.find(n => n !== defaultPrimary) : null);

      state.selectedBranches = [defaultPrimary];
      if (defaultSecondary) state.selectedBranches.push(defaultSecondary);

      // 3. Fetch commits & compare
      await fetchCommitsForBranches(ownerRepo, state.selectedBranches);

      state.isDemo = false;
      state.loading = false;
      renderApp();
    } catch (err) {
      state.loading = false;
      console.error(err);
      alert(`Could not load repo: ${err.message}\nTip: Ensure the repo name is correct and your token has repository access permissions.`);
      renderApp();
    }
  }

  async function fetchCommitsForBranches(ownerRepo, selectedBranchNames) {
    state.commitsMap.clear();

    if (selectedBranchNames.length === 2) {
      const [base, head] = selectedBranchNames;
      // Compare API provides merge base and ahead commits
      try {
        const compare = await fetchGitHub(`/repos/${ownerRepo}/compare/${base}...${head}`);
        
        // Merge base
        const mergeBase = compare.merge_base_commit;
        if (mergeBase) {
          const mbObj = formatGitHubCommit(mergeBase, base);
          mbObj.isForkPoint = true;
          mbObj.forkChildren = [base, head];
          state.commitsMap.set(mbObj.sha, mbObj);
        }

        // Head branch commits
        if (compare.commits && compare.commits.length > 0) {
          compare.commits.forEach((c, idx) => {
            const commitObj = formatGitHubCommit(c, head);
            if (idx === 0) commitObj.isDiversionStart = true;
            if (idx === compare.commits.length - 1) commitObj.isHead = true;
            state.commitsMap.set(commitObj.sha, commitObj);
          });
        }
      } catch (e) {
        console.warn('Compare API fallback to direct branch commits:', e);
      }
    }

    // Also fetch recent commits for each branch to ensure full linear chains
    for (const bName of selectedBranchNames) {
      try {
        const list = await fetchGitHub(`/repos/${ownerRepo}/commits?sha=${encodeURIComponent(bName)}&per_page=35`);
        list.forEach((c, idx) => {
          if (!state.commitsMap.has(c.sha)) {
            const commitObj = formatGitHubCommit(c, bName);
            if (idx === 0) commitObj.isHead = true;
            state.commitsMap.set(commitObj.sha, commitObj);
          } else {
            // Merge branch association
            const existing = state.commitsMap.get(c.sha);
            if (idx === 0) existing.isHead = true;
          }
        });
      } catch (e) {
        console.error(`Error loading branch ${bName}:`, e);
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
      // Return flat commits list without collapse
      return commits.map(c => ({ type: 'commit', commit: c }));
    }

    // Collapse linear chains between anchors
    const rows = [];
    let currentChain = [];

    function flushChain() {
      if (currentChain.length === 0) return;

      if (currentChain.length <= 1) {
        // Only 1 commit, no need to collapse
        currentChain.forEach(c => rows.push({ type: 'commit', commit: c }));
      } else {
        const chainId = `chain-${currentChain[0].sha}-${currentChain[currentChain.length - 1].sha}`;
        const isExpanded = state.expandedChains.has(chainId);

        // Aggregate stats
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
          branch: currentChain[0].branch || 'linear',
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
        // Flush any pending chain before placing this anchor
        flushChain();
        rows.push({ type: 'commit', commit: c });
      } else {
        // Non-anchor commit: check if branch matches current chain
        if (currentChain.length > 0 && currentChain[0].branch !== c.branch) {
          flushChain();
        }
        currentChain.push(c);
      }
    }

    flushChain();
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

    state.selectedBranches.forEach(branchName => {
      const color = getBranchColor(branchName);
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
    const totalCount = state.branches.length || (state.isDemo ? 4 : 0);
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
          <div>Loading commits and calculating divergence graph...</div>
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
          <p>Enter a repository name &amp; PAT above or click "Load Demo" to see the graph in action.</p>
        </div>
      `;
      return;
    }

    let html = `<div class="git-graph-view" id="graph-nodes-container">`;
    html += `<svg class="graph-track-svg" id="graph-track-svg"></svg>`;

    // Column rail positioning
    const branchCols = new Map();
    state.selectedBranches.forEach((name, idx) => {
      branchCols.set(name, 24 + idx * 34);
    });

    state.displayRows.forEach((row, rowIndex) => {
      if (row.type === 'commit') {
        const c = row.commit;
        const color = getBranchColor(c.branch || state.selectedBranches[0]);
        const isSelected = state.selectedCommit && state.selectedCommit.sha === c.sha;

        let badgeHtml = '';
        if (c.isHead) {
          const badgeClass = c.branch === 'dev' ? 'badge-head-dev' : 'badge-head-main';
          badgeHtml = `<span class="badge ${badgeClass}">${escapeHtml(c.branch)} HEAD</span>`;
        } else if (c.isForkPoint) {
          badgeHtml = `<span class="badge badge-fork">&#x2934; Common Ancestor (Fork Point)</span>`;
        } else if (c.isDiversionStart) {
          badgeHtml = `<span class="badge badge-diverge">First commit on ${escapeHtml(c.branch)}</span>`;
        } else if (c.isMerge) {
          badgeHtml = `<span class="badge badge-merge">&#x2935; Merge Commit</span>`;
        }

        const dateStr = formatRelativeDate(c.date);
        const colX = branchCols.get(c.branch) || 24;

        html += `
          <div class="graph-node-row" data-row-idx="${rowIndex}" data-sha="${c.sha}">
            <div class="graph-rails-cell">
              <div class="commit-dot" 
                   data-sha="${c.sha}"
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

        if (row.isExpanded) {
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

        html += `</div>`;
      }
    });

    html += `</div>`;
    viewport.innerHTML = html;

    // Attach listeners
    attachGraphListeners();

    // Render SVG connecting rails
    requestAnimationFrame(() => renderSvgRails(branchCols));
  }

  function renderSvgRails(branchCols) {
    const svg = document.getElementById('graph-track-svg');
    const container = document.getElementById('graph-nodes-container');
    if (!svg || !container) return;

    const dots = container.querySelectorAll('.commit-dot');
    if (dots.length === 0) return;

    svg.setAttribute('width', '90');
    svg.setAttribute('height', container.offsetHeight.toString());

    let svgContent = '';
    const dotCoords = [];

    dots.forEach(dot => {
      const sha = dot.getAttribute('data-sha');
      const c = state.commitsMap.get(sha);
      if (!c) return;

      const dotRect = dot.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();

      const cx = (dotRect.left + dotRect.width / 2) - containerRect.left;
      const cy = (dotRect.top + dotRect.height / 2) - containerRect.top;

      dotCoords.push({ sha, cx, cy, commit: c });
    });

    // Draw lines between parent-child commits
    dotCoords.forEach(curr => {
      if (!curr.commit.parents) return;

      curr.commit.parents.forEach(pSha => {
        const parentCoord = dotCoords.find(d => d.sha === pSha);
        if (parentCoord) {
          const color = getBranchColor(curr.commit.branch || 'main').color;

          if (Math.abs(curr.cx - parentCoord.cx) < 5) {
            // Straight vertical line on same branch rail
            svgContent += `
              <line x1="${curr.cx}" y1="${curr.cy}" 
                    x2="${parentCoord.cx}" y2="${parentCoord.cy}" 
                    stroke="${color}" stroke-width="2.5" stroke-linecap="round" />
            `;
          } else {
            // Curved Bézier curve representing branch diversion or merge
            const midY = (curr.cy + parentCoord.cy) / 2;
            svgContent += `
              <path d="M ${curr.cx} ${curr.cy} C ${curr.cx} ${midY}, ${parentCoord.cx} ${midY}, ${parentCoord.cx} ${parentCoord.cy}" 
                    fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="4 3" />
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
      card.addEventListener('click', (e) => {
        const sha = card.getAttribute('data-sha');
        if (sha && state.commitsMap.has(sha)) {
          state.selectedCommit = state.commitsMap.get(sha);
          renderInspector();
          renderGraph(); // update active highlight
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
    const color = getBranchColor(c.branch || 'main');

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
        { name: 'main' }, { name: 'dev' }, { name: 'feature/tokens' }, { name: 'v3-legacy' }
      ];

      const filtered = allBranches.filter(b => b.name.toLowerCase().includes(q));

      listContainer.innerHTML = filtered.map(b => {
        const isSelected = state.selectedBranches.includes(b.name);
        return `
          <div class="branch-item-row ${isSelected ? 'selected' : ''}" data-name="${escapeHtml(b.name)}">
            <span style="font-weight:500; font-size:12px;">${escapeHtml(b.name)}</span>
            <span style="font-size:12px;">${isSelected ? '&#x2714; Visible' : '+ Add'}</span>
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
      searchInput.oninput = (e) => renderList(e.target.value);
    }

    const closeBtn = document.getElementById('modal-close-btn');
    if (closeBtn) closeBtn.onclick = () => modal.classList.remove('open');
  }

  // --- INITIALIZATION ---
  function init() {
    // Event listeners
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
          alert('Please enter a valid GitHub repository in "owner/repo" format (e.g. facebook/react)');
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

    // Modal background close
    const modal = document.getElementById('branch-modal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('open');
      });
    }

    // Window resize -> redraw SVG track curves
    window.addEventListener('resize', () => {
      const branchCols = new Map();
      state.selectedBranches.forEach((name, idx) => {
        branchCols.set(name, 24 + idx * 34);
      });
      renderSvgRails(branchCols);
    });

    // Start with offline demo data initially so user instantly sees working graph
    loadDemoMode();
  }

  function loadDemoMode() {
    state.isDemo = true;
    state.repo = 'tailwindlabs/tailwindcss (Demo)';
    const demo = generateDemoData();
    state.branches = demo.branches;
    state.selectedBranches = ['main', 'dev'];
    state.commitsMap.clear();
    demo.commits.forEach(c => state.commitsMap.set(c.sha, c));
    state.expandedChains.clear();
    state.selectedCommit = null;
    renderStatus('Showing interactive offline demo with automatic linear commit collapse');
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
