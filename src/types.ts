// ── EDGAR EFTS search response ──────────────────────────────────────────────

export interface EftsHitSource {
  accession_no: string;   // e.g. "0001234567-25-000001"
  entity_id: string;      // filer CIK (numeric string, may have leading zeros)
  entity_name: string;    // reporting owner name from EDGAR
  filed_at: string;       // ISO 8601 timestamp
  period_of_report: string;
  form_type: string;
}

export interface EftsHit {
  _id: string;
  _source: EftsHitSource;
}

export interface EftsResponse {
  hits: {
    total: { value: number; relation: string };
    hits: EftsHit[];
  };
}

// ── Filing metadata (internal use) ──────────────────────────────────────────

export interface Form4FilingMeta {
  accessionNo: string;  // with dashes
  cik: string;          // numeric, no leading zeros
  entityName: string;
  filedAt: string;
}

// ── Parsed Form 4 transaction data ──────────────────────────────────────────

export interface NonDerivativeTransaction {
  transactionCode: string;
  transactionDate: string;
  transactionShares: number;
  transactionPricePerShare: number;
  acquiredDisposedCode: string;
}

export interface ParsedForm4 {
  issuerName: string;
  issuerTicker: string;
  reportingOwnerName: string;
  reportingOwnerTitle: string;
  transactions: NonDerivativeTransaction[];
}

// ── Output record ────────────────────────────────────────────────────────────

export interface InsiderPurchase {
  ticker: string;
  companyName: string;
  insiderName: string;
  insiderTitle: string;
  transactionDate: string;
  shares: number;
  price: number;
  totalValue: number;
  filingUrl: string;
  transactionCode: string;
}

export interface ScoredPurchase extends InsiderPurchase {
  signalScore: number;
  verdict: string;
  scoreBreakdown: string[];
}

// ── Activist / 13D / 13G signal ──────────────────────────────────────────────

export interface ActivistFilingMeta {
  accessionNo: string;
  cik: string;          // filer (activist) CIK
  filerName: string;    // entity_name from EFTS — the reporting person
  filedAt: string;
  formType: string;     // SC 13D | SC 13D/A | SC 13G | SC 13G/A
}

export interface ParsedActivistDoc {
  subjectCompanyName: string;
  ticker: string;
  ownershipPercent: number | null;
  previousOwnershipPercent: number | null; // from amendment text if detectable
  isIncreasingStake: boolean;
  activistKeywordsFound: string[];
  rawText: string;
}

export interface ActivistSignal {
  ticker: string;
  companyName: string;
  filerName: string;
  ownershipPercent: number | null;
  filingDate: string;
  filingUrl: string;
  formType: string;
  activistScore: number;
  verdict: string;
  scoreBreakdown: string[];
}

// ── Cluster signal (aggregated per-ticker view) ───────────────────────────────

export interface ClusterSignal {
  ticker: string;
  companyName: string;
  uniqueInsiders: number;
  insiderNames: string[];
  totalPurchaseValue: number;
  avgPurchaseSize: number;
  ceoOrCfoBought: boolean;
  earliestDate: string;
  latestDate: string;
  windowDays: number;        // calendar days between first and last purchase
  clusterScore: number;
  verdict: string;
  scoreBreakdown: string[];
}
