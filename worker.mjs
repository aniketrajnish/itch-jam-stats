const FETCH_HEADERS = {
  "user-agent": "jam-stats/1.0",
  accept: "text/html,application/json;q=0.9,*/*;q=0.8",
};

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

function normalizeEntries(entriesPayload, jamId, slug, feedUrl) {
  const jamGames = Array.isArray(entriesPayload?.jam_games) ? entriesPayload.jam_games : [];
  const inferredSlug = inferSlug(slug, jamGames);
  const totalEntries = jamGames.length;

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
    const projectUrl = String(game?.url || "").trim();
    const karma = computeKarma(coolness, ratingCount);

    return {
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
  });

  return {
    jamId,
    jamSlug: inferredSlug,
    feedUrl,
    generatedOn: Number(entriesPayload?.generated_on) || null,
    rows,
    notes: {
      popularity: "popularity uses the native order of jam_games in entries.json which itch returns in popularity order",
      totalRating: "total rating uses the raw rating_count value from entries.json",
      ratesGiven: "following itch-analytics the coolness value exposed by entries.json is used as the available votes-given signal",
      coolness: "coolness comes directly from entries.json",
      karma: "karma is computed client-side as log(1 + coolness) - (log(1 + rating_count) / log(5))",
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
    const normalized = normalizeEntries(entriesPayload, jamId, parsedInput.slug, feedUrl);

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
