// Types for build-blog.mjs (used by the TypeScript tests in e2e/test/unit/site-blog.test.ts).
export const SITE_URL: string;
export const SITE_DIR: string;
export const GENERATED_MARKER: string;
export class BuildError extends Error {
  errors: string[];
}
export interface Post {
  title: string;
  description: string;
  date: string;
  updated: string | null;
  slug: string;
  keywords: string[];
  draft: boolean;
  queue: number | null;
  image: string | null;
  imageAlt: string | null;
  html?: string;
  words?: number;
  minutes?: number;
}
export function parseFrontMatter(text: string, file?: string): { data: Record<string, unknown>; body: string };
export function validatePost(
  data: Record<string, unknown>,
  file: string,
  fileSlug: string,
): { post: Post | null; errors: string[]; warnings: string[] };
export function formatDate(iso: string): string;
export function jsonLd(value: unknown): string;
export function htmlText(html: string): string;
export function urlPathFor(rel: string): string;
export function fileForPath(siteDir: string, urlPath: string): string | null;
export function isNoindex(html: string): boolean;
export function indexablePages(siteDir: string, overrides?: Map<string, string>): { path: string; lastmod: string | null }[];
export function withFaqJsonLd(html: string): string;
export function buildSite(
  siteDir?: string,
  options?: { drafts?: boolean },
): { files: Map<string, string>; posts: Post[]; warnings: string[] };
export function staleFiles(siteDir: string, files: Map<string, string>): string[];
export function diffSite(siteDir: string, files: Map<string, string>): string[];
export function writeSite(siteDir: string, files: Map<string, string>): { written: string[]; removed: string[] };
export function queuedPosts(siteDir?: string): { slug: string; title: string; queue: number; path: string }[];
export function publishedSource(text: string, today: string): string;
