import type { ApplicationFunction } from 'probot';

export default ((app) => {
	app.log.info('Presta is running');
}) satisfies ApplicationFunction;
