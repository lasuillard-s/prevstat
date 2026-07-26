import serverlessExpress from '@codegenie/serverless-express';
import { createApp } from './app.js';

const app = await createApp();

// @ts-expect-error Library not properly typed
export const handler = serverlessExpress({ app });
