import express, { Request, Response } from 'express';
import {
	ArtifactProcessor,
	type BatchItemFailure,
	type SQSEvent,
	type SQSRecord
} from '../../lib/aws/sqs.js';

export const router = express.Router();
export type { BatchItemFailure, SQSEvent, SQSRecord };

router.post('/', async (req: Request<Record<string, string>, unknown, SQSEvent>, res: Response) => {
	const { probot, config, s3Client } = req.app.locals;

	const processor = new ArtifactProcessor(probot, config, s3Client);
	const batchItemFailures = await processor.processBatch(req.body.Records ?? []);

	res.status(200).json({ batchItemFailures });
});
