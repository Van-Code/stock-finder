import axios, { AxiosInstance } from "axios";
import {
  RedditPost,
  RedditTokenResponse,
  RedditListing,
} from "./types.js";

const SUBREDDIT = "wallstreetbets";
const LIMIT = 100;

export class RedditClient {
  private http: AxiosInstance;
  private token: string | null = null;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private username: string,
    private password: string,
    private userAgent: string
  ) {
    this.http = axios.create({ baseURL: "https://oauth.reddit.com" });
  }

  async authenticate(): Promise<void> {
    const response = await axios.post<RedditTokenResponse>(
      "https://www.reddit.com/api/v1/access_token",
      new URLSearchParams({ grant_type: "password", username: this.username, password: this.password }),
      {
        auth: { username: this.clientId, password: this.clientSecret },
        headers: {
          "User-Agent": this.userAgent,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    this.token = response.data.access_token;
    this.http.defaults.headers.common["Authorization"] = `Bearer ${this.token}`;
    this.http.defaults.headers.common["User-Agent"] = this.userAgent;
  }

  private async fetchListing(
    endpoint: string,
    params: Record<string, string | number>
  ): Promise<RedditListing> {
    const response = await this.http.get<RedditListing>(endpoint, { params });
    return response.data;
  }

  private mapChildren(
    listing: RedditListing,
    source: RedditPost["source"]
  ): RedditPost[] {
    return listing.data.children.map((child) => ({
      title: child.data.title,
      selftext: child.data.selftext,
      score: child.data.score,
      upvote_ratio: child.data.upvote_ratio,
      author: child.data.author,
      created_utc: child.data.created_utc,
      num_comments: child.data.num_comments,
      permalink: child.data.permalink,
      source,
    }));
  }

  async fetchHot(): Promise<RedditPost[]> {
    const listing = await this.fetchListing(`/r/${SUBREDDIT}/hot`, { limit: LIMIT });
    return this.mapChildren(listing, "hot");
  }

  async fetchNew(): Promise<RedditPost[]> {
    const listing = await this.fetchListing(`/r/${SUBREDDIT}/new`, { limit: LIMIT });
    return this.mapChildren(listing, "new");
  }

  async fetchTop24h(): Promise<RedditPost[]> {
    const listing = await this.fetchListing(`/r/${SUBREDDIT}/top`, { limit: LIMIT, t: "day" });
    return this.mapChildren(listing, "top");
  }
}
