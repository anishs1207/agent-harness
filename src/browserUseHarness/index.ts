import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

export class BrowserSession {
    private browser: Browser | null = null;
    private page: Page | null = null;

    async open(options?: { headless?: boolean }): Promise<void> {
        const headless = options?.headless ?? (process.env.HEADLESS === "true");
        this.browser = await chromium.launch({ headless });
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

    async getTitle(): Promise<string> {
        return await this.page!.title();
    }

    async getText(): Promise<string> {
        const text = await this.page!.innerText("body");
        return text.slice(0, 4000);
    }

    async snapshot(): Promise<string> {
        const snapshot = await this.page!.locator("body").ariaSnapshot({ timeout: 10000 });
        return snapshot.slice(0, 12000);
    }

    async inspect(selector: string = "a, button, input, select, textarea, [role], [contenteditable='true']"): Promise<string> {
        const elements = await this.page!.locator(selector).evaluateAll((nodes) =>
            nodes.slice(0, 200).map((node, index) => {
                const element = node as HTMLElement;
                const input = node as HTMLInputElement;
                const rect = element.getBoundingClientRect();
                return {
                    index,
                    tag: element.tagName.toLowerCase(),
                    role: element.getAttribute("role"),
                    name: element.getAttribute("aria-label") || element.innerText?.trim() || input.placeholder || input.name || "",
                    id: element.id || null,
                    nameAttribute: input.name || null,
                    type: input.type || null,
                    value: input.value || null,
                    disabled: input.disabled || element.getAttribute("aria-disabled") === "true",
                    visible: rect.width > 0 && rect.height > 0,
                };
            })
        );
        return JSON.stringify(elements, null, 2).slice(0, 12000);
    }

    async clickByRole(role: string, name: string, exact: boolean = true): Promise<string> {
        const locator = this.page!.getByRole(role as Parameters<Page["getByRole"]>[0], { name, exact }).first();
        await locator.click({ timeout: 10000 });
        await this.page!.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
        return `Clicked role=${JSON.stringify(role)} name=${JSON.stringify(name)}; now at ${this.page!.url()}`;
    }

    async fillByLabel(label: string, value: string): Promise<string> {
        await this.page!.getByLabel(label, { exact: true }).first().fill(value, { timeout: 10000 });
        return `Filled field labelled ${JSON.stringify(label)}`;
    }

    async getAttribute(selector: string, attribute: string): Promise<string> {
        const value = await this.page!.locator(selector).first().getAttribute(attribute);
        return JSON.stringify(value);
    }

    async fill(selector: string, value: string): Promise<string> {
        await this.page!.fill(selector, value);
        return `Filled "${selector}"`;
    }

    async click(selector: string): Promise<string> {
        // Capture the id of the element before clicking (navigation may change the page)
        const elementId = await this.page!.locator(selector).first().getAttribute("id").catch(() => null);

        await this.page!.click(selector, { timeout: 10000 });
        await this.page!.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});

        const clicked = elementId ? `element id="${elementId}"` : `"${selector}"`;
        return `Clicked ${clicked} — now at ${this.page!.url()}`;
    }

    async pressKey(key: string): Promise<string> {
        await this.page!.keyboard.press(key);
        return `Pressed key "${key}"`;
    }

    async selectOption(selector: string, value: string): Promise<string> {
        await this.page!.selectOption(selector, value);
        return `Selected option "${value}" for "${selector}"`;
    }

    async scroll(deltaX: number = 0, deltaY: number = 300): Promise<string> {
        await this.page!.mouse.wheel(deltaX, deltaY);
        return `Scrolled by (${deltaX}, ${deltaY})`;
    }

    async wait(duration: number = 1000): Promise<string> {
        await this.page!.waitForTimeout(duration);
        return `Waited for ${duration}ms`;
    }

    async waitForSelector(selector: string, timeout: number = 5000): Promise<string> {
        await this.page!.waitForSelector(selector, { timeout });
        return `Element "${selector}" is now visible`;
    }

    async screenshot(): Promise<string> {
        const buffer = await this.page!.screenshot({ type: "png" });
        return `Captured screenshot (${buffer.length} bytes)`;
    }

    async evaluate(expression: string): Promise<string> {
        const result = await this.page!.evaluate((expr) => {
            return eval(expr);
        }, expression);
        return `Result: ${JSON.stringify(result)}`;
    }

    async setContent(html: string): Promise<string> {
        await this.page!.setContent(html, { waitUntil: "domcontentloaded" });
        return "Test page content loaded";
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
