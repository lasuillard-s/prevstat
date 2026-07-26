import { getApp } from './app.js';

const host: string = process.env.HOST || '0.0.0.0';
const port: number = process.env.PORT ? Number.parseInt(process.env.PORT) : 3000;

const app = await getApp();

app.listen(port, host, () => {
	app.locals.probot.log.info(`Presta is listening on ${host}:${port}`);
});
