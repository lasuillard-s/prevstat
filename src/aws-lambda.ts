import serverlessExpress from '@codegenie/serverless-express';
import { getApp } from './app.js';

const app = await getApp();

// @ts-expect-error Library not properly typed
export const handler = serverlessExpress({ app });
