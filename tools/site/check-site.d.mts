// Types for check-site.mjs (used by the TypeScript tests in e2e/test/unit/site-blog.test.ts).
export function checkXml(xml: string): string[];
export function checkPage(siteDir: string, rel: string, html: string): string[];
export function checkSite(siteDir?: string): string[];
