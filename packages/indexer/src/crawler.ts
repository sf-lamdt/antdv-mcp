import puppeteer, { Browser } from 'puppeteer';
import * as cheerio from 'cheerio';
import * as crypto from 'crypto';
import { Version } from '@antdv-mcp/shared';

export interface CrawlerOptions {
  userAgent?: string;
  delayMs?: number;
  waitForSelector?: string;
  timeout?: number;
}

export class Crawler {
  private userAgent: string;
  private delayMs: number;
  private waitForSelector: string;
  private timeout: number;
  private lastFetchTime: number = 0;
  private browser: Browser | null = null;

  constructor(options: CrawlerOptions = {}) {
    this.userAgent =
      options.userAgent || 'antdv-mcp-indexer/1.0 (Documentation Indexer)';
    this.delayMs = options.delayMs || 1000;
    this.waitForSelector = options.waitForSelector || '#app .main-container, #app .main-wrapper, #app article, #app .markdown';
    this.timeout = options.timeout || 30000;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }
    return this.browser;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private async delay() {
    const now = Date.now();
    const elapsed = now - this.lastFetchTime;
    if (elapsed < this.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs - elapsed));
    }
    this.lastFetchTime = Date.now();
  }

  async fetchPage(url: string): Promise<{ html: string; sha256: string }> {
    await this.delay();

    console.log(`Fetching: ${url}`);
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();

    try {
      await page.setUserAgent(this.userAgent);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: this.timeout });

      // Wait for SPA content to render
      try {
        await page.waitForSelector(this.waitForSelector, { timeout: this.timeout });
      } catch {
        console.warn(`Warning: selector "${this.waitForSelector}" not found on ${url}, using page as-is`);
      }

      const html = await page.content();
      const sha256 = crypto.createHash('sha256').update(html).digest('hex');

      return { html, sha256 };
    } finally {
      await page.close();
    }
  }

  extractText(html: string): string {
    const $ = cheerio.load(html);
    // Remove script and style elements
    $('script, style').remove();
    return $('body').text().replace(/\s+/g, ' ').trim();
  }

  async discoverComponents(version: Version): Promise<Array<{ url: string; title: string }>> {
    const overviewUrl =
      version === 'v3'
        ? 'https://3x.antdv.com/components/overview/'
        : 'https://antdv.com/components/overview/';

    const { html } = await this.fetchPage(overviewUrl);
    const $ = cheerio.load(html);
    const components: Array<{ url: string; title: string }> = [];

    // Find component links in the overview page
    const baseUrl = version === 'v3' ? 'https://3x.antdv.com' : 'https://antdv.com';

    $('a[href*="/components/"]').each((_, el) => {
      const href = $(el).attr('href');
      const title = $(el).text().trim();

      if (
        href &&
        title &&
        href.includes('/components/') &&
        !href.includes('/overview')
      ) {
        const fullUrl = href.startsWith('http') ? href : `${baseUrl}${href}`;
        if (!components.find((c) => c.url === fullUrl)) {
          components.push({ url: fullUrl, title });
        }
      }
    });

    return components;
  }

  extractComponentTag(url: string, $: cheerio.CheerioAPI): string {
    // Extract component tag from URL: /components/button-cn -> button
    const match = url.match(/\/components\/([^/]+)/);
    if (match) {
      const name = match[1];
      // Convert to tag format: button -> a-button
      return name.startsWith('a-') ? name : `a-${name}`;
    }

    // Fallback: try to find in page content
    const code = $('code').first().text();
    const tagMatch = code.match(/<(a-[a-z-]+)/);
    if (tagMatch) {
      return tagMatch[1];
    }

    throw new Error(`Could not extract component tag from ${url}`);
  }

  extractTitle($: cheerio.CheerioAPI): string {
    // Try h1 first
    const h1 = $('h1').first().text().trim();
    if (h1) return h1;

    // Try title tag
    const title = $('title').text().trim();
    if (title) return title;

    return 'Unknown';
  }
}
