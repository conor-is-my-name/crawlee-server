CREATE TABLE scraped_articles (
    id SERIAL PRIMARY KEY,
    sitehomepage TEXT NOT NULL,
    article_url TEXT NOT NULL UNIQUE,
    title TEXT,
    bodyText TEXT,
    datePublished TIMESTAMP WITH TIME ZONE,
    articlecategories TEXT[],
    tags TEXT[],
    keywords TEXT[],
    author TEXT,
    featuredImage TEXT,
    comments JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);