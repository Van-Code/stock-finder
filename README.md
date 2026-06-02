# Stock Finder

Collects posts from r/wallstreetbets via the Reddit API for stock ticker analysis.

## Phase 1 — Reddit Data Collection

Fetches posts from `hot`, `new`, and `top (24h)` feeds and saves them to `./data/posts.json`.

### Setup

**1. Create a Reddit app**

Go to https://www.reddit.com/prefs/apps and create a "script" type app. Note the client ID (under the app name) and client secret.

**2. Configure credentials**

```bash
cp .env.example .env
```

Fill in `.env`:

```
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
REDDIT_USERNAME=your_reddit_username
REDDIT_PASSWORD=your_reddit_password
REDDIT_USER_AGENT=stock-finder/1.0 by your_reddit_username
```

**3. Install dependencies**

```bash
npm install
```

**4. Run**

```bash
# Development (no build step)
npm run dev

# Production
npm run build && npm start
```

### Output

Posts are saved to `./data/posts.json`. Each entry contains:

| Field | Description |
|---|---|
| `title` | Post title |
| `selftext` | Post body text |
| `score` | Net upvotes |
| `upvote_ratio` | Ratio of upvotes to total votes |
| `author` | Reddit username |
| `created_utc` | Unix timestamp of creation |
| `num_comments` | Number of comments |
| `permalink` | Relative URL path to the post |
| `source` | Feed it was collected from (`hot`, `new`, `top`) |

Duplicate posts (appearing in multiple feeds) are deduplicated by permalink.

### Expected output

```
Authenticating with Reddit...
Fetching posts from r/wallstreetbets...
Fetched 247 posts.
Saved to posts.json.
```
