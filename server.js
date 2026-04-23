import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { parseStringPromise } from "xml2js";
import { Agent } from "undici";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // serves the UI

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const hmrClients = new Set();

const DEBUG_ENV =
  process.env.SITEMAP_CHECKER_DEBUG === "1" ||
  process.env.DEBUG === "sitemap-checker";

function ts() {
  return new Date().toISOString();
}

function makeDbg(enabled) {
  return (...args) => {
    if (!enabled) return;
    console.log(`[sitemap-checker ${ts()}]`, ...args);
  };
}

function sendHmrEvent(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of hmrClients) {
    if (client.writableEnded) {
      hmrClients.delete(client);
      continue;
    }
    client.write(data);
  }
}

let tailwindDebounceTimer;

watch(path.join(__dirname, "public"), { persistent: true }, (eventType, filename) => {
  if (filename !== "tailwind.css") return;
  if (eventType !== "change" && eventType !== "rename") return;
  clearTimeout(tailwindDebounceTimer);
  tailwindDebounceTimer = setTimeout(() => {
    sendHmrEvent({ type: "tailwind_update" });
  }, 50);
});

app.get("/hmr", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.socket?.setKeepAlive(true);
  res.socket?.setNoDelay(true);
  res.socket?.setTimeout(0);

  hmrClients.add(res);
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    // SSE comment line used as keepalive heartbeat.
    res.write(": keepalive\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    hmrClients.delete(res);
  });
});

/** DDEV / local HTTPS certs are not in Node's trust store; relax TLS only for those hosts. */
function allowInsecureTlsForUrl(url) {
  try {
    const { hostname } = new URL(url);
    if (process.env.SITEMAP_CHECKER_TLS_INSECURE === "1") return true;
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    if (hostname.endsWith(".ddev.site")) return true;
    return false;
  } catch {
    return false;
  }
}

const insecureTlsDispatcher = new Agent({
  connect: { rejectUnauthorized: false },
});

/** xml2js: repeated tags → array; a single tag → object. Always normalize before .map(). */
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

async function fetchSitemap(url, dbg = () => {}) {
  const timeoutMs = Number(process.env.SITEMAP_FETCH_TIMEOUT_MS || 15000);
  const t0 = Date.now();
  dbg("fetch start", url, { timeoutMs, insecureTls: allowInsecureTlsForUrl(url) });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const opts = allowInsecureTlsForUrl(url)
    ? { dispatcher: insecureTlsDispatcher, signal: controller.signal }
    : { signal: controller.signal };
  try {
    const res = await fetch(url, opts);
    dbg("fetch ok", url, res.status, `${Date.now() - t0}ms`);
    return res;
  } catch (e) {
    dbg("fetch error", url, e.message, e.cause?.message || "", `${Date.now() - t0}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function locsFromUrlset(urlset) {
  if (!urlset?.url) return [];
  return asArray(urlset.url)
    .map((u) => asArray(u.loc)[0])
    .filter(Boolean);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runner()));
  return results;
}

/** Drop matches that sit inside `excludeWithin` (any ancestor matches that selector). */
async function filterExcludeWithin(elements, excludeWithin) {
  const ex = excludeWithin?.trim();
  if (!ex) return elements;
  const kept = [];
  for (const el of elements) {
    const inside = await el.evaluate((node, sel) => {
      try {
        return node.closest(sel) !== null;
      } catch {
        return false;
      }
    }, ex);
    if (!inside) kept.push(el);
  }
  return kept;
}

async function fetchAllUrls(baseUrl, onStatus = () => {}, dbg = () => {}) {
  const rootUrl = new URL("/sitemap.xml", baseUrl).href;
  dbg("sitemap root", rootUrl);
  const res = await fetchSitemap(rootUrl, dbg);
  if (!res.ok) throw new Error(`Sitemap fetch failed: ${res.status}`);
  const xml = await res.text();
  dbg("root XML bytes", xml.length);
  const parsed = await parseStringPromise(xml);
  dbg("parsed keys", Object.keys(parsed));

  if (parsed.sitemapindex) {
    const sitemapUrls = asArray(parsed.sitemapindex.sitemap)
      .map((s) => asArray(s.loc)[0])
      .filter(Boolean);
    dbg("sitemap index", { childSitemaps: sitemapUrls.length });
    onStatus(`Found ${sitemapUrls.length} child sitemap(s)...`);

    const errors = [];
    const urlGroups = await mapWithConcurrency(sitemapUrls, 6, async (url, idx) => {
      try {
        const subRes = await fetchSitemap(url, dbg);
        if (!subRes.ok) {
          throw new Error(`Sub-sitemap fetch failed (${url}): ${subRes.status}`);
        }
        const subXml = await subRes.text();
        dbg("child XML", idx + 1, url, "bytes", subXml.length);
        const subParsed = await parseStringPromise(subXml);
        const locs = locsFromUrlset(subParsed.urlset);
        dbg("child urls", idx + 1, locs.length);
        onStatus(`Fetched child sitemap ${idx + 1}/${sitemapUrls.length}`);
        return locs;
      } catch (e) {
        errors.push(e.message);
        dbg("child sitemap error", idx + 1, url, e.message);
        onStatus(`Child sitemap ${idx + 1}/${sitemapUrls.length} failed`);
        return [];
      }
    });

    if (sitemapUrls.length > 0 && errors.length === sitemapUrls.length) {
      throw new Error(`All child sitemaps failed. First error: ${errors[0]}`);
    }
    if (errors.length > 0) {
      onStatus(`Continuing with ${errors.length} failed child sitemap(s)`);
    }

    const flat = urlGroups.flat();
    dbg("merged URL count", flat.length);
    return flat;
  }
  const direct = locsFromUrlset(parsed.urlset);
  dbg("flat urlset URL count", direct.length);
  return direct;
}

// SSE endpoint — streams results back to the UI in real time
app.post("/scan", async (req, res) => {
  const { siteUrl, checks, debug: bodyDebug } = req.body;
  const dbg = makeDbg(DEBUG_ENV || Boolean(bodyDebug));
  let cancelled = false;
  let browser;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();

  /** Do not use `req.on("close")` for cancel — it can fire after the POST body is fully read (false positive). */
  function stopScan(reason) {
    if (cancelled) return;
    cancelled = true;
    dbg("scan stop:", reason);
    if (browser) browser.close().catch(() => {});
  }

  req.on("aborted", () => stopScan("request aborted (client)"));

  res.on("close", () => {
    if (res.writableEnded) {
      dbg("response stream closed (normal end)");
      return;
    }
    stopScan("response closed before end (client disconnected mid-stream)");
  });

  const send = (data) => {
    if (cancelled || res.writableEnded) return false;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  };

  try {
    dbg("scan start", { siteUrl, checks: checks?.length ?? 0, debugEnv: DEBUG_ENV, bodyDebug: Boolean(bodyDebug) });
    if (!send({ type: "status", message: "Fetching sitemap..." })) return;
    const urls = await fetchAllUrls(
      siteUrl,
      (message) => send({ type: "status", message }),
      dbg
    );
    dbg("urls resolved", urls.length);
    if (!send({ type: "urls_found", count: urls.length })) return;

    if (cancelled) return;
    dbg("launching chromium");
    browser = await chromium.launch({ headless: true });
    const ignoreHTTPSErrors = allowInsecureTlsForUrl(siteUrl);
    const context = await browser.newContext({ ignoreHTTPSErrors });
    const scanConcurrencyRaw = Number(process.env.SITEMAP_SCAN_CONCURRENCY || 6);
    const scanConcurrency =
      Number.isFinite(scanConcurrencyRaw) && scanConcurrencyRaw > 0
        ? Math.floor(scanConcurrencyRaw)
        : 6;
    dbg("scan workers", scanConcurrency);
    send({ type: "status", message: `Scanning pages with ${scanConcurrency} worker(s)...` });

    await mapWithConcurrency(urls, scanConcurrency, async (url, i) => {
      if (cancelled) return;
      if (!send({ type: "page_start", url })) return;
      const pageResults = [];
      const pageT0 = Date.now();
      dbg("page", i + 1, "/", urls.length, url);
      let page;

      try {
        page = await context.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        dbg("page goto ok", `${Date.now() - pageT0}ms`, url);

        for (const check of checks) {
          if (cancelled) break;
          const excludeWithin = check.excludeWithin || "";
          try {
            const ex = excludeWithin.trim();
            if (ex) {
              try {
                await page.evaluate((sel) => {
                  document.querySelector(sel);
                }, ex);
              } catch {
                throw new Error(`Invalid exclude-within selector: ${ex}`);
              }
            }

            let elements = await page.$$(check.selector);
            elements = await filterExcludeWithin(elements, excludeWithin);

            let status, detail;

            if (check.expected === "present") {
              status = elements.length > 0 ? "pass" : "fail";
              detail =
                status === "pass"
                  ? `Found ${elements.length} element(s)${
                      ex ? " (outside exclude container)" : ""
                    }`
                  : ex
                    ? "Not found outside exclude container"
                    : "Not found";
            } else if (check.expected === "absent") {
              status = elements.length === 0 ? "pass" : "fail";
              detail =
                status === "pass"
                  ? ex
                    ? "Correctly absent (outside exclude container)"
                    : "Correctly absent"
                  : `Found ${elements.length} (should be 0)`;
            } else {
              const texts = await Promise.all(
                elements.map((el) => el.textContent())
              );
              const matched = texts.some((t) => t?.includes(check.expected));
              status = matched ? "pass" : "fail";
              detail = matched
                ? `Contains "${check.expected}"`
                : `"${check.expected}" not found`;
            }

            pageResults.push({
              label: check.label,
              selector: check.selector,
              excludeWithin: excludeWithin.trim() || undefined,
              status,
              detail
            });
          } catch (e) {
            pageResults.push({
              label: check.label,
              selector: check.selector,
              excludeWithin: excludeWithin.trim() || undefined,
              status: "error",
              detail: e.message
            });
          }
        }
      } catch (e) {
        if (cancelled) return;
        pageResults.push({
          label: "Page load",
          selector: "-",
          status: "error",
          detail: e.message
        });
      } finally {
        if (page) {
          await page.close().catch(() => {});
        }
      }

      if (cancelled) return;
      dbg("page_done", url, "checks", pageResults.length, `${Date.now() - pageT0}ms total`);
      if (!send({ type: "page_done", url, results: pageResults })) return;
    });

    if (browser) {
      await browser.close().catch(() => {});
      browser = undefined;
    }
    if (!cancelled) {
      dbg("scan complete", urls.length, "pages");
      send({ type: "complete" });
    }
  } catch (e) {
    if (cancelled) return;
    const cause = e.cause;
    const message =
      cause && typeof cause === "object" && "message" in cause
        ? `${e.message}: ${cause.message}`
        : e.message;
    dbg("scan error", message, e.stack?.split("\n").slice(0, 4).join(" | "));
    send({ type: "error", message });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (!res.writableEnded) {
      res.end();
    }
  }
});

app.listen(3333, () => {
  console.log("✅ Server running at http://localhost:3333");
  if (DEBUG_ENV) {
    console.log("🐛 Debug logging on (SITEMAP_CHECKER_DEBUG=1 or DEBUG=sitemap-checker)");
  }
});
