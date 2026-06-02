import { ParsedActivistDoc } from "./types.js";

// ── Known activist investor keywords ─────────────────────────────────────────
// Matched against filer name and filing text (Item 4 "Purpose of Transaction")

export const ACTIVIST_FIRM_KEYWORDS = [
  "icahn", "starboard", "trian", "elliott", "pershing square", "third point",
  "jana partners", "corvex", "valueact", "greenlight", "paulson", "ackman",
  "legion partners", "barington", "ancora", "engine capital", "blue harbour",
  "land & buildings", "orange capital", "sandell", "impactive", "sachem head",
  "inclusive capital", "quentin tarantino",  // last one is a sanity-check placeholder — removed in prod
];

export const ACTIVIST_INTENT_KEYWORDS = [
  "board representation", "board seat", "change of control", "strategic alternatives",
  "proxy contest", "proxy fight", "governance", "shareholder value", "spin-off",
  "divestiture", "sale of the company", "strategic review", "maximize shareholder",
  "enhance shareholder", "operational improvement", "cost reduction",
];

// Strip HTML tags for text analysis
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Extract the first percentage value from text near "percent of class" or "row 13"
function parseOwnershipPercent(text: string): number | null {
  // Cover page row 13 pattern: "13." then a percentage on the same or next line
  const coverPatterns = [
    /13\s*[.)]\s*(?:percent of class[^%\n]{0,60})?\s*([\d]+\.[\d]+)\s*%/i,
    /13\s*[.)][^%\n]{0,80}([\d]+\.[\d]+)\s*%/i,
    /percent of class[^%\n]{0,80}([\d]+\.[\d]+)\s*%/i,
    /aggregate\s+(?:amount|percentage)[^%\n]{0,80}([\d]+\.[\d]+)\s*%/i,
    // Fallback: any decimal percentage that looks like an ownership stake (not 100%)
    /beneficially\s+owns?\s+(?:approximately\s+)?([\d]+\.[\d]+)\s*%/i,
  ];

  for (const pattern of coverPatterns) {
    const m = text.match(pattern);
    if (m) {
      const val = parseFloat(m[1]);
      if (!isNaN(val) && val > 0 && val <= 100) return val;
    }
  }
  return null;
}

// For amendments: try to find a *previous* ownership percentage (before/after pattern)
function parsePreviousOwnershipPercent(text: string): number | null {
  const patterns = [
    /previously\s+(?:reported|beneficially owned)[\s\S]{0,100}?([\d]+\.[\d]+)\s*%/i,
    /(?:prior|before)[^%\n]{0,60}([\d]+\.[\d]+)\s*%/i,
    /increased\s+from\s+([\d]+\.[\d]+)\s*%/i,
    /from\s+([\d]+\.[\d]+)\s*%\s+to\s+[\d]+\.[\d]+\s*%/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const val = parseFloat(m[1]);
      if (!isNaN(val) && val > 0 && val <= 100) return val;
    }
  }
  return null;
}

// Extract the subject company ticker from common patterns in 13D/G text
function parseTicker(text: string): string {
  const patterns = [
    /\b(?:Nasdaq|NYSE|NYSE\s*MKT|NYSE\s*Arca|Nasdaq\s*Global)\s*[:\-–]\s*([A-Z]{1,5})\b/,
    /ticker\s+symbol[^"'A-Z]{0,10}["']?([A-Z]{1,5})["']?/i,
    /trading\s+symbol[^"'A-Z]{0,10}["']?([A-Z]{1,5})["']?/i,
    /\bsymbol\s+"([A-Z]{1,5})"/i,
    /\(the\s+"Shares"\)[^.]{0,200}(?:Nasdaq|NYSE)[^\)]{0,40}\(([A-Z]{1,5})\)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return "";
}

// Extract the subject company name from Item 1 or the cover page
function parseSubjectCompany(text: string): string {
  // "This statement relates to ... of [Company Name]"
  const patterns = [
    /(?:this\s+statement\s+(?:on\s+schedule\s+13[dg]\s+)?(?:is\s+being\s+filed\s+)?(?:relates|pertains)\s+to)[^.]{0,20}(?:shares?|stock|securities?)\s+of\s+([A-Z][^,(.\n]{3,60}?)(?:\s+\(the|,|\.|$)/im,
    /(?:issuer|subject\s+company)[:\s]+([A-Z][^\n,.(]{3,60}?)(?:\s*[\n,.(])/im,
    /name\s+of\s+issuer[:\s]+([A-Z][^\n]{3,60}?)(?:\s*[\n])/im,
    /securities\s+of\s+([A-Z][^,(.\n]{3,60}?)(?:\s+\(|,|\.|$)/im,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) {
      return m[1].replace(/\s+/g, " ").trim().slice(0, 80);
    }
  }
  return "";
}

function findActivistKeywords(text: string, filerName: string): string[] {
  const found: string[] = [];
  const combined = (filerName + " " + text).toLowerCase();

  for (const kw of ACTIVIST_FIRM_KEYWORDS) {
    if (kw !== "quentin tarantino" && combined.includes(kw)) {
      found.push(kw);
    }
  }
  for (const kw of ACTIVIST_INTENT_KEYWORDS) {
    if (combined.includes(kw)) {
      found.push(kw);
    }
  }
  return [...new Set(found)];
}

export function parseActivistDoc(
  rawHtml: string,
  formType: string,
  filerName: string
): ParsedActivistDoc {
  const text = stripHtml(rawHtml);

  const ownershipPercent = parseOwnershipPercent(text);
  const previousOwnershipPercent = formType.includes("/A")
    ? parsePreviousOwnershipPercent(text)
    : null;

  const isIncreasingStake =
    (previousOwnershipPercent !== null &&
      ownershipPercent !== null &&
      ownershipPercent > previousOwnershipPercent) ||
    // text-only heuristic when explicit % comparison isn't available
    (formType.includes("/A") &&
      previousOwnershipPercent === null &&
      /(?:increased|additional|acquired\s+additional|purchased\s+additional)/i.test(text));

  return {
    subjectCompanyName: parseSubjectCompany(text),
    ticker: parseTicker(text),
    ownershipPercent,
    previousOwnershipPercent,
    isIncreasingStake,
    activistKeywordsFound: findActivistKeywords(text, filerName),
    rawText: text.slice(0, 8000), // keep first 8k chars for scoring context
  };
}
