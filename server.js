const http = require("http");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const FETCH_HEADERS = {
  "user-agent": "jam-stats/1.0",
  accept: "text/html,application/json;q=0.9,*/*;q=0.8",
};

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(message);
}

function sendNoContent(res) {
  res.writeHead(204, {
    "cache-control": "no-store",
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end();
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

async function fetchText(url) {
  const response = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`request to ${url} failed with ${response.status}`);
  }

  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`request to ${url} failed with ${response.status}`);
  }

  return response.json();
}

async function fetchOptionalJson(url) {
  try {
    const response = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return null;
    }

    return response.json();
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

async function handleEntriesRequest(reqUrl, res) {
  const rawInput = reqUrl.searchParams.get("input");

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
    const resultsPayload = await fetchOptionalJson(feedUrl.replace(/entries\.json(?:\?.*)?$/i, "results.json"));
    const normalized = normalizeEntries(entriesPayload, jamId, parsedInput.slug, feedUrl, resultsPayload);

    sendJson(res, 200, {
      input: parsedInput.original,
      resolvedVia: resolved.resolvedVia,
      ...normalized,
    });
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : "unable to load jam entries",
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendText(res, 400, "bad request");
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === "OPTIONS") {
    sendNoContent(res);
    return;
  }

  if (reqUrl.pathname === "/") {
    sendText(res, 200, "jam-stats api");
    return;
  }

  if (req.method !== "GET") {
    sendText(res, 405, "method not allowed");
    return;
  }

  if (reqUrl.pathname === "/api/entries") {
    await handleEntriesRequest(reqUrl, res);
    return;
  }

  sendText(res, 404, "not found");
});

server.listen(PORT, HOST, () => {
  console.log(`jam-stats api running at http://${HOST}:${PORT}`);
});
