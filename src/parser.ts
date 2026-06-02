import { XMLParser } from "fast-xml-parser";
import { NonDerivativeTransaction, ParsedForm4 } from "./types.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Some Form 4 fields wrap values in a <value> child element
  isArray: (name) => ["nonDerivativeTransaction", "reportingOwner"].includes(name),
});

function safeNum(val: unknown): number {
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

function safeStr(val: unknown): string {
  if (val === undefined || val === null) return "";
  if (typeof val === "object") {
    // Handle <value>text</value> pattern — fast-xml-parser returns { value: "text" }
    const asRecord = val as Record<string, unknown>;
    if ("value" in asRecord) return String(asRecord.value ?? "");
  }
  return String(val);
}

export function parseForm4Xml(xml: string): ParsedForm4 | null {
  let doc: Record<string, unknown>;

  try {
    doc = xmlParser.parse(xml) as Record<string, unknown>;
  } catch {
    return null;
  }

  const root = (doc["ownershipDocument"] ?? doc["ownershipDocuments"]) as
    | Record<string, unknown>
    | undefined;
  if (!root) return null;

  // ── Issuer ────────────────────────────────────────────────────────────────
  const issuer = (root["issuer"] ?? {}) as Record<string, unknown>;
  const issuerName = safeStr(issuer["issuerName"]);
  const issuerTicker = safeStr(issuer["issuerTradingSymbol"]);

  // ── Reporting owner ───────────────────────────────────────────────────────
  // fast-xml-parser always returns an array for reportingOwner (isArray config)
  const owners = (root["reportingOwner"] ?? []) as Record<string, unknown>[];
  const owner = owners[0] ?? {};

  const ownerId = (owner["reportingOwnerId"] ?? {}) as Record<string, unknown>;
  const ownerRel = (owner["reportingOwnerRelationship"] ?? {}) as Record<string, unknown>;

  const reportingOwnerName = safeStr(ownerId["rptOwnerName"]);
  const reportingOwnerTitle =
    safeStr(ownerRel["officerTitle"]) ||
    (ownerRel["isDirector"] === "1" || ownerRel["isDirector"] === 1 ? "Director" : "") ||
    (ownerRel["isTenPercentOwner"] === "1" || ownerRel["isTenPercentOwner"] === 1
      ? "10% Owner"
      : "") ||
    "Unknown";

  // ── Non-derivative transactions ───────────────────────────────────────────
  const ndTable = (root["nonDerivativeTable"] ?? {}) as Record<string, unknown>;
  const rawTxns = (ndTable["nonDerivativeTransaction"] ?? []) as Record<string, unknown>[];

  const transactions: NonDerivativeTransaction[] = rawTxns.map((txn) => {
    const coding = (txn["transactionCoding"] ?? {}) as Record<string, unknown>;
    const amounts = (txn["transactionAmounts"] ?? {}) as Record<string, unknown>;
    const adCode = amounts["transactionAcquiredDisposedCode"] as Record<string, unknown> | undefined;

    return {
      transactionCode: safeStr(coding["transactionCode"]),
      transactionDate: safeStr(
        (txn["transactionDate"] as Record<string, unknown> | undefined)?.["value"] ??
          txn["transactionDate"]
      ),
      transactionShares: safeNum(
        (amounts["transactionShares"] as Record<string, unknown> | undefined)?.["value"] ??
          amounts["transactionShares"]
      ),
      transactionPricePerShare: safeNum(
        (amounts["transactionPricePerShare"] as Record<string, unknown> | undefined)?.["value"] ??
          amounts["transactionPricePerShare"]
      ),
      acquiredDisposedCode: safeStr(adCode?.["value"] ?? adCode),
    };
  });

  return { issuerName, issuerTicker, reportingOwnerName, reportingOwnerTitle, transactions };
}
