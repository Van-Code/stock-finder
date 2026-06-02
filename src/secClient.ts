import "dotenv/config";
import { EftsResponse, Form4FilingMeta, ActivistFilingMeta } from "./types.js";

// ── Yahoo Finance rate limiter (separate from SEC limiter) ───────────────────
const YF_INTERVAL_MS = 300; // ~3 req/s — polite for unofficial endpoint
let lastYfRequestAt = 0;

async function yfFetch(url: string): Promise<Response> {
  const gap = Date.now() - lastYfRequestAt;
  if (gap < YF_INTERVAL_MS) await sleep(YF_INTERVAL_MS - gap);
  lastYfRequestAt = Date.now();
  return fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; research bot)" },
  });
}

// SEC EDGAR endpoints
const EFTS_BASE = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_ARCHIVE = "https://www.sec.gov/Archives/edgar/data";
const EDGAR_WWW = "https://www.sec.gov";

// SEC fair-access guidelines: ≤ 10 requests/second — we target ~8/s (125 ms gap)
const REQUEST_INTERVAL_MS = 125;
let lastRequestAt = 0;

function buildUserAgent(): string {
  const email = process.env.SEC_CONTACT_EMAIL;
  if (!email) {
    throw new Error("SEC_CONTACT_EMAIL is required in .env (SEC fair-access policy).");
  }
  return `InsiderScanner/1.0 (research tool; contact: ${email})`;
}

async function rateLimitedFetch(url: string, accept = "application/json"): Promise<Response> {
  const gap = Date.now() - lastRequestAt;
  if (gap < REQUEST_INTERVAL_MS) {
    await sleep(REQUEST_INTERVAL_MS - gap);
  }
  lastRequestAt = Date.now();

  const res = await fetch(url, {
    headers: {
      "User-Agent": buildUserAgent(),
      Accept: accept,
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  }
  return res;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch the fractional price change for a ticker over the prior 90 days using
 * Yahoo Finance's public chart API.  Returns null on any error or if the ticker
 * is unknown — callers should treat null as "data unavailable".
 */
export async function fetchPriceChange90d(ticker: string): Promise<number | null> {
  if (!ticker || ticker === "N/A") return null;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=3mo`;
  try {
    const res = await yfFetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      chart?: { result?: Array<{ indicators?: { quote?: Array<{ close?: number[] }> } }> };
    };
    const closes = body?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!closes || closes.length < 2) return null;

    // First and last non-null closes
    const first = closes.find((c) => c != null);
    const last = [...closes].reverse().find((c) => c != null);
    if (first == null || last == null || first === 0) return null;

    return (last - first) / first;
  } catch {
    return null;
  }
}

// Strip leading zeros to match EDGAR archive folder naming
function normaliseCik(cik: string): string {
  return String(parseInt(cik, 10));
}

// Convert "0001234567-25-000001" → "000123456725000001"
function accessionNoDashes(accNo: string): string {
  return accNo.replace(/-/g, "");
}

/**
 * Fetch recent Form 4 filings from EDGAR EFTS full-text search.
 * daysBack: how many calendar days to look back (default 2)
 * pageSize: number of results to fetch (max 40 per page, EFTS limit)
 */
export async function fetchRecentForm4Filings(
  daysBack = 2,
  pageSize = 40
): Promise<Form4FilingMeta[]> {
  const end = new Date();
  const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  const url =
    `${EFTS_BASE}?q=%22%22&forms=4` +
    `&dateRange=custom&startdt=${startStr}&enddt=${endStr}` +
    `&from=0&size=${pageSize}`;

  console.log(`  Querying EDGAR EFTS: ${startStr} → ${endStr} (up to ${pageSize} filings)`);

  const res = await rateLimitedFetch(url);
  const body = (await res.json()) as EftsResponse;

  const hits = body?.hits?.hits ?? [];
  return hits
    .filter((h) => h._source.form_type === "4")
    .map((h) => ({
      accessionNo: h._source.accession_no,
      cik: normaliseCik(h._source.entity_id),
      entityName: h._source.entity_name,
      filedAt: h._source.filed_at,
    }));
}

const ACTIVIST_FORMS = ["SC 13D", "SC 13D/A", "SC 13G", "SC 13G/A"] as const;

/**
 * Fetch recent SC 13D / 13G filings from EDGAR EFTS.
 */
export async function fetchRecentActivistFilings(
  daysBack = 7,
  pageSize = 40
): Promise<ActivistFilingMeta[]> {
  const end = new Date();
  const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  const formsParam = ACTIVIST_FORMS.map(encodeURIComponent).join(",");
  const url =
    `${EFTS_BASE}?q=%22%22&forms=${formsParam}` +
    `&dateRange=custom&startdt=${startStr}&enddt=${endStr}` +
    `&from=0&size=${pageSize}`;

  console.log(`  Querying EDGAR EFTS (13D/13G): ${startStr} → ${endStr}`);

  const res = await rateLimitedFetch(url);
  const body = (await res.json()) as EftsResponse;

  return (body?.hits?.hits ?? [])
    .filter((h) => ACTIVIST_FORMS.includes(h._source.form_type as typeof ACTIVIST_FORMS[number]))
    .map((h) => ({
      accessionNo: h._source.accession_no,
      cik: normaliseCik(h._source.entity_id),
      filerName: h._source.entity_name,
      filedAt: h._source.filed_at,
      formType: h._source.form_type,
    }));
}

/**
 * Download the primary document for a 13D/13G filing.
 * Returns the raw HTML/text content and the public URL, or null on failure.
 */
export async function fetchActivistFilingDoc(
  cik: string,
  accessionNo: string
): Promise<{ text: string; filingUrl: string } | null> {
  const accND = accessionNoDashes(accessionNo);
  const indexUrl = `${EDGAR_ARCHIVE}/${cik}/${accND}/${accND}-index.htm`;

  let indexHtml: string;
  try {
    const res = await rateLimitedFetch(indexUrl, "text/html");
    indexHtml = await res.text();
  } catch (err) {
    console.warn(`    ⚠ Could not fetch index for ${accessionNo}: ${(err as Error).message}`);
    return null;
  }

  // Prefer .htm document; fall back to .txt
  const htmMatch = indexHtml.match(/href="(\/Archives\/edgar\/data\/[^"]+\.htm)"/i);
  const txtMatch = indexHtml.match(/href="(\/Archives\/edgar\/data\/[^"]+\.txt)"/i);
  const docPath = (htmMatch ?? txtMatch)?.[1];

  if (!docPath) {
    console.warn(`    ⚠ No document found in filing index for ${accessionNo}`);
    return null;
  }

  const docUrl = `${EDGAR_WWW}${docPath}`;
  try {
    const res = await rateLimitedFetch(docUrl, "text/html");
    const text = await res.text();
    return { text, filingUrl: docUrl };
  } catch (err) {
    console.warn(`    ⚠ Could not fetch doc ${docUrl}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Discover and download the Form 4 XML for a given filing.
 * Returns raw XML string or null if not found.
 */
export async function fetchFilingXml(
  cik: string,
  accessionNo: string
): Promise<{ xml: string; filingUrl: string } | null> {
  const accND = accessionNoDashes(accessionNo);
  const folderUrl = `${EDGAR_ARCHIVE}/${cik}/${accND}`;
  const indexUrl = `${folderUrl}/${accND}-index.htm`;
  const filingUrl = `${EDGAR_WWW}/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&dateb=&owner=include&count=1`;

  let indexHtml: string;
  try {
    const res = await rateLimitedFetch(indexUrl, "text/html");
    indexHtml = await res.text();
  } catch (err) {
    console.warn(`    ⚠ Could not fetch index for ${accessionNo}: ${(err as Error).message}`);
    return null;
  }

  // Look for the primary XML document in the filing index table
  // EDGAR index pages list docs as: href="/Archives/edgar/data/{cik}/{accND}/filename.xml"
  const xmlHrefMatch = indexHtml.match(
    /href="(\/Archives\/edgar\/data\/[^"]+\.xml)"/i
  );
  if (!xmlHrefMatch) {
    console.warn(`    ⚠ No XML found in filing index for ${accessionNo}`);
    return null;
  }

  const xmlUrl = `${EDGAR_WWW}${xmlHrefMatch[1]}`;
  try {
    const res = await rateLimitedFetch(xmlUrl, "application/xml");
    const xml = await res.text();
    return { xml, filingUrl: xmlUrl };
  } catch (err) {
    console.warn(`    ⚠ Could not fetch XML ${xmlUrl}: ${(err as Error).message}`);
    return null;
  }
}
