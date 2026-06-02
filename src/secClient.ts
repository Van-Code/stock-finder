import "dotenv/config";
import { EftsResponse, Form4FilingMeta } from "./types.js";

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
