(function () {
  const state = {
    rows: [],
    meta: null,
    sortKey: "popularity",
    sortDir: "desc",
    platformFilters: new Set(),
  };

  const numericKeys = new Set([
    "popularity",
    "totalRating",
    "coolness",
    "karma",
  ]);

  const elements = {
    jamInput: document.getElementById("jam-input"),
    loadButton: document.getElementById("load-button"),
    exampleButton: document.getElementById("example-button"),
    status: document.getElementById("status"),
    searchInput: document.getElementById("search-input"),
    summary: document.getElementById("summary"),
    tableBody: document.getElementById("table-body"),
    sortButtons: Array.from(document.querySelectorAll("button.sort")),
  };
  const apiBase = getApiBase();

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

    if (state.sortKey === "popularity") {
      const leftRank = Number(left.popularityRank || leftValue);
      const rightRank = Number(right.popularityRank || rightValue);
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

  function getVisibleRows() {
    const query = elements.searchInput.value.trim().toLowerCase();
    const filteredRows = state.rows.filter((row) => {
      const matchesQuery = !query || row.searchableText.includes(query);
      const matchesPlatform = !state.platformFilters.size
        || row.platforms.some((platform) => state.platformFilters.has(getPlatformKey(platform)));

      return matchesQuery && matchesPlatform;
    });

    filteredRows.sort(compareRows);
    return filteredRows;
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

  function renderRows() {
    const visibleRows = getVisibleRows();
    const activePlatformLabels = Array.from(state.platformFilters).sort();
    const filterSuffix = activePlatformLabels.length
      ? ` filtered by ${activePlatformLabels.join(", ")}`
      : "";

    if (!state.rows.length) {
      elements.summary.textContent = "0 entries";
      elements.tableBody.innerHTML = '<tr><td class="empty" colspan="7">load a jam to populate the table</td></tr>';
      return;
    }

    elements.summary.textContent = `${formatInteger(visibleRows.length)} of ${formatInteger(state.rows.length)} entries${filterSuffix}`;

    if (!visibleRows.length) {
      elements.tableBody.innerHTML = '<tr><td class="empty" colspan="7">no entries match the current search or platform filters</td></tr>';
      return;
    }

    elements.tableBody.innerHTML = visibleRows
      .map((row) => {
        const projectHref = row.projectUrl ? ` href="${escapeHtml(row.projectUrl)}"` : "";
        const projectTarget = row.projectUrl ? ' target="_blank" rel="noreferrer"' : "";

        return `
          <tr>
            <td>
              <a class="game-link"${projectHref}${projectTarget}>${escapeHtml(row.gameName)}</a>
            </td>
            <td><div class="contrib-list">${renderContributors(row)}</div></td>
            <td>${formatPopularity(row.popularity)}</td>
            <td>${formatInteger(row.totalRating)}</td>
            <td>${formatInteger(row.coolness)}</td>
            <td>${formatKarma(row.karma)}</td>
            <td><div class="platforms">${renderPlatforms(row)}</div></td>
          </tr>
        `;
      })
      .join("");
  }

  function updateSortButtons() {
    elements.sortButtons.forEach((button) => {
      const indicator = button.querySelector(".sort-indicator");
      const isActive = button.dataset.sort === state.sortKey;
      button.classList.toggle("active", isActive);
      indicator.innerHTML = getSortIcon(isActive ? state.sortDir : "idle");
    });
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
    updateSortButtons();
    renderRows();
  }

  async function loadEntries() {
    const input = elements.jamInput.value.trim();
    if (!input) {
      setStatus("enter an itch jam url slug or numeric jam id", "error");
      return;
    }

    setBusy(true);
    setStatus("resolving jam id and fetching entries", "");

    try {
      const response = await fetch(getEntriesApiUrl(input));
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(payload.error || "unable to load entries");
      }

      state.rows = Array.isArray(payload.rows) ? payload.rows : [];
      state.meta = payload;
      state.platformFilters.clear();
      elements.searchInput.disabled = !state.rows.length;
      render();
      setStatus(`loaded ${formatInteger(state.rows.length)} entries from ${getJamLabel(payload)}`, "success");
    } catch (error) {
      state.rows = [];
      state.meta = null;
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

  elements.sortButtons.forEach((button) => {
    button.addEventListener("click", function () {
      const key = button.dataset.sort;
      if (!key) {
        return;
      }

      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = numericKeys.has(key) ? "desc" : "asc";
      }

      render();
    });
  });

  render();
})();
