import express, { Request, Response } from 'express';
import type { Probot } from 'probot';
import type { AppConfig } from '../../config.js';
import {
	ArtifactProcessor,
	type BatchItemFailure,
	type SQSEvent,
	type SQSRecord
} from '../../lib/aws/sqs.js';

export const router = express.Router();
export type { BatchItemFailure, SQSEvent, SQSRecord };

router.post('/', async (req: Request<Record<string, string>, unknown, SQSEvent>, res: Response) => {
	const probot = req.app.locals.probot as Probot;
	const config = req.app.locals.config as AppConfig;

	const processor = new ArtifactProcessor(probot, config, req.app.locals.s3Client);

	const batchItemFailures = await processor.processBatch(req.body.Records ?? []);

	res.status(200).json({ batchItemFailures });
});
