import type { BrowserSession } from "./index.js";

export type ToolEvent = {
    tool: string;
    args: Record<string, unknown>;
    result: string;
};

export type LoginHandler = () => Promise<ToolEvent | null>;

export type LoginHandlerHooks = {
    onUpvoteSuccess?: (storyId: string) => void;
};

export function createLoginHandler(
    session: BrowserSession,
    hooks?: LoginHandlerHooks
): LoginHandler {
    return async () => {
        const currentUrl = await session.getUrl();
        const isLoginPage = currentUrl.includes("login") || currentUrl.includes("vote");

        if (!isLoginPage) return null;

        console.log("\n[harness] Login redirect detected - handling automatically...");

        try {
            const username = process.env.HN_USERNAME;
            const password = process.env.HN_PASSWORD;

            if (!username || !password) {
                throw new Error("HN_USERNAME and HN_PASSWORD must be set to handle login");
            }

            await session.fill("input[name='acct']", username);
            await session.fill("input[name='pw']", password);
            await session.click("input[type='submit']");

            const postLoginUrl = await session.getUrl();
            console.log("[harness] Login completed - agent can continue\n");

            // HN's vote URL carries a `goto` param, so logging in from
            // /vote?id=NNN&how=up&goto=news completes the vote and bounces
            // back to the listing. The pre-login click already counts — flag
            // it as success so the agent doesn't re-vote on a different story.
            const upvoteId = extractUpvoteIdFromVoteUrl(currentUrl);
            if (upvoteId && hooks?.onUpvoteSuccess) {
                hooks.onUpvoteSuccess(upvoteId);
            }

            return {
                tool: "harness_auto_login",
                args: {},
                result: `Harness automatically handled login at ${currentUrl}. You are now authenticated and back at ${postLoginUrl}.`,
            };
        } catch (err) {
            console.log(`[harness] Login failed: ${err instanceof Error ? err.message : String(err)}\n`);
            return {
                tool: "harness_auto_login",
                args: {},
                result: `Harness failed to handle login at ${currentUrl}: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    };
}

function extractUpvoteIdFromVoteUrl(url: string): string | null {
    const match = url.match(/\/vote\?[^#]*\bid=(\d+)[^#]*\bhow=up\b/);
    return match ? match[1] : null;
}