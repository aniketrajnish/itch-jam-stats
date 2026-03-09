(function () {
  const MIN_RESULTS_COVERAGE_RATIO = 0.8;
  const THEME_MEDIA_QUERY = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

  const INDEX_COLUMN = {
    key: "rowIndex",
    label: "#",
    kind: "index",
    sortable: false,
  };

  const BASE_COLUMNS = [
    {
      key: "gameName",
      label: "game name",
      kind: "text",
      defaultSortDir: "asc",
    },
    {
      key: "contributors",
      label: "contributors",
      kind: "text",
      defaultSortDir: "asc",
    },
    {
      key: "popularity",
      label: "popularity",
      kind: "rank",
      defaultSortDir: "desc",
    },
    {
      key: "totalRating",
      label: "total rating",
      kind: "number",
      defaultSortDir: "desc",
    },
    {
      key: "coolness",
      label: "coolness",
      title: "max(votes_given - disqualified_votes) across all contributors",
      kind: "number",
      defaultSortDir: "desc",
    },
    {
      key: "karma",
      label: "karma",
      title: "log(1 + coolness) - (log(1 + votes_received) / log(5))",
      kind: "number",
      defaultSortDir: "desc",
    },
    {
      key: "platforms",
      label: "platforms",
      kind: "text",
      defaultSortDir: "asc",
    },
  ];

  const state = {
    isLoading: false,
    rows: [],
    meta: null,
    sortKey: "popularity",
    sortDir: "desc",
    platformFilters: new Set(),
  };

  const elements = {
    jamInput: document.getElementById("jam-input"),
    loadButton: document.getElementById("load-button"),
    exampleButton: document.getElementById("example-button"),
    status: document.getElementById("status"),
    searchInput: document.getElementById("search-input"),
    summary: document.getElementById("summary"),
    tableScrollTop: document.getElementById("table-scroll-top"),
    tableScrollSpacer: document.getElementById("table-scroll-spacer"),
    tableWrap: document.getElementById("table-wrap"),
    table: document.getElementById("results-table"),
    tableHead: document.getElementById("table-head"),
    tableBody: document.getElementById("table-body"),
  };
  const apiBase = getApiBase();
  let tableScrollSyncFrame = 0;
  let isSyncingTableScroll = false;

  function getSystemTheme() {
    return THEME_MEDIA_QUERY && THEME_MEDIA_QUERY.matches ? "dark" : "light";
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
  }

  function syncThemeWithSystem() {
    applyTheme(getSystemTheme());
  }

  function getApiBase() {
    const metaValue = document
      .querySelector('meta[name="jam-stats-api-base"]')
      ?.getAttribute("content");
    const globalValue = typeof window.JAM_STATS_API_BASE === "string"
      ? window.JAM_STATS_API_BASE
      : "";

    return String(globalValue || metaValue || "").trim().replace(/\/+$/g, "");
  }

  function getEntriesApiUrl(input) {
    const query = `input=${encodeURIComponent(input)}`;
    return apiBase
      ? `${apiBase}/api/entries?${query}`
      : `/api/entries?${query}`;
  }

  function getLoadErrorMessage(error) {
    const message = error instanceof Error ? error.message : "unable to load entries";

    if (message === "Failed to fetch") {
      return apiBase
        ? `unable to reach api at ${apiBase}`
        : "unable to reach api deploy the cloudflare worker route or set jam-stats-api-base to your api origin";
    }

    return message;
  }

  function getContentType(response) {
    return String(response.headers.get("content-type") || "").toLowerCase();
  }

  function getJamLabel(payload) {
    const slug = String(payload?.jamSlug || "").trim();
    if (slug) {
      return slug;
    }

    const jamId = String(payload?.jamId || "").trim();
    return jamId ? `jam ${jamId}` : "the selected jam";
  }

  function getResultsCoverageInfo(payload) {
    const totalEntries = Array.isArray(payload?.rows) ? payload.rows.length : 0;
    const matchedResultsCount = Number(payload?.matchedResultsCount);
    const normalizedMatchedResultsCount = Number.isFinite(matchedResultsCount) && matchedResultsCount > 0
      ? matchedResultsCount
      : 0;

    return {
      totalEntries,
      matchedResultsCount: normalizedMatchedResultsCount,
      coverageRatio: totalEntries > 0 ? normalizedMatchedResultsCount / totalEntries : 0,
      hasResultCriteria: Array.isArray(payload?.resultCriteria) && payload.resultCriteria.length > 0,
    };
  }

  function shouldShowResultColumns(payload) {
    const coverage = getResultsCoverageInfo(payload);

    if (!coverage.hasResultCriteria || coverage.totalEntries <= 0) {
      return false;
    }

    return coverage.matchedResultsCount >= coverage.totalEntries * MIN_RESULTS_COVERAGE_RATIO;
  }

  function getResultsCoverageMessage(payload) {
    const coverage = getResultsCoverageInfo(payload);

    if (coverage.matchedResultsCount <= 0 || coverage.totalEntries <= 0) {
      return "";
    }

    if (!shouldShowResultColumns(payload)) {
      return ` results hidden because public ranks are only available for ${formatInteger(coverage.matchedResultsCount)} of ${formatInteger(coverage.totalEntries)} entries`;
    }

    if (coverage.matchedResultsCount >= coverage.totalEntries) {
      return "";
    }

    return ` public results available for ${formatInteger(coverage.matchedResultsCount)} of ${formatInteger(coverage.totalEntries)} entries`;
  }

  async function readJsonResponse(response) {
    const contentType = getContentType(response);
    const text = await response.text();

    if (!contentType.includes("application/json")) {
      if (!apiBase) {
        throw new Error("missing api route deploy the cloudflare worker route or set jam-stats-api-base to your api origin");
      }

      throw new Error(`api at ${apiBase} returned ${contentType || "non-json content"}`);
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      if (!apiBase) {
        throw new Error("api response was not valid json");
      }

      throw new Error(`api at ${apiBase} returned invalid json`);
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatInteger(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return "-";
    }

    return Number(value).toLocaleString();
  }

  function formatPopularity(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return "-";
    }

    return `#${formatInteger(value)}`;
  }

  function formatKarma(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return "-";
    }

    return Number(value).toFixed(3);
  }

  function setStatus(message, tone) {
    elements.status.textContent = message;
    elements.status.className = "status";
    if (tone) {
      elements.status.classList.add(tone);
    }
  }

  function setBusy(isBusy) {
    elements.loadButton.disabled = isBusy;
    elements.exampleButton.disabled = isBusy;
    elements.jamInput.disabled = isBusy;
  }

  function getPlatformKey(platform) {
    const value = String(platform || "").trim().toLowerCase();

    if (value === "osx" || value === "mac" || value === "macos") {
      return "macos";
    }

    return value;
  }

  function getPlatformLabel(platform) {
    const key = getPlatformKey(platform);

    if (key === "macos") {
      return "macos";
    }

    return key || "other";
  }

  function getColumns() {
    const resultColumns = shouldShowResultColumns(state.meta) && Array.isArray(state.meta?.resultCriteria)
      ? state.meta.resultCriteria.map((criterion) => ({
          key: criterion.key,
          label: `${String(criterion.name || "").toLowerCase()} rank`,
          title: String(criterion.title || "").trim()
            || `rank for ${criterion.name} from itch.io results.json following the same finished-jam results feed used by itch-analytics`,
          kind: "rank",
          defaultSortDir: "desc",
        }))
      : [];

    return [
      INDEX_COLUMN,
      BASE_COLUMNS[0],
      BASE_COLUMNS[1],
      BASE_COLUMNS[2],
      ...resultColumns,
      BASE_COLUMNS[3],
      BASE_COLUMNS[4],
      BASE_COLUMNS[5],
      BASE_COLUMNS[6],
    ];
  }

  function getColumn(key) {
    return getColumns().find((column) => column.key === key) || null;
  }

  function getDefaultSortDir(key) {
    return getColumn(key)?.defaultSortDir || "asc";
  }

  function isRankColumn(key) {
    return getColumn(key)?.kind === "rank";
  }

  function ensureValidSortKey() {
    if (getColumn(state.sortKey)) {
      return;
    }

    state.sortKey = "popularity";
    state.sortDir = getDefaultSortDir("popularity");
  }

  function getSortValue(row, key) {
    if (key === "contributors") {
      return row.contributorsText;
    }

    if (key === "platforms") {
      return row.platformsText;
    }

    return row[key];
  }

  function compareRows(left, right) {
    const leftValue = getSortValue(left, state.sortKey);
    const rightValue = getSortValue(right, state.sortKey);
    const direction = state.sortDir === "asc" ? 1 : -1;

    if (isRankColumn(state.sortKey)) {
      const leftRank = Number(leftValue);
      const rightRank = Number(rightValue);

      if (!Number.isFinite(leftRank)) {
        return Number.isFinite(rightRank) ? 1 : 0;
      }

      if (!Number.isFinite(rightRank)) {
        return -1;
      }

      if (state.sortDir === "desc") {
        return leftRank - rightRank;
      }

      return rightRank - leftRank;
    }

    if (leftValue === null || leftValue === undefined) {
      return rightValue === null || rightValue === undefined ? 0 : 1;
    }

    if (rightValue === null || rightValue === undefined) {
      return -1;
    }

    if (typeof leftValue === "number" && typeof rightValue === "number") {
      return (leftValue - rightValue) * direction;
    }

    return String(leftValue).localeCompare(String(rightValue), undefined, {
      sensitivity: "base",
      numeric: true,
    }) * direction;
  }

  function getRankedRows() {
    const filteredRows = state.rows.filter((row) => {
      const matchesPlatform = !state.platformFilters.size
        || row.platforms.some((platform) => state.platformFilters.has(getPlatformKey(platform)));

      return matchesPlatform;
    });

    filteredRows.sort(compareRows);
    return filteredRows.map((row, index) => ({
      row,
      rank: index + 1,
    }));
  }

  function getVisibleRows() {
    const query = elements.searchInput.value.trim().toLowerCase();

    return getRankedRows().filter(({ row }) => !query || row.searchableText.includes(query));
  }

  function renderContributors(row) {
    if (!row.contributors.length) {
      return "-";
    }

    return row.contributors
      .map((contributor) => {
        const label = escapeHtml(contributor.name);
        if (!contributor.url) {
          return label;
        }

        return `<a href="${escapeHtml(contributor.url)}" target="_blank" rel="noreferrer">${label}</a>`;
      })
      .join(", ");
  }

  function renderPlatforms(row) {
    if (!row.platforms.length) {
      return "-";
    }

    return row.platforms
      .map((platform) => {
        const key = getPlatformKey(platform);
        const label = escapeHtml(getPlatformLabel(platform));
        const icon = getPlatformIcon(platform);
        const isActive = state.platformFilters.has(key);
        const title = isActive ? `remove ${label} filter` : `filter by ${label}`;
        return `<button class="platform-icon${isActive ? " active" : ""}" type="button" data-platform="${escapeHtml(key)}" title="${title}" aria-label="${title}" aria-pressed="${isActive ? "true" : "false"}">${icon}</button>`;
      })
      .join("");
  }

  function getPlatformIcon(platform) {
    const key = String(platform || "").toLowerCase();

    if (key === "web") {
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm4.9 6h-2.3a11.2 11.2 0 0 0-1-4A5.5 5.5 0 0 1 12.9 7ZM8 2.7c.7.9 1.3 2.4 1.6 4.3H6.4C6.7 5.1 7.3 3.6 8 2.7ZM6.4 3A11.2 11.2 0 0 0 5.4 7H3.1A5.5 5.5 0 0 1 6.4 3Zm-3.3 5.5h2.3c.1 1.4.5 2.8 1 4a5.5 5.5 0 0 1-3.3-4Zm5 4.8c-.7-.9-1.3-2.4-1.6-4.3h3.2c-.3 1.9-.9 3.4-1.6 4.3Zm1.5-.8c.5-1.2.9-2.6 1-4h2.3a5.5 5.5 0 0 1-3.3 4Z"></path></svg>';
    }

    if (key === "windows") {
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 2.5 7 1.7v5.6H1V2.5Zm7 0 7-1v5.8H8V2.5ZM1 8.2h6v5.6l-6-.8V8.2Zm7 0h7V14l-7-1V8.2Z"></path></svg>';
    }

    if (key === "linux") {
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.3c1.6 0 2.4 1.5 2.4 3.5 0 .8-.2 1.6-.5 2.1.9.7 1.7 1.9 1.7 3.3 0 .8-.3 1.4-.8 2 .2.4.4.9.4 1.4 0 1.2-1 2.1-2.2 2.1-.7 0-1.3-.3-1.7-.8-.4.5-1 .8-1.7.8-1.2 0-2.2-.9-2.2-2.1 0-.5.1-1 .4-1.4-.5-.6-.8-1.2-.8-2 0-1.4.8-2.6 1.7-3.3-.3-.5-.5-1.3-.5-2.1C5.6 2.8 6.4 1.3 8 1.3Zm-1 8.1a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Zm2 0a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Zm-1 1.9c-.8 0-1.4.2-1.8.6.4.5 1 .8 1.8.8s1.4-.3 1.8-.8c-.4-.4-1-.6-1.8-.6Z"></path></svg>';
    }

    if (key === "osx" || key === "mac" || key === "macos") {
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.7 8.4c0-1.6 1.3-2.4 1.3-2.4-.7-1-1.9-1.2-2.3-1.2-1-.1-1.9.6-2.4.6-.5 0-1.2-.6-2-.6-1 0-2 .6-2.5 1.5-1.1 1.8-.3 4.6.8 6.2.5.8 1.2 1.7 2 1.7s1.1-.5 2-.5c.8 0 1.1.5 2 .5s1.5-.8 2-1.6c.6-.9.8-1.8.8-1.8-.1 0-1.7-.7-1.7-2.4ZM9.2 3.7c.4-.5.7-1.1.6-1.7-.6 0-1.3.4-1.7.9-.4.4-.7 1.1-.6 1.7.7.1 1.3-.3 1.7-.9Z"></path></svg>';
    }

    if (key === "android") {
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 4.6 4.4 3.3a.4.4 0 1 1 .7-.4l.8 1.3a5 5 0 0 1 4.2 0l.8-1.3a.4.4 0 0 1 .7.4l-.8 1.3c1 .6 1.6 1.6 1.7 2.7H3.5c.1-1.1.7-2.1 1.7-2.7Zm1.4 1.1a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1Zm2.8 0a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1ZM4 7.8h1v4.4c0 .5-.3.8-.8.8s-.8-.3-.8-.8V8.6c0-.4.3-.8.8-.8Zm7 0h1c.4 0 .8.4.8.8v3.6c0 .5-.3.8-.8.8s-.8-.3-.8-.8V7.8Zm-5.2 0h4.4v5.1c0 .6-.5 1.1-1.1 1.1H8.8v1.1c0 .5-.3.9-.8.9s-.8-.4-.8-.9V14h-.3c-.6 0-1.1-.5-1.1-1.1V7.8Z"></path></svg>';
    }

    return '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3"></circle><path d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm0 1.5a5 5 0 1 0 0 10A5 5 0 0 0 8 3Z"></path></svg>';
  }

  function renderCell(row, column, rank) {
    if (column.key === "rowIndex") {
      return `<td class="row-index">${formatInteger(rank)}</td>`;
    }

    if (column.key === "gameName") {
      const projectHref = row.projectUrl ? ` href="${escapeHtml(row.projectUrl)}"` : "";
      const projectTarget = row.projectUrl ? ' target="_blank" rel="noreferrer"' : "";

      return `
        <td>
          <a class="game-link"${projectHref}${projectTarget}>${escapeHtml(row.gameName)}</a>
        </td>
      `;
    }

    if (column.key === "contributors") {
      return `<td><div class="contrib-list">${renderContributors(row)}</div></td>`;
    }

    if (column.key === "popularity") {
      return `<td>${formatPopularity(row.popularity)}</td>`;
    }

    if (column.key === "totalRating") {
      return `<td>${formatInteger(row.totalRating)}</td>`;
    }

    if (column.key === "coolness") {
      return `<td>${formatInteger(row.coolness)}</td>`;
    }

    if (column.key === "karma") {
      return `<td>${formatKarma(row.karma)}</td>`;
    }

    if (column.key === "platforms") {
      return `<td><div class="platforms">${renderPlatforms(row)}</div></td>`;
    }

    return `<td>${formatPopularity(row[column.key])}</td>`;
  }

  function renderTableHead() {
    ensureValidSortKey();

    elements.tableHead.innerHTML = `
      <tr>
        ${getColumns()
          .map((column) => {
            if (column.sortable === false) {
              return `<th class="row-index">${escapeHtml(column.label)}</th>`;
            }

            const isActive = column.key === state.sortKey;
            const title = typeof column.title === "string" ? column.title.trim() : "";
            const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
            return `
              <th>
                <button class="sort${isActive ? " active" : ""}" data-sort="${escapeHtml(column.key)}" type="button"${titleAttr}>
                  ${escapeHtml(column.label)}
                  <span class="sort-indicator" aria-hidden="true">${getSortIcon(isActive ? state.sortDir : "idle")}</span>
                </button>
              </th>
            `;
          })
          .join("")}
      </tr>
    `;

    scheduleTableScrollSync();
  }

  function renderRows() {
    ensureValidSortKey();

    const visibleRows = getVisibleRows();
    const columns = getColumns();
    const columnCount = columns.length;
    const activePlatformLabels = Array.from(state.platformFilters).sort();
    const filterSuffix = activePlatformLabels.length
      ? ` filtered by ${activePlatformLabels.join(", ")}`
      : "";

    if (!state.rows.length) {
      elements.summary.textContent = state.isLoading ? "loading..." : "0 entries";
      elements.tableBody.innerHTML = `<tr><td class="empty" colspan="${columnCount}">${state.isLoading ? "loading jam entries..." : "load a jam to populate the table"}</td></tr>`;
      scheduleTableScrollSync();
      return;
    }

    elements.summary.textContent = `${formatInteger(visibleRows.length)} of ${formatInteger(state.rows.length)} entries${filterSuffix}`;

    if (!visibleRows.length) {
      elements.tableBody.innerHTML = `<tr><td class="empty" colspan="${columnCount}">no entries match the current search or platform filters</td></tr>`;
      scheduleTableScrollSync();
      return;
    }

    elements.tableBody.innerHTML = visibleRows
      .map(({ row, rank }) => `<tr>${columns.map((column) => renderCell(row, column, rank)).join("")}</tr>`)
      .join("");

    scheduleTableScrollSync();
  }

  function getSortIcon(direction) {
    if (direction === "asc") {
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="4" height="1.8" rx=".9"></rect><rect x="3" y="7.1" width="7" height="1.8" rx=".9"></rect><rect x="3" y="11.2" width="10" height="1.8" rx=".9"></rect></svg>';
    }

    if (direction === "desc") {
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="1.8" rx=".9"></rect><rect x="3" y="7.1" width="7" height="1.8" rx=".9"></rect><rect x="3" y="11.2" width="4" height="1.8" rx=".9"></rect></svg>';
    }

    return '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="1.8" rx=".9"></rect><rect x="3" y="7.1" width="10" height="1.8" rx=".9"></rect><rect x="3" y="11.2" width="10" height="1.8" rx=".9"></rect></svg>';
  }

  function render() {
    renderTableHead();
    renderRows();
  }

  function syncTableScroll(source, target) {
    if (isSyncingTableScroll || target.scrollLeft === source.scrollLeft) {
      return;
    }

    isSyncingTableScroll = true;
    target.scrollLeft = source.scrollLeft;
    isSyncingTableScroll = false;
  }

  function updateTableScrollUi() {
    const tableWidth = elements.table.scrollWidth;
    const wrapWidth = elements.tableWrap.clientWidth;
    const hasHorizontalOverflow = tableWidth > wrapWidth + 1;

    elements.tableScrollSpacer.style.width = `${tableWidth}px`;
    elements.tableScrollTop.classList.toggle("active", hasHorizontalOverflow);

    if (!hasHorizontalOverflow) {
      elements.tableScrollTop.scrollLeft = 0;
      return;
    }

    elements.tableScrollTop.scrollLeft = elements.tableWrap.scrollLeft;
  }

  function scheduleTableScrollSync() {
    if (tableScrollSyncFrame) {
      return;
    }

    tableScrollSyncFrame = window.requestAnimationFrame(function () {
      tableScrollSyncFrame = 0;
      updateTableScrollUi();
    });
  }

  async function loadEntries() {
    const input = elements.jamInput.value.trim();
    if (!input) {
      setStatus("enter an itch jam url slug or numeric jam id", "error");
      return;
    }

    setBusy(true);
    state.isLoading = true;
    state.rows = [];
    state.meta = null;
    state.platformFilters.clear();
    elements.searchInput.disabled = true;
    render();
    setStatus("fetching entries...", "");

    try {
      const response = await fetch(getEntriesApiUrl(input));
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(payload.error || "unable to load entries");
      }

      state.rows = Array.isArray(payload.rows) ? payload.rows : [];
      state.meta = payload;
      state.isLoading = false;
      state.platformFilters.clear();
      elements.searchInput.disabled = !state.rows.length;
      render();
      setStatus(`loaded ${formatInteger(state.rows.length)} entries from ${getJamLabel(payload)}${getResultsCoverageMessage(payload)}`, "success");
    } catch (error) {
      state.rows = [];
      state.meta = null;
      state.isLoading = false;
      state.platformFilters.clear();
      elements.searchInput.disabled = true;
      render();
      const message = getLoadErrorMessage(error);
      setStatus(message.replace(/[.!?]+$/g, "").toLowerCase(), "error");
    } finally {
      setBusy(false);
    }
  }

  elements.loadButton.addEventListener("click", loadEntries);

  elements.exampleButton.addEventListener("click", function () {
    elements.jamInput.value = "https://itch.io/jam/brackeys-15";
    loadEntries();
  });

  elements.jamInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      loadEntries();
    }
  });

  elements.searchInput.addEventListener("input", renderRows);

  elements.tableScrollTop.addEventListener("scroll", function () {
    syncTableScroll(elements.tableScrollTop, elements.tableWrap);
  });

  elements.tableWrap.addEventListener("scroll", function () {
    syncTableScroll(elements.tableWrap, elements.tableScrollTop);
  });

  elements.tableBody.addEventListener("click", function (event) {
    const button = event.target.closest("button.platform-icon");
    if (!button) {
      return;
    }

    const key = button.dataset.platform;
    if (!key) {
      return;
    }

    if (state.platformFilters.has(key)) {
      state.platformFilters.delete(key);
    } else {
      state.platformFilters.add(key);
    }

    renderRows();
  });

  elements.tableHead.addEventListener("click", function (event) {
    const button = event.target.closest("button.sort");
    if (!button) {
      return;
    }

    const key = button.dataset.sort;
    if (!key) {
      return;
    }

    if (state.sortKey === key) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      state.sortDir = getDefaultSortDir(key);
    }

    render();
  });

  if (typeof ResizeObserver === "function") {
    const resizeObserver = new ResizeObserver(scheduleTableScrollSync);
    resizeObserver.observe(elements.tableWrap);
    resizeObserver.observe(elements.table);
  } else {
    window.addEventListener("resize", scheduleTableScrollSync);
  }

  if (THEME_MEDIA_QUERY) {
    if (typeof THEME_MEDIA_QUERY.addEventListener === "function") {
      THEME_MEDIA_QUERY.addEventListener("change", syncThemeWithSystem);
    } else if (typeof THEME_MEDIA_QUERY.addListener === "function") {
      THEME_MEDIA_QUERY.addListener(syncThemeWithSystem);
    }
  }

  applyTheme(getSystemTheme());
  render();
})();
