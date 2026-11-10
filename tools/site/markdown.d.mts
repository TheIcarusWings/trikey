// Types for markdown.mjs (used by the TypeScript tests in e2e/test/unit/site-blog.test.ts).
export interface MarkdownOptions {
  /** Headings below this level are an error (2 for posts: the title is the only h1). */
  minHeading?: number;
  /**
   * Returns an error message for a bad link to this site, null when it's fine, or { asText: true } to render the
   * link's words without the link (a queued post that isn't published yet).
   */
  checkInternal?: (href: string) => string | null | { asText: true };
  /** Returns the image's size, an error message, or null when unknown. */
  image?: (src: string) => { width: number; height: number } | string | null;
}
export interface MarkdownResult {
  html: string;
  headings: { level: number; text: string; id: string }[];
  errors: string[];
}
export function escapeHtml(s: string): string;
export function slugify(text: string): string;
export function checkUrl(raw: string): { href: string; external: boolean };
export function plainText(src: string): string;
export function markdownToHtml(markdown: string, options?: MarkdownOptions): MarkdownResult;
export function wordCount(markdown: string): number;
