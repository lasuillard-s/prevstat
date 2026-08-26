import { S3Client } from '@aws-sdk/client-s3';
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

let defaultS3Client: S3Client | undefined;

/**
 * Resolves the S3Client from Express locals or creates a default singleton instance.
 * @param req Express request object
 * @returns S3Client instance
 */
function getS3Client(req: Request<Record<string, string>, unknown, SQSEvent>): S3Client {
	return (req.app.locals.s3Client as S3Client) ?? (defaultS3Client ??= new S3Client({}));
}

router.post('/', async (req: Request<Record<string, string>, unknown, SQSEvent>, res: Response) => {
	const probot = req.app.locals.probot as Probot;
	const config = req.app.locals.config as AppConfig;
	const s3Client = getS3Client(req);

	const processor = new ArtifactProcessor(probot, config, s3Client);
	const batchItemFailures = await processor.processBatch(req.body.Records ?? []);

	res.status(200).json({ batchItemFailures });
});
