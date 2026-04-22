import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { parseStringPromise } from "xml2js";
import { Agent } from "undici";
import { watch, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // serves the UI

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexHtmlPath = path.join(__dirname, "public", "index.html");
const hmrClients = new Set();

function extractInlineCss(html) {
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  return styleMatch ? styleMatch[1] : null;
}

function readInlineCssFromIndex() {
  try {
    const html = readFileSync(indexHtmlPath, "utf8");
    return extractInlineCss(html);
  } catch {
    return null;
  }
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

let lastInlineCss = readInlineCssFromIndex();
let hmrDebounceTimer;

watch(indexHtmlPath, { persistent: true }, (eventType) => {
  if (eventType !== "change") return;
  clearTimeout(hmrDebounceTimer);
  hmrDebounceTimer = setTimeout(() => {
    const nextCss = readInlineCssFromIndex();
    if (nextCss !== null && nextCss !== lastInlineCss) {
      lastInlineCss = nextCss;
      sendHmrEvent({ type: "css_update", css: nextCss });
      return;
    }
    sendHmrEvent({ type: "reload" });
  }, 75);
});

app.get("/hmr", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  hmrClients.add(res);
  req.on("close", () => {
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

function fetchSitemap(url) {
  const opts = allowInsecureTlsForUrl(url)
    ? { dispatcher: insecureTlsDispatcher }
    : {};
  return fetch(url, opts);
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

async function fetchAllUrls(baseUrl) {
  const res = await fetchSitemap(new URL("/sitemap.xml", baseUrl).href);
  if (!res.ok) throw new Error(`Sitemap fetch failed: ${res.status}`);
  const xml = await res.text();
  const parsed = await parseStringPromise(xml);

  if (parsed.sitemapindex) {
    const sitemapUrls = parsed.sitemapindex.sitemap.map((s) => s.loc[0]);
    const allUrls = [];
    for (const url of sitemapUrls) {
      const subRes = await fetchSitemap(url);
      const subXml = await subRes.text();
      const subParsed = await parseStringPromise(subXml);
      allUrls.push(...subParsed.urlset.url.map((u) => u.loc[0]));
    }
    return allUrls;
  }
  return parsed.urlset.url.map((u) => u.loc[0]);
}

// SSE endpoint — streams results back to the UI in real time
app.post("/scan", async (req, res) => {
  const { siteUrl, checks } = req.body;
  let cancelled = false;
  let browser;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();

  req.on("close", () => {
    cancelled = true;
    // Stop Playwright quickly when client cancels the request.
    if (browser) {
      browser.close().catch(() => {});
    }
  });

  const send = (data) => {
    if (cancelled || res.writableEnded) return false;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  };

  try {
    if (!send({ type: "status", message: "Fetching sitemap..." })) return;
    const urls = await fetchAllUrls(siteUrl);
    if (!send({ type: "urls_found", count: urls.length })) return;

    if (cancelled) return;
    browser = await chromium.launch({ headless: true });
    const ignoreHTTPSErrors = allowInsecureTlsForUrl(siteUrl);
    const context = await browser.newContext({ ignoreHTTPSErrors });
    const page = await context.newPage();

    for (const url of urls) {
      if (cancelled) break;
      if (!send({ type: "page_start", url })) break;
      const pageResults = [];

      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

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
        if (cancelled) break;
        pageResults.push({
          label: "Page load",
          selector: "-",
          status: "error",
          detail: e.message
        });
      }

      if (cancelled) break;
      if (!send({ type: "page_done", url, results: pageResults })) break;
    }

    if (browser) {
      await browser.close().catch(() => {});
      browser = undefined;
    }
    if (!cancelled) {
      send({ type: "complete" });
    }
  } catch (e) {
    if (cancelled) return;
    const cause = e.cause;
    const message =
      cause && typeof cause === "object" && "message" in cause
        ? `${e.message}: ${cause.message}`
        : e.message;
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

app.listen(3333, () =>
  console.log("✅ Server running at http://localhost:3333")
);
