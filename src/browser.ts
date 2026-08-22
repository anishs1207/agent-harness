import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

export class BrowserSession {
    private browser: Browser | null = null;
    private page: Page | null = null;

    async open(): Promise<void> {
        this.browser = await chromium.launch({ headless: false });
        const context = await this.browser.newContext();
        this.page = await context.newPage();
    }

    async navigate(url: string): Promise<string> {
        await this.page!.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        return `Navigated to ${url}`;
    }

    async getUrl(): Promise<string> {
        return this.page!.url();
    }

    async getText(): Promise<string> {
        const text = await this.page!.innerText("body");
        return text.slice(0, 4000);
    }

    async fill(selector: string, value: string): Promise<string> {
        await this.page!.fill(selector, value);
        return `Filled "${selector}"`;
    }

    async click(selector: string): Promise<string> {
        // Capture the id of the element before clicking (navigation may change the page)
        const elementId = await this.page!.locator(selector).first().getAttribute("id");

        await this.page!.click(selector, { timeout: 10000 });
        await this.page!.waitForLoadState("domcontentloaded", { timeout: 10000 });

        const clicked = elementId ? `element id="${elementId}"` : `"${selector}"`;
        return `Clicked ${clicked} — now at ${this.page!.url()}`;
    }

    // Returns a structured list of HN front-page stories so the agent can
    // correlate story IDs, titles, ranks, and voted status precisely.
    async getStories(): Promise<string> {
        const stories = await this.page!.evaluate(() => {
            return Array.from(document.querySelectorAll(".athing")).map((row, i) => {
                const id = row.id;
                const title = row.querySelector(".titleline a")?.textContent?.trim() ?? "(no title)";
                const upvoteEl = document.querySelector(`#up_${id}`);
                const alreadyVoted = upvoteEl?.classList.contains("nosee") ?? true;
                return { rank: i + 1, id, title, alreadyVoted };
            });
        });
        return JSON.stringify(stories, null, 2);
    }

    async hasClass(selector: string, className: string): Promise<string> {
        const el = this.page!.locator(selector).first();
        const classes = await el.getAttribute("class") ?? "";
        const has = classes.split(" ").includes(className);
        return has ? `"${selector}" has class "${className}"` : `"${selector}" does not have class "${className}"`;
    }

    async close(): Promise<void> {
        await this.browser?.close();
        this.browser = null;
        this.page = null;
    }
}