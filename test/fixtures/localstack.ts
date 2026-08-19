import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { CreateQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SSMClient } from '@aws-sdk/client-ssm';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import nock from 'nock';

export interface LocalStackFixture {
	container: StartedLocalStackContainer;
	endpoint: string;
	region: string;
	s3BucketName: string;
	sqsQueueUrl: string;
	s3Client: S3Client;
	sqsClient: SQSClient;
	ssmClient: SSMClient;
	stop: () => Promise<void>;
}

/**
 * Starts a LocalStack container and provisions S3 and SQS resources.
 * @param s3BucketName Name of the S3 bucket to create
 * @param sqsQueueName Name of the SQS queue to create
 * @returns Configured LocalStack test fixture
 */
export async function setupLocalStack(
	s3BucketName = 'test-bucket',
	sqsQueueName = 'test-queue'
): Promise<LocalStackFixture> {
	nock.enableNetConnect();
	const container = await new LocalstackContainer('localstack/localstack:3.8.1').start();
	const endpoint = container.getConnectionUri();
	const region = 'us-east-1';

	const clientConfig = {
		endpoint,
		region,
		credentials: {
			accessKeyId: 'test',
			secretAccessKey: 'test'
		}
	};

	const s3Client = new S3Client({ ...clientConfig, forcePathStyle: true });
	const sqsClient = new SQSClient(clientConfig);
	const ssmClient = new SSMClient(clientConfig);

	await s3Client.send(new CreateBucketCommand({ Bucket: s3BucketName }));
	const createQueueResponse = await sqsClient.send(
		new CreateQueueCommand({ QueueName: sqsQueueName })
	);
	const sqsQueueUrl = createQueueResponse.QueueUrl!;

	return {
		container,
		endpoint,
		region,
		s3BucketName,
		sqsQueueUrl,
		s3Client,
		sqsClient,
		ssmClient,
		stop: async () => {
			await container.stop();
		}
	};
}
