# SEC Insider Signal Scanner

**Research tool only. Not financial advice.**

Fetches recent SEC Form 4 filings from EDGAR, parses open-market insider purchases, and saves results to a local JSON file.

---

## Phase 1 — Form 4 Collection

### What it does

1. Queries the [EDGAR EFTS search API](https://efts.sec.gov/LATEST/search-index) for recent Form 4 filings
2. Downloads each filing's XML document
3. Parses `nonDerivativeTable` transactions
4. Keeps only open-market purchases (`transactionCode = "P"`, positive shares and price)
5. Prints a console table and saves to `./data/form4-purchases.json`

### Setup

**1. Install dependencies**

```bash
npm install
```

**2. Configure environment**

```bash
cp .env.example .env
```

Edit `.env` and set your email address. The SEC requires a descriptive `User-Agent` with contact info for EDGAR API access ([SEC policy](https://www.sec.gov/os/accessing-edgar-data)).

```
SEC_CONTACT_EMAIL=you@example.com
```

**3. Run**

```bash
npm run scan
```

### Configuration

| Variable | Default | Description |
|---|---|---|
| `SEC_CONTACT_EMAIL` | required | Contact email for SEC User-Agent header |
| `DAYS_BACK` | `2` | Calendar days to look back for filings |
| `PAGE_SIZE` | `40` | Filings per run (max 40, EFTS limit) |

### Output

Results are saved to `./data/form4-purchases.json`.

Each record contains:

| Field | Description |
|---|---|
| `ticker` | Issuer trading symbol |
| `companyName` | Issuer company name |
| `insiderName` | Reporting owner name |
| `insiderTitle` | Officer title or role |
| `transactionDate` | Date of the transaction |
| `shares` | Number of shares purchased |
| `price` | Price per share |
| `totalValue` | `shares × price` |
| `filingUrl` | Direct URL to the Form 4 XML on EDGAR |

### Example output

```
═══════════════════════════════════════════════════════
  SEC Form 4 Insider Purchase Scanner  — Phase 1
  Research tool only. Not financial advice.
═══════════════════════════════════════════════════════

[1/3] Fetching recent Form 4 filings (last 2 day(s))…
      Querying EDGAR EFTS: 2025-05-31 → 2025-06-02 (up to 40 filings)
      Found 40 Form 4 filings.

[2/3] Downloading and parsing XML documents…
  [1/40] 0001234567-25-000001  ✓ 1 purchase(s) found
  [2/40] 0009876543-25-000012  – no open-market purchases
  ...

[3/3] Saving results…

  ── Open-Market Insider Purchases ─────────────────────
  ┌─────────┬──────────────────────┬──────────────────┬───────┬────────────┬───────────┬─────────┬────────────┐
  │ ticker  │ company              │ insider          │ title │ date       │ shares    │ price   │ total      │
  ├─────────┼──────────────────────┼──────────────────┼───────┼────────────┼───────────┼─────────┼────────────┤
  │ ACME    │ Acme Corp            │ Jane Smith       │ CEO   │ 2025-06-01 │ 10,000    │ $52.30  │ $523,000   │
  └─────────┴──────────────────────┴──────────────────┴───────┴────────────┴───────────┴─────────┴────────────┘

Fetched 40 Form 4 filings.
Saved to form4-purchases.json.
```

### Rate limiting

Requests are spaced ≥ 125 ms apart (~8 req/s), under the SEC's stated limit of 10 req/s. Do not run multiple instances simultaneously.

### SEC Fair Access

This tool follows SEC EDGAR fair-access expectations:
- Descriptive `User-Agent` with contact email on every request
- Rate-limited to ≤ 10 req/s
- Only fetches data needed for the scan
- No aggressive or bulk scraping

---

*Data sourced from [SEC EDGAR](https://www.sec.gov/cgi-bin/browse-edgar). For informational and research purposes only.*
