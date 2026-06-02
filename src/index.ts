import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { RedditClient } from "./redditClient.js";
import { RedditPost } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const client = new RedditClient(
    requireEnv("REDDIT_CLIENT_ID"),
    requireEnv("REDDIT_CLIENT_SECRET"),
    requireEnv("REDDIT_USERNAME"),
    requireEnv("REDDIT_PASSWORD"),
    requireEnv("REDDIT_USER_AGENT")
  );

  console.log("Authenticating with Reddit...");
  await client.authenticate();

  console.log("Fetching posts from r/wallstreetbets...");
  const [hot, newPosts, top] = await Promise.all([
    client.fetchHot(),
    client.fetchNew(),
    client.fetchTop24h(),
  ]);

  // Deduplicate by permalink
  const seen = new Set<string>();
  const all: RedditPost[] = [];
  for (const post of [...hot, ...newPosts, ...top]) {
    if (!seen.has(post.permalink)) {
      seen.add(post.permalink);
      all.push(post);
    }
  }

  const outputDir = path.resolve(__dirname, "../data");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, "posts.json");
  fs.writeFileSync(outputPath, JSON.stringify(all, null, 2), "utf-8");

  console.log(`Fetched ${all.length} posts.`);
  console.log("Saved to posts.json.");
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
