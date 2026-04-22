import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { parseStringPromise } from "xml2js";
import { Agent } from "node:undici";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // serves the UI

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

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    send({ type: "status", message: "Fetching sitemap..." });
    const urls = await fetchAllUrls(siteUrl);
    send({ type: "urls_found", count: urls.length });

    const browser = await chromium.launch({ headless: true });
    const ignoreHTTPSErrors = allowInsecureTlsForUrl(siteUrl);
    const context = await browser.newContext({ ignoreHTTPSErrors });
    const page = await context.newPage();

    for (const url of urls) {
      send({ type: "page_start", url });
      const pageResults = [];

      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

        for (const check of checks) {
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
        pageResults.push({
          label: "Page load",
          selector: "-",
          status: "error",
          detail: e.message
        });
      }

      send({ type: "page_done", url, results: pageResults });
    }

    await browser.close();
    send({ type: "complete" });
  } catch (e) {
    const cause = e.cause;
    const message =
      cause && typeof cause === "object" && "message" in cause
        ? `${e.message}: ${cause.message}`
        : e.message;
    send({ type: "error", message });
  }

  res.end();
});

app.listen(3333, () =>
  console.log("✅ Server running at http://localhost:3333")
);
