const FETCH_HEADERS = {
  "user-agent": "jam-stats/1.0",
  accept: "text/html,application/json;q=0.9,*/*;q=0.8",
};
const RESULTS_PAGE_SCRAPE_THRESHOLD = 0.8;

const RESPONSE_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
};

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...RESPONSE_HEADERS,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function textResponse(message, status = 200) {
  return new Response(message, {
    status,
    headers: {
      ...RESPONSE_HEADERS,
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function noContentResponse() {
  return new Response(null, {
    status: 204,
    headers: RESPONSE_HEADERS,
  });
}

function normalizeJamInput(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    throw new Error("enter an itch jam url, slug, or numeric jam id");
  }

  if (/^\d+$/.test(value)) {
    return {
      kind: "id",
      jamId: value,
      slug: null,
      original: value,
    };
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (!hostname.endsWith("itch.io")) {
      throw new Error("only itch.io jam urls are supported");
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "jam" || !parts[1]) {
      throw new Error("use an itch.io jam url like https://itch.io/jam/brackeys-15");
    }

    const candidate = parts[1];
    if (/^\d+$/.test(candidate)) {
      return {
        kind: "id",
        jamId: candidate,
        slug: null,
        original: value,
      };
    }

    return {
      kind: "slug",
      jamId: null,
      slug: candidate,
      original: value,
    };
  } catch (error) {
    if (error instanceof TypeError) {
      return {
        kind: "slug",
        jamId: null,
        slug: value.replace(/^\/+|\/+$/g, ""),
        original: value,
      };
    }

    throw error;
  }
}

async function fetchWithTimeout(url, requestInit = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...requestInit,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url, {
    headers: FETCH_HEADERS,
  });

  if (!response.ok) {
    throw new Error(`request to ${url} failed with ${response.status}`);
  }

  return response.text();
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url, {
    headers: FETCH_HEADERS,
  });

  if (!response.ok) {
    throw new Error(`request to ${url} failed with ${response.status}`);
  }

  return response.json();
}

async function fetchOptionalJson(url) {
  try {
    const response = await fetchWithTimeout(url, {
      headers: FETCH_HEADERS,
    });

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch (error) {
    return null;
  }
}

async function fetchOptionalText(url) {
  try {
    const response = await fetchWithTimeout(url, {
      headers: FETCH_HEADERS,
    });

    if (!response.ok) {
      return null;
    }

    return response.text();
  } catch (error) {
    return null;
  }
}

function extractJamIdFromHtml(html) {
  const patterns = [
    /new I\.ViewJam\([^]*?"id":\s*(\d+)/,
    /\/jam\/(\d+)\/entries\.json/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function extractEntriesUrlFromEntriesHtml(html) {
  const patterns = [
    /"entries_url":"([^"]*entries\.json)"/,
    /\/jam\/[^"'\\\s]+\/entries\.json/,
    /\/jam\/\d+\/entries\.json/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return (match[1] || match[0]).replaceAll("\\/", "/");
    }
  }

  return null;
}

async function resolveFeedInfoFromSlug(slug) {
  const entriesPageUrl = `https://itch.io/jam/${encodeURIComponent(slug)}/entries`;
  const entriesHtml = await fetchText(entriesPageUrl);
  const rawEntriesUrl = extractEntriesUrlFromEntriesHtml(entriesHtml);

  if (rawEntriesUrl) {
    const feedUrl = rawEntriesUrl.startsWith("http") ? rawEntriesUrl : `https://itch.io${rawEntriesUrl}`;
    const jamIdMatch = feedUrl.match(/\/jam\/(\d+)\/entries\.json/);
    if (jamIdMatch) {
      return {
        feedUrl,
        jamId: jamIdMatch[1],
        resolvedVia: "entries-page-script",
      };
    }

    const jamHtml = await fetchText(`https://itch.io/jam/${encodeURIComponent(slug)}`);
    const jamId = extractJamIdFromHtml(jamHtml);
    return {
      feedUrl,
      jamId,
      resolvedVia: jamId ? "entries-page-script" : "entries-page-url",
    };
  }

  const jamHtml = await fetchText(`https://itch.io/jam/${encodeURIComponent(slug)}`);
  const jamId = extractJamIdFromHtml(jamHtml);
  if (jamId) {
    return {
      feedUrl: `https://itch.io/jam/${jamId}/entries.json`,
      jamId,
      resolvedVia: "jam-page-source",
    };
  }

  throw new Error(`unable to infer a numeric jam id for "${slug}"`);
}

function inferSlug(explicitSlug, entries) {
  if (explicitSlug) {
    return explicitSlug;
  }

  const firstUrl = entries.find((entry) => typeof entry?.url === "string")?.url;
  if (!firstUrl) {
    return null;
  }

  const match = firstUrl.match(/^\/jam\/([^/]+)\//);
  return match ? match[1] : null;
}

function computeKarma(coolness, ratingCount) {
  return Math.log(1 + coolness) - Math.log(1 + ratingCount) / Math.log(5);
}

function normalizeSubmissionUrl(value) {
  const url = String(value || "").trim();
  if (!url) {
    return "";
  }

  const normalized = url.startsWith("http") ? url : `https://itch.io${url}`;
  return normalized.replace(/\/+$/g, "");
}

function extractRateId(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  if (/^\d+$/.test(rawValue)) {
    return rawValue;
  }

  const normalizedUrl = normalizeSubmissionUrl(rawValue);
  const match = normalizedUrl.match(/\/rate\/(\d+)(?:[/?#]|$)/);
  return match ? match[1] : "";
}

function normalizeLookupTitle(value) {
  return String(value || "").trim().toLowerCase();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, codePoint) => String.fromCharCode(Number(codePoint)))
    .replace(/&#x([0-9a-f]+);/gi, (_, codePoint) => String.fromCharCode(Number.parseInt(codePoint, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function normalizeHtmlText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function buildPageUrl(baseUrl, pageNumber) {
  if (pageNumber <= 1) {
    return baseUrl;
  }

  const url = new URL(baseUrl);
  url.searchParams.set("page", String(pageNumber));
  return url.toString();
}

async function fetchTextsWithConcurrency(urls, concurrency = 8) {
  if (!urls.length) {
    return [];
  }

  const results = new Array(urls.length).fill(null);
  let index = 0;

  async function worker() {
    while (index < urls.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await fetchOptionalText(urls[currentIndex]);
    }
  }

  const workerCount = Math.min(concurrency, urls.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results.filter(Boolean);
}

function extractResultsPageCount(html) {
  const match = html.match(/Page\s+1\s+of\s+(?:<a[^>]*>)?(\d+)/i);
  const pageCount = Number(match?.[1]);
  return Number.isFinite(pageCount) && pageCount > 0 ? pageCount : 1;
}

function extractResultsPathsFromHtml(html, slug) {
  if (!slug) {
    return [];
  }

  const pattern = new RegExp(`<a[^>]+href="(\\/jam\\/${escapeRegExp(slug)}\\/results(?:\\/[^"?]+)?)"[^>]*class="nav_btn`, "gi");
  const paths = [];
  const seen = new Set();

  for (const match of html.matchAll(pattern)) {
    const path = String(match[1] || "").trim();
    if (!path || seen.has(path)) {
      continue;
    }

    seen.add(path);
    paths.push(path);
  }

  return paths;
}

function extractResultsFromHtml(html) {
  const results = [];
  const blockPattern = /<div class="game_rank[^"]*">([\s\S]*?)<\/table>/gi;

  for (const match of html.matchAll(blockPattern)) {
    const blockHtml = match[1];
    const ratePathMatch = blockHtml.match(/class="forward_link" href="([^"]*\/rate\/\d+)"/i)
      || blockHtml.match(/href="([^"]*\/rate\/\d+)"/i);
    const ratePath = String(ratePathMatch?.[1] || "").trim();
    const rateId = extractRateId(ratePath);

    if (!rateId) {
      continue;
    }

    const criteria = [];
    const rowPattern = /<tr><td[^>]*>([\s\S]*?)<\/td><td[^>]*>([\s\S]*?)<\/td>/gi;
    for (const rowMatch of blockHtml.matchAll(rowPattern)) {
      const name = normalizeHtmlText(rowMatch[1]);
      const rank = Number(normalizeHtmlText(rowMatch[2]).replace(/^#/, ""));
      if (!name || !Number.isFinite(rank)) {
        continue;
      }

      criteria.push({ name, rank });
    }

    if (!criteria.length) {
      continue;
    }

    results.push({
      id: rateId,
      url: ratePath.startsWith("http") ? ratePath : `https://itch.io${ratePath}`,
      criteria,
    });
  }

  return results;
}

function mergeCriteriaLists(primaryCriteria, secondaryCriteria) {
  const merged = [];
  const seen = new Set();

  for (const criterion of [...primaryCriteria, ...secondaryCriteria]) {
    const name = String(criterion?.name || "").trim();
    const normalizedName = name.toLowerCase();
    const rank = Number(criterion?.rank);
    if (!name || seen.has(normalizedName) || !Number.isFinite(rank)) {
      continue;
    }

    seen.add(normalizedName);
    merged.push({
      name,
      rank,
    });
  }

  return merged;
}

function mergeResults(primaryResults, secondaryResults) {
  const merged = new Map();

  function upsert(result) {
    const rateId = extractRateId(result?.id || result?.url);
    const submissionUrl = normalizeSubmissionUrl(result?.url);
    const key = rateId ? `rate:${rateId}` : submissionUrl ? `url:${submissionUrl}` : "";

    if (!key) {
      return;
    }

    if (!merged.has(key)) {
      merged.set(key, {
        ...result,
        criteria: Array.isArray(result?.criteria) ? mergeCriteriaLists(result.criteria, []) : [],
      });
      return;
    }

    const existing = merged.get(key);
    merged.set(key, {
      ...existing,
      ...result,
      id: existing?.id || result?.id || "",
      url: existing?.url || result?.url || "",
      criteria: mergeCriteriaLists(
        Array.isArray(existing?.criteria) ? existing.criteria : [],
        Array.isArray(result?.criteria) ? result.criteria : []
      ),
    });
  }

  primaryResults.forEach(upsert);
  secondaryResults.forEach(upsert);
  return Array.from(merged.values());
}

async function fetchResultsPages(baseUrl, firstPageHtml, pageCount) {
  const otherPageUrls = [];
  for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
    otherPageUrls.push(buildPageUrl(baseUrl, pageNumber));
  }

  const otherPages = await fetchTextsWithConcurrency(otherPageUrls);
  return [firstPageHtml, ...otherPages].flatMap(extractResultsFromHtml);
}

async function fetchPublicPageResults(slug) {
  if (!slug) {
    return [];
  }

  const overallUrl = `https://itch.io/jam/${encodeURIComponent(slug)}/results`;
  const overallHtml = await fetchOptionalText(overallUrl);
  if (!overallHtml) {
    return [];
  }

  const overallPageCount = extractResultsPageCount(overallHtml);
  let results = await fetchResultsPages(overallUrl, overallHtml, overallPageCount);

  if (overallPageCount > 1) {
    return results;
  }

  const overallPath = `/jam/${slug}/results`;
  const extraPaths = extractResultsPathsFromHtml(overallHtml, slug)
    .filter((path) => path !== overallPath);

  for (const path of extraPaths) {
    const url = `https://itch.io${path}`;
    const html = await fetchOptionalText(url);
    if (!html) {
      continue;
    }

    const pageCount = extractResultsPageCount(html);
    const extraResults = await fetchResultsPages(url, html, pageCount);
    results = mergeResults(results, extraResults);
  }

  return results;
}

function slugifyCriteriaName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildResultCriteria(results) {
  const criteria = [];
  const seenNames = new Set();
  const seenKeys = new Set();

  for (const result of results) {
    const resultCriteria = Array.isArray(result?.criteria) ? result.criteria : [];
    for (const criterion of resultCriteria) {
      const name = String(criterion?.name || "").trim();
      const normalizedName = name.toLowerCase();
      if (!name || seenNames.has(normalizedName)) {
        continue;
      }

      seenNames.add(normalizedName);

      const baseKey = slugifyCriteriaName(name) || "criteria";
      let key = `criteriaRank_${baseKey}`;
      let suffix = 2;
      while (seenKeys.has(key)) {
        key = `criteriaRank_${baseKey}_${suffix}`;
        suffix += 1;
      }

      seenKeys.add(key);
      criteria.push({ name, key });
    }
  }

  return criteria;
}

function buildResultsLookup(results) {
  const lookup = new Map();

  for (const result of results) {
    const submissionUrl = normalizeSubmissionUrl(result?.url);
    if (submissionUrl && !lookup.has(`url:${submissionUrl}`)) {
      lookup.set(`url:${submissionUrl}`, result);
    }

    const rateId = extractRateId(result?.id || result?.url);
    if (rateId && !lookup.has(`rate:${rateId}`)) {
      lookup.set(`rate:${rateId}`, result);
    }

    const title = normalizeLookupTitle(result?.title);
    if (title && !lookup.has(`title:${title}`)) {
      lookup.set(`title:${title}`, result);
    }
  }

  return lookup;
}

function findResultForEntry(resultsLookup, submissionUrl, rateId, gameTitle) {
  const normalizedSubmissionUrl = normalizeSubmissionUrl(submissionUrl);
  if (normalizedSubmissionUrl && resultsLookup.has(`url:${normalizedSubmissionUrl}`)) {
    return resultsLookup.get(`url:${normalizedSubmissionUrl}`) || null;
  }

  if (rateId && resultsLookup.has(`rate:${rateId}`)) {
    return resultsLookup.get(`rate:${rateId}`) || null;
  }

  const normalizedTitle = normalizeLookupTitle(gameTitle);
  if (normalizedTitle && resultsLookup.has(`title:${normalizedTitle}`)) {
    return resultsLookup.get(`title:${normalizedTitle}`) || null;
  }

  return null;
}

function getCriteriaRank(result, criterionName) {
  if (!result) {
    return null;
  }

  const normalizedName = String(criterionName || "").trim().toLowerCase();
  if (!normalizedName) {
    return null;
  }

  const criteria = Array.isArray(result?.criteria) ? result.criteria : [];
  const match = criteria.find((criterion) => (
    String(criterion?.name || "").trim().toLowerCase() === normalizedName
  ));

  const rank = Number(match?.rank);
  return Number.isFinite(rank) ? rank : null;
}

function normalizeEntries(entriesPayload, jamId, slug, feedUrl, resultsPayload) {
  const jamGames = Array.isArray(entriesPayload?.jam_games) ? entriesPayload.jam_games : [];
  const inferredSlug = inferSlug(slug, jamGames);
  const totalEntries = jamGames.length;
  const results = Array.isArray(resultsPayload?.results) ? resultsPayload.results : [];
  const resultCriteria = buildResultCriteria(results);
  const resultsLookup = buildResultsLookup(results);
  let matchedResultsCount = 0;

  const rows = jamGames.map((entry, index) => {
    const game = entry?.game || {};
    const owner = game?.user || {};
    const rawContributors = Array.isArray(entry?.contributors) && entry.contributors.length
      ? entry.contributors
      : owner?.name
        ? [{ name: owner.name, url: owner.url || game.url || "" }]
        : [];

    const contributors = rawContributors
      .map((contributor) => ({
        name: String(contributor?.name || "").trim(),
        url: String(contributor?.url || "").trim(),
      }))
      .filter((contributor) => contributor.name);

    const ratingCount = Number(entry?.rating_count) || 0;
    const coolness = Number(entry?.coolness) || 0;
    const popularityRank = index + 1;
    const gameTitle = String(game?.title || "untitled entry").trim() || "untitled entry";
    const platforms = Array.isArray(game?.platforms)
      ? game.platforms.map((platform) => String(platform || "").trim()).filter(Boolean)
      : [];
    const submissionUrl = typeof entry?.url === "string" && entry.url
      ? `https://itch.io${entry.url}`
      : "";
    const rateId = extractRateId(submissionUrl) || extractRateId(game?.id);
    const projectUrl = String(game?.url || "").trim();
    const karma = computeKarma(coolness, ratingCount);
    const matchedResult = findResultForEntry(resultsLookup, submissionUrl, rateId, gameTitle);

    if (matchedResult) {
      matchedResultsCount += 1;
    }

    const row = {
      submissionId: Number(entry?.id) || null,
      projectId: Number(game?.id) || null,
      gameName: gameTitle,
      projectUrl,
      submissionUrl,
      contributors,
      contributorsText: contributors.map((contributor) => contributor.name).join(", "),
      popularity: popularityRank,
      popularityRank,
      popularityDisplay: String(popularityRank),
      popularityPercentile: totalEntries > 0 ? round((popularityRank / totalEntries) * 100, 3) : null,
      totalRating: ratingCount,
      ratesGiven: coolness,
      coolness,
      karma: round(karma, 3),
      platforms,
      platformsText: platforms.join(", "),
      coverUrl: String(game?.cover || "").trim(),
      createdAt: String(entry?.created_at || "").trim(),
      owner: owner?.name
        ? {
            name: String(owner.name),
            url: String(owner.url || ""),
          }
        : null,
      searchableText: `${gameTitle} ${contributors.map((contributor) => contributor.name).join(" ")}`.toLowerCase(),
    };

    resultCriteria.forEach((criterion) => {
      row[criterion.key] = getCriteriaRank(matchedResult, criterion.name);
    });

    return row;
  });

  return {
    jamId,
    jamSlug: inferredSlug,
    feedUrl,
    hasResults: results.length > 0,
    matchedResultsCount,
    resultCriteria,
    generatedOn: Number(entriesPayload?.generated_on) || null,
    rows,
    notes: {
      popularity: "popularity uses the native order of jam_games in entries.json which itch returns in popularity order",
      totalRating: "total rating uses the raw rating_count value from entries.json",
      ratesGiven: "following itch-analytics the coolness value exposed by entries.json is used as the available votes-given signal",
      coolness: "coolness comes directly from entries.json",
      karma: "karma is computed client-side as log(1 + coolness) - (log(1 + rating_count) / log(5))",
      criteriaRanks: "when available result rank columns come directly from the criteria entries in itch.io results.json, including overall when the jam exposes it as a criterion",
      resultsCoverage: "some jams only publish ranked results for a subset of entries, so blank result cells can mean itch.io does not expose a public rank for that submission",
    },
  };
}

async function handleEntriesRequest(url) {
  const rawInput = url.searchParams.get("input");

  try {
    const parsedInput = normalizeJamInput(rawInput);
    const resolved = parsedInput.jamId
      ? {
          jamId: parsedInput.jamId,
          feedUrl: `https://itch.io/jam/${parsedInput.jamId}/entries.json`,
          resolvedVia: "direct-id",
        }
      : await resolveFeedInfoFromSlug(parsedInput.slug);

    const jamId = resolved.jamId || null;
    if (!jamId) {
      throw new Error("unable to determine the numeric jam id from the entries feed");
    }

    const feedUrl = resolved.feedUrl;
    const entriesPayload = await fetchJson(feedUrl);
    const inferredSlug = parsedInput.slug || inferSlug(
      null,
      Array.isArray(entriesPayload?.jam_games) ? entriesPayload.jam_games : []
    );
    const resultsPayload = await fetchOptionalJson(feedUrl.replace(/entries\.json(?:\?.*)?$/i, "results.json"));
    const jsonResults = Array.isArray(resultsPayload?.results) ? resultsPayload.results : [];
    const totalEntries = Array.isArray(entriesPayload?.jam_games) ? entriesPayload.jam_games.length : 0;
    const shouldScrapePublicResults = Boolean(
      inferredSlug
      && (jsonResults.length === 0 || jsonResults.length < totalEntries * RESULTS_PAGE_SCRAPE_THRESHOLD)
    );
    const publicPageResults = shouldScrapePublicResults
      ? await fetchPublicPageResults(inferredSlug)
      : [];
    const mergedResultsPayload = {
      ...(resultsPayload || {}),
      results: mergeResults(jsonResults, publicPageResults),
    };
    const normalized = normalizeEntries(entriesPayload, jamId, parsedInput.slug, feedUrl, mergedResultsPayload);

    return jsonResponse({
      input: parsedInput.original,
      resolvedVia: resolved.resolvedVia,
      ...normalized,
    });
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : "unable to load jam entries",
    }, 400);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return noContentResponse();
    }

    if (request.method !== "GET") {
      return textResponse("method not allowed", 405);
    }

    if (url.pathname === "/api" || url.pathname === "/api/") {
      return textResponse("jam-stats api");
    }

    if (url.pathname === "/api/entries") {
      return handleEntriesRequest(url);
    }

    return textResponse("not found", 404);
  },
};
