export interface RedditPost {
  title: string;
  selftext: string;
  score: number;
  upvote_ratio: number;
  author: string;
  created_utc: number;
  num_comments: number;
  permalink: string;
  source: "hot" | "new" | "top";
}

export interface RedditTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export interface RedditListingChild {
  kind: string;
  data: {
    title: string;
    selftext: string;
    score: number;
    upvote_ratio: number;
    author: string;
    created_utc: number;
    num_comments: number;
    permalink: string;
  };
}

export interface RedditListing {
  kind: string;
  data: {
    children: RedditListingChild[];
    after: string | null;
    before: string | null;
  };
}
