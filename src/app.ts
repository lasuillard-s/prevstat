import { App } from '@octokit/app';

export default {
	// @ts-expect-error Ignore for now
	async fetch(request: Request, env: Record<string, string>) {
		const { APP_ID, WEBHOOK_SECRET, PRIVATE_KEY } = env;

		// @ts-expect-error Ignore for now
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const app = new App({
			appId: APP_ID,
			webhooks: {
				secret: WEBHOOK_SECRET
			},
			privateKey: PRIVATE_KEY
		});

		return new Response(`<h1>Hello, World!</h1>`, { headers: { 'Content-Type': 'text/html' } });
	}
};
